import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { OmniRouteClient, serverRootUrl } from "./client";
import { describeProbeFailure, keyWithheldMessage, type Connection } from "./connection";
import type { ProbeResult } from "./diagnostics";
import { dailyUsageLine, type UsageLimitView } from "./usage";

const PROBE_TIMEOUT_MS = 4000;
/** The usage numbers are read at most this often, whoever asks. */
const USAGE_MIN_INTERVAL_MS = 5 * 60_000;

type Status = "online" | "offline" | "checking";

/** The status after a check, calling `notify` only when it actually changed. */
export function applyStatus(
  current: Status,
  next: "online" | "offline",
  notify?: (status: "online" | "offline") => void
): Status {
  if (next !== current) notify?.(next);
  return next;
}

/**
 * Whether the model picker should be listed again, decided from one poll to the
 * next: when this poll was accepted (a 2xx probe) and the previous one was not,
 * or there was none. A 401/403 probe means "the server is there" but the listing
 * would be refused too. Status changes reported by finished requests play no
 * part, so a refused listing cannot start a refresh loop.
 */
export function shouldRefreshModels(args: {
  previousPollOk: boolean | undefined;
  pollOk: boolean;
}): boolean {
  return args.pollOk && args.previousPollOk !== true;
}

/**
 * Icon and theme colours of the status-bar item. An online server that does not
 * get the stored key (withheld for another origin) is not shown as green: the
 * probe succeeds without a key, but chat and the model list would be refused.
 */
export function statusPresentation(args: { status: Status; keyWithheld: boolean }): {
  text: string;
  color: string | undefined;
  background: string | undefined;
} {
  switch (args.status) {
    case "online":
      return args.keyWithheld
        ? {
            text: "$(warning) OmniRoute",
            color: undefined,
            background: "statusBarItem.warningBackground",
          }
        : { text: "$(circle-filled) OmniRoute", color: "testing.iconPassed", background: undefined };
    case "offline":
      return {
        text: "$(circle-outline) OmniRoute",
        color: undefined,
        background: "statusBarItem.warningBackground",
      };
    default:
      return { text: "$(sync~spin) OmniRoute", color: undefined, background: undefined };
  }
}

/**
 * The text appended to the status for the key's daily limit: " · 76%", the share
 * of it left. It is given the whole number the daily line shows; a fraction would be
 * rounded down. Empty without the setting, on a server that is not online, with a
 * withheld key, or when the key has no daily limit.
 */
export function statusBarUsageSuffix(args: {
  enabled: boolean;
  online: boolean;
  keyWithheld: boolean;
  dailyPercentLeft: number | null;
}): string {
  const left = args.dailyPercentLeft;
  if (!args.enabled || !args.online || args.keyWithheld) return "";
  if (typeof left !== "number" || !Number.isFinite(left)) return "";
  // A tiny epsilon keeps a share that is 57% in decimal from reading 56 in binary.
  return ` · ${Math.max(0, Math.min(100, Math.floor(left + 1e-9)))}%`;
}

/** Whether the usage numbers may be read again: nothing was tried yet, the
 * minimum interval has passed since the last attempt, or the clock went back. */
export function shouldRefreshUsage(args: {
  now: number;
  lastAttemptAt: number | undefined;
  minIntervalMs: number;
}): boolean {
  if (args.lastAttemptAt === undefined || args.now < args.lastAttemptAt) return true;
  return args.now - args.lastAttemptAt >= args.minIntervalMs;
}

/** What the status bar remembers of the key's daily limit between two readings. */
export interface UsageSample {
  /** Share of the daily limit left (0-100): the whole number the daily line shows. */
  percentLeft: number;
  /** The tooltip line, already worded. */
  line: string;
  /** Failed refreshes in a row since the last good reading. */
  failures: number;
}

export type UsageReading =
  | { kind: "read"; percentLeft: number; line: string }
  | { kind: "none" }
  | { kind: "failed" };

/**
 * The sample after a refresh. A reading replaces it; "none" (usage not enabled,
 * or no daily limit) clears it, as that is the real state; a failed refresh keeps
 * the last number for one more interval and the second one in a row drops it.
 */
export function nextUsageSample(
  previous: UsageSample | undefined,
  reading: UsageReading
): UsageSample | undefined {
  switch (reading.kind) {
    case "read":
      return { percentLeft: reading.percentLeft, line: reading.line, failures: 0 };
    case "none":
      return undefined;
    default:
      return previous && previous.failures < 1
        ? { ...previous, failures: previous.failures + 1 }
        : undefined;
  }
}

/**
 * What a usage reading was read for: the server, which stored key is in effect
 * and a SHA-256 of the key itself (the key is never kept). Held in memory only,
 * never logged. Two connections with the same fingerprint get the same numbers.
 */
export function connectionFingerprint(connection: Connection): string {
  const keyHash = createHash("sha256")
    .update(connection.apiKey ?? "")
    .digest("hex");
  return `${connection.origin}|${connection.keyScope}|${keyHash}`;
}

/** Status-bar "dot": green when the OmniRoute server answers the HEAD
 * /v1/models probe, red when it does not. Click → quick actions menu. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: Status = "checking";
  private disposed = false;
  private lastFailure: string | undefined;
  private keyNote: string | undefined;
  private keyWithheld = false;
  /** Root of the server the last poll went to (from the resolved connection). */
  private root = "";
  /** Whether the last poll was accepted (2xx); undefined before the first poll. */
  private lastPollOk: boolean | undefined;
  /** The last reading of the key's daily limit, if one is still worth showing. */
  private usageSample: UsageSample | undefined;
  private lastUsageAttemptAt: number | undefined;
  /** Generation of the read now out, if any: a read of an older generation never blocks. */
  private usageInFlightGeneration: number | undefined;
  /** Bumped when the key, the server or the setting changed, so a reading that began
   * before is neither applied nor counted after it. */
  private usageGeneration = 0;
  /** Fingerprint of the connection the sample (and the floor) belong to. */
  private usageFingerprint: string | undefined;
  /** Bumped when the connection changed (`restart`, or a poll that resolved another key or
   * server), so a poll that began before is abandoned: it applies nothing and reads nothing. */
  private connectionGeneration = 0;
  /** Chat activity may have outlived a key change: the sample is not drawn until the read
   * that follows has resolved the connection and compared it. */
  private usageUnverified = false;

  constructor(
    private readonly getClient: () => Promise<OmniRouteClient>,
    private readonly log: vscode.LogOutputChannel,
    private readonly onStatusChange?: (status: "online" | "offline") => void,
    private readonly getConnection?: () => Promise<Connection>,
    /** Called when a poll found the server accepting requests again (see `shouldRefreshModels`);
     * `firstPoll` when no poll had finished before this one. */
    private readonly onModelsReachable?: (firstPoll: boolean) => void,
    /** Reads the key's own usage for the connection a poll resolved (see `statusBarUsageSuffix`). */
    private readonly fetchPersonalUsage?: (connection: Connection) => Promise<UsageLimitView | null>
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "OmniRoute";
    this.item.command = "omnicopilot.quickActions";
    this.render();
  }

  start(): void {
    this.applyVisibility();
    this.scheduleLoop();
    this.pollInBackground();
  }

  /** Feed request outcomes from the provider so the dot reacts instantly. */
  reportActivity(ok: boolean): void {
    if (ok) this.lastFailure = undefined;
    const next = ok ? "online" : "offline";
    // A request outlives nothing but the connection it began with: until the usage read
    // that follows has compared the connection in effect, a draw must not show the number.
    if (ok && this.usageSample && this.fetchPersonalUsage && this.getConnection) {
      this.usageUnverified = true;
    }
    // An unchanged status has nothing new to draw.
    if (next !== this.status || !ok) this.setStatus(next);
    if (ok) this.refreshUsageIfDue();
  }

  /** Why the last check failed, in one sentence; undefined while the server answers. */
  get failureSummary(): string | undefined {
    return this.status === "offline" ? this.lastFailure : undefined;
  }

  /**
   * One poll. `rechecks` is for a caller that reports the result ("Check connection"):
   * when the connection changed while the probe ran, the stale result is not reported
   * and the check runs again for the connection in effect, up to that many more times.
   * A background poll passes none: the restart that changed the connection polls itself.
   */
  async checkNow(options: { rechecks?: number } = {}): Promise<boolean> {
    // A poll is one generation from start to finish: once the connection changed under
    // it, nothing it resolved or measured is applied, and it starts no usage read.
    let generation = this.connectionGeneration;
    const client = await this.getClient();
    if (generation !== this.connectionGeneration) return this.checkNow(options);
    const connection = await this.getConnection?.();
    if (generation !== this.connectionGeneration) return this.checkNow(options);
    this.root = serverRootUrl(client.baseUrl);
    // Before anything is drawn: a number read for another key or server goes at once.
    if (connection && this.adoptUsageConnection(connection)) generation = this.connectionGeneration;
    this.keyNote = connection ? keyWithheldMessage(connection) : undefined;
    this.keyWithheld = connection?.keyWithheld ?? false;
    const result: ProbeResult = await client.probe(PROBE_TIMEOUT_MS);
    if (generation !== this.connectionGeneration) {
      const rechecks = options.rechecks ?? 0;
      return rechecks > 0 ? this.checkNow({ rechecks: rechecks - 1 }) : result.ok;
    }
    this.lastFailure = result.ok
      ? undefined
      : describeProbeFailure(client.baseUrl, result, PROBE_TIMEOUT_MS).summary;
    this.setStatus(result.ok ? "online" : "offline");
    // The usage read resolves the connection again: the one captured before the probe may be old.
    if (result.ok) this.refreshUsageIfDue();
    const pollOk = result.ok && result.status >= 200 && result.status < 300;
    const previousPollOk = this.lastPollOk;
    this.lastPollOk = pollOk;
    if (shouldRefreshModels({ previousPollOk, pollOk })) this.onModelsReachable?.(previousPollOk === undefined);
    return result.ok;
  }

  /** Start over after a change: any poll that began before is stale. A changed key or
   * server also makes the last usage reading worthless; `keepUsage` is for a change
   * that leaves the reading and its 5-minute floor alone (a setting it does not show). */
  restart(options: { keepUsage?: boolean } = {}): void {
    this.connectionGeneration++;
    if (!options.keepUsage) this.dropUsage();
    this.applyVisibility();
    this.scheduleLoop();
    this.pollInBackground();
    this.render();
  }

  /**
   * For a refresh that was skipped because the settled connection is the one already
   * refreshed for: a poll that landed between another window's secret writes may show a
   * withheld key the settled connection does not have (or the other way round). Then poll
   * again at once, keeping the usage reading and its floor; otherwise do nothing.
   */
  recheckIfWithheldDiffers(connection: Connection): void {
    if (this.disposed || connection.keyWithheld === this.keyWithheld) return;
    this.restart({ keepUsage: true });
  }

  /** Forget the number and the floor, and make any read still out harmless. */
  private dropUsage(): void {
    this.usageGeneration++;
    this.usageSample = undefined;
    this.lastUsageAttemptAt = undefined;
    this.usageFingerprint = undefined;
    this.usageUnverified = false;
  }

  /** Tie the sample to the connection in effect: when another key or server is in
   * effect, the sample goes and the next read is not held back by the floor.
   * Returns whether it dropped something. */
  private adoptUsageConnection(connection: Connection): boolean {
    const fingerprint = connectionFingerprint(connection);
    const changed = this.usageFingerprint !== undefined && this.usageFingerprint !== fingerprint;
    if (changed) {
      this.connectionGeneration++;
      this.dropUsage();
    }
    this.usageFingerprint = fingerprint;
    return changed;
  }

  private applyVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("omnicopilot").get<boolean>("statusBar", true);
    if (enabled) this.item.show();
    else this.item.hide();
  }

  private scheduleLoop(): void {
    if (this.timer) clearInterval(this.timer);
    const seconds = vscode.workspace
      .getConfiguration("omnicopilot")
      .get<number>("healthCheckIntervalSeconds", 30);
    this.timer = setInterval(() => this.pollInBackground(), Math.max(seconds, 5) * 1000);
  }

  /** A poll nobody waits for: log a failure instead of leaving it unhandled. */
  private pollInBackground(): void {
    this.checkNow().catch((err: unknown) => this.log.warn(`Connection check failed: ${String(err)}`));
  }

  /** The number is shown: the item is visible and the usage setting is on. A hidden
   * status bar reads nothing. */
  private usageEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("omnicopilot");
    return config.get<boolean>("statusBar", true) && config.get<boolean>("statusBarUsage", true);
  }

  /** Read the key's usage when the setting is on, a key is in effect and the minimum
   * interval has passed. Nothing waits for it; the status bar redraws when it lands.
   * The connection is resolved here, at the moment of the read, never reused from an
   * earlier step. */
  private refreshUsageIfDue(): void {
    if (this.disposed || !this.fetchPersonalUsage || !this.getConnection) return;
    if (!this.usageEnabled()) {
      // Off: forget the number, so turning it on again reads at once.
      if (this.usageSample || this.lastUsageAttemptAt !== undefined) this.dropUsage();
      return;
    }
    const generation = this.usageGeneration;
    void this.readUsage(generation)
      .catch((err: unknown) => this.log.warn(`Usage refresh failed: ${String(err)}`))
      .finally(() => {
        // Whatever ended the read, the number is not held back as "unverified" for good.
        if (this.usageUnverified && generation === this.usageGeneration) {
          this.usageUnverified = false;
          this.render();
        }
      });
  }

  private async readUsage(generation: number): Promise<void> {
    const connection = await this.getConnection!();
    // Anything that changed while the connection was being resolved wins over this read.
    if (this.disposed || generation !== this.usageGeneration) return;
    const changed = this.adoptUsageConnection(connection);
    if (changed || this.usageUnverified) {
      this.usageUnverified = false;
      this.render();
    }
    const current = this.usageGeneration;
    if (this.usageInFlightGeneration === current) return;
    const now = Date.now();
    if (!shouldRefreshUsage({ now, lastAttemptAt: this.lastUsageAttemptAt, minIntervalMs: USAGE_MIN_INTERVAL_MS })) {
      return;
    }
    this.usageInFlightGeneration = current;
    try {
      let reading: UsageReading;
      if (!connection.apiKey || connection.keyWithheld) {
        // No key in effect: nothing to ask, and no floor to wait out once one is stored.
        reading = { kind: "none" };
      } else {
        this.lastUsageAttemptAt = now;
        try {
          const personal = await this.fetchPersonalUsage!(connection);
          // The panel's rounding, so the number next to the status is the one in the daily line.
          const percentLeft = personal ? personal.dailyPercentLeft : null;
          const line = personal ? dailyUsageLine(personal, vscode.l10n.t) : null;
          reading =
            personal && percentLeft !== null && line !== null
              ? { kind: "read", percentLeft, line }
              : { kind: "none" };
        } catch (err) {
          this.log.debug(`Usage refresh failed: ${String(err)}`);
          reading = { kind: "failed" };
        }
      }
      if (this.disposed || current !== this.usageGeneration) return;
      this.usageSample = nextUsageSample(this.usageSample, reading);
      this.render();
    } finally {
      if (this.usageInFlightGeneration === current) this.usageInFlightGeneration = undefined;
    }
  }

  private setStatus(status: "online" | "offline"): void {
    if (this.disposed) return;
    this.status = applyStatus(this.status, status, (s) => {
      this.log.info(`OmniRoute connection: ${s}`);
      this.onStatusChange?.(s);
    });
    this.render();
  }

  private render(): void {
    const root = this.root;
    const look = statusPresentation({ status: this.status, keyWithheld: this.keyWithheld });
    const suffix = statusBarUsageSuffix({
      enabled: this.usageEnabled(),
      online: this.status === "online",
      keyWithheld: this.keyWithheld,
      dailyPercentLeft: this.usageUnverified ? null : (this.usageSample?.percentLeft ?? null),
    });
    this.item.text = look.text + suffix;
    this.item.color = look.color ? new vscode.ThemeColor(look.color) : undefined;
    this.item.backgroundColor = look.background ? new vscode.ThemeColor(look.background) : undefined;
    switch (this.status) {
      case "online":
        this.item.tooltip = this.tooltip(
          vscode.l10n.t("OmniRoute online — {0}. Click for actions.", root),
          suffix ? this.usageSample?.line : undefined
        );
        break;
      case "offline":
        this.item.tooltip = this.tooltip(
          vscode.l10n.t("OmniRoute unreachable — {0}. Click for actions.", root),
          this.lastFailure
        );
        break;
      default:
        this.item.tooltip = vscode.l10n.t("Checking OmniRoute connection…");
    }
  }

  private tooltip(...lines: Array<string | undefined>): string {
    return [...lines, this.keyNote].filter((line): line is string => Boolean(line)).join("\n");
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}
