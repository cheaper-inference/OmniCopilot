/**
 * Client + shaping for OmniRoute's self-service usage endpoint
 * (`GET /api/usage/om-usage?format=json`), the server half of OmniCopilot #8.
 *
 * The shapes below mirror `UsageCommandJson` in the OmniRoute repo
 * (`src/lib/usage/internalUsageCommand.ts`). They are re-declared here rather
 * than imported because the extension ships standalone — keep the field names
 * aligned with the server when either side changes.
 *
 * When that endpoint refuses (the per-key usage command is off), the key's own
 * usage is read from `GET /v1/me/status` instead (`personalFromSelfStatus`).
 */

import type { Translate } from "./diagnostics";

export interface UsageLimitStatus {
  enabled: boolean;
  dailyLimitUsd: number | null;
  weeklyLimitUsd: number | null;
  dailySpentUsd: number;
  weeklySpentUsd: number;
  dailyResetAtIso: string | null;
  weeklyResetAtIso: string | null;
  dailyExceeded: boolean;
  weeklyExceeded: boolean;
}

export interface UsageQuotaWindow {
  used?: number;
  total?: number;
  usedPercentage?: number;
  /** A percentage for some providers, a currency balance or an absolute count
   * for others — never read it on its own without the rules in
   * `quotaRemainingPercent`. */
  remaining?: number;
  remainingPercentage?: number;
  unlimited?: boolean;
  currency?: string;
  displayName?: string;
  resetAt?: string | null;
}

export interface UsageSnapshot {
  connectionId: string;
  provider: string;
  plan?: unknown;
  quotas?: Record<string, UsageQuotaWindow>;
}

/** A quota window with everything the webview prints already resolved on the
 * host: the script does no arithmetic and no formatting of its own. */
export type UsageQuotaView = UsageQuotaWindow & {
  /** Width of the bar (0-100); null draws no bar. */
  percentLeft: number | null;
  /** Formatted amount left on a money quota ("$12.50", "12.5 EUR"), else null. */
  balance: string | null;
  unlimited: boolean;
  resetIn: string | null;
  /** What is left, localised: "$0.37 left", "62% left", "unlimited" or "—". */
  text: string;
  /** The server's `displayName` when it sends one, else the window key. */
  label: string;
};

export type UsageLimitView = UsageLimitStatus & {
  dailyPercentLeft: number | null;
  weeklyPercentLeft: number | null;
  dailyResetIn: string | null;
  weeklyResetIn: string | null;
  /** "$1.20 / $5.00 (76% left)" (the share only when it is known); the spend
   * alone ("$1.20") for a window without a limit; "" when there is nothing to
   * show, which hides the row. */
  dailyText: string;
  weeklyText: string;
};

export type UsageSnapshotView = Omit<UsageSnapshot, "quotas"> & {
  quotas?: Record<string, UsageQuotaView>;
};

/** Refusals carry only an error; success carries the data. A panel must never
 * read a data field off a refusal — hence the discriminated union. */
export type UsageResponse =
  | { allowed: false; error?: { message?: string } }
  | {
      allowed: true;
      personal: UsageLimitStatus | null;
      provider: UsageSnapshot | null;
      /** Every connection's snapshot (#11191); absent on servers that predate it. */
      providers?: UsageSnapshot[];
    };

/** What the panel actually renders — the three reachable states, resolved.
 * "unsupported" is a server too old for ?format=json (it answered text), which
 * must hide the section rather than show a parser error. */
export type UsageView =
  | { kind: "unsupported" }
  | { kind: "disabled"; message?: string }
  | { kind: "ready"; personal: UsageLimitView | null; providers: UsageSnapshotView[] };

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? USD.format(value) : "—";
}

/** "resets in 2d 4h" / "resets in 3h 12m" / "unknown" — mirrors the server's
 * formatResetIn so the panel reads like the terminal command. */
export function formatResetIn(resetAtIso: string | null | undefined, now = Date.now()): string {
  if (!resetAtIso) return "unknown";
  const ms = Date.parse(resetAtIso);
  if (!Number.isFinite(ms)) return "unknown";
  const diff = ms - now;
  if (diff <= 0) return "now";
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** The countdown for a panel row, or null when there is nothing worth saying:
 * the reset time is unknown or has already passed. */
export function resetLabel(resetAtIso: string | null | undefined, now = Date.now()): string | null {
  const label = formatResetIn(resetAtIso, now);
  return label === "unknown" || label === "now" ? null : label;
}

/** Percent of the limit still available, for the personal USD rows. */
export function percentLeft(spent: number, limit: number | null): number | null {
  const exact = exactPercentLeft(spent, limit);
  return exact === null ? null : Math.round(exact);
}

/** The share of the limit still available, unrounded and clamped to 0-100.
 * `percentLeft` rounds it once for every place that shows it (panel, tooltip and
 * status bar alike). */
export function exactPercentLeft(spent: number, limit: number | null): number | null {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, (1 - spent / limit) * 100));
}

/** Fills `{0}`-style placeholders without translating: the default for tests. */
const untranslated: Translate = (source, ...args) =>
  source.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : match
  );

/** "$1.20 / $5.00 (76% left)" for a personal limit row; the spend alone when the
 * window has no limit, and "" when it has neither a limit nor any spend. */
function limitText(spent: number, limit: number | null, left: number | null, t: Translate): string {
  if (limit === null) return spent > 0 ? formatUsd(spent) : "";
  const share = left === null ? "" : ` (${t("{0}% left", left)})`;
  return `${formatUsd(spent)} / ${formatUsd(limit)}${share}`;
}

/** The panel's daily line as one sentence ("Daily: $1.20 / $5.00 (76% left) ·
 * resets in 3h 0m"), for the status-bar tooltip. Null without a daily limit. */
export function dailyUsageLine(personal: UsageLimitView, t: Translate = untranslated): string | null {
  if (personal.dailyLimitUsd === null || !personal.dailyText) return null;
  const reset = personal.dailyResetIn ? ` · ${t("resets in {0}", personal.dailyResetIn)}` : "";
  return `${t("Daily")}: ${personal.dailyText}${reset}`;
}

/** The text of a quota row: a money balance wins over `unlimited` and over a
 * percentage, and so does a balance that cannot be printed (negative, or too large),
 * which reads as a dash; otherwise unlimited, then a known percentage, then a dash. */
function quotaText(
  balance: string | null,
  unprintableBalance: boolean,
  unlimited: boolean,
  left: number | null,
  t: Translate
): string {
  if (balance !== null) return t("{0} left", balance);
  if (unprintableBalance) return "—";
  if (unlimited) return t("unlimited");
  if (left !== null) return t("{0}% left", left);
  return "—";
}

function quotaView(name: string, quota: UsageQuotaWindow, now: number, t: Translate): UsageQuotaView {
  const balance = quotaBalance(quota);
  const unlimited = quota.unlimited === true;
  const computed = quotaRemainingPercent(quota);
  // A row that reads "unlimited" draws no bar.
  const left = balance === null && unlimited ? null : computed;
  const displayName = typeof quota.displayName === "string" ? quota.displayName.trim() : "";
  return {
    ...quota,
    percentLeft: left,
    balance,
    unlimited,
    resetIn: resetLabel(quota.resetAt, now),
    text: quotaText(balance, hasUnprintableBalance(quota), unlimited, left, t),
    label: displayName || name,
  };
}

/** Resolve the raw response into the panel's three states. Centralises the
 * "older servers answer text" fallback and the providers/provider merge, and
 * every text the panel prints (`t` localises it). */
export function toUsageView(
  body: UsageResponse,
  now = Date.now(),
  t: Translate = untranslated
): UsageView {
  if (body.allowed === false) return { kind: "disabled", message: body.error?.message };
  const snapshots = Array.isArray(body.providers)
    ? body.providers
    : body.provider
      ? [body.provider]
      : [];
  const personal: UsageLimitView | null = body.personal
    ? (() => {
        const p = body.personal;
        const dailyPercentLeft = percentLeft(p.dailySpentUsd, p.dailyLimitUsd);
        const weeklyPercentLeft = percentLeft(p.weeklySpentUsd, p.weeklyLimitUsd);
        return {
          ...p,
          dailyPercentLeft,
          weeklyPercentLeft,
          dailyResetIn: resetLabel(p.dailyResetAtIso, now),
          weeklyResetIn: resetLabel(p.weeklyResetAtIso, now),
          dailyText: limitText(p.dailySpentUsd, p.dailyLimitUsd, dailyPercentLeft, t),
          weeklyText: limitText(p.weeklySpentUsd, p.weeklyLimitUsd, weeklyPercentLeft, t),
        };
      })()
    : null;
  const providers: UsageSnapshotView[] = snapshots.map((snapshot) => ({
    ...snapshot,
    quotas: snapshot.quotas
      ? Object.fromEntries(
          Object.entries(snapshot.quotas)
            // A window that is not an object is skipped rather than hiding the section.
            .filter(([, quota]) => typeof quota === "object" && quota !== null)
            .map(([name, quota]) => [name, quotaView(name, quota, now, t)])
        )
      : undefined,
  }));
  return { kind: "ready", personal, providers };
}

/** The usage endpoint cannot be read right now (an unreachable server, a time-out,
 * a 5xx, a proxy answering in the server's place, a body that is not the expected
 * JSON): a failure to try again, not an answer about the key. */
export class UsageReadError extends Error {}

/** Thrown for a server that answered text — an OmniRoute that predates
 * ?format=json — so the caller hides the section instead of surfacing a parse
 * failure. */
export class UsageUnsupportedError extends Error {}

const usageRoot = (baseUrl: string): string => baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");

/** GET the key's own status (`/v1/me/status`), which any key with the
 * self-service scope may read. Never throws. `none` is an answer: the key cannot
 * read it (401, 403, 404 on an older server, any other 4xx) or has nothing to
 * report. `failed` is not: a network error, a time-out, a 5xx, a body that is not
 * a JSON object. The panel treats both as "not enabled"; the status bar keeps
 * its last number through a failure. */
async function fetchSelfStatus(
  root: string,
  apiKey: string,
  timeoutMs: number
): Promise<{ kind: "ok"; personal: UsageLimitStatus } | { kind: "none" } | { kind: "failed" }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${root}/v1/me/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (res.status >= 500) return { kind: "failed" };
    if (!res.ok) return { kind: "none" };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { kind: "failed" };
    const personal = personalFromSelfStatus(body);
    return personal ? { kind: "ok", personal } : { kind: "none" };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** The view, and whether the key's own status could not be read after the
 * usage command refused (so a caller that must tell a failure from "not
 * enabled" can). */
async function loadUsage(
  baseUrl: string,
  apiKey: string | undefined,
  t: Translate,
  timeoutMs: number
): Promise<{ view: UsageView; selfStatusFailed: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const root = usageRoot(baseUrl);
  let body: UsageResponse;
  try {
    const res = await fetch(`${root}/api/usage/om-usage?format=json`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (res.status >= 500) throw new UsageReadError(`usage endpoint answered ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      // Plain text, or a 4xx page: an OmniRoute that predates ?format=json. A 2xx
      // page of another kind is not the server's answer at all.
      if (res.ok && !contentType.includes("text/plain")) {
        throw new UsageReadError("the usage endpoint did not answer JSON");
      }
      throw new UsageUnsupportedError("server predates ?format=json");
    }
    const parsed: unknown = await res.json();
    // Every answer of the usage command, a refusal included, says `allowed`. A body
    // without it (an error object, another kind of server) is not that command's answer.
    if (!isRecord(parsed) || typeof parsed.allowed !== "boolean") {
      throw new UsageReadError("the usage endpoint answered an unexpected body");
    }
    body = parsed as unknown as UsageResponse;
  } finally {
    clearTimeout(timer);
  }
  if (body.allowed === false && apiKey) {
    // The per-key usage command is off: the key can still read its own numbers.
    const own = await fetchSelfStatus(root, apiKey, timeoutMs);
    if (own.kind === "ok") {
      const view = toUsageView({ allowed: true, personal: own.personal, provider: null }, Date.now(), t);
      return { view, selfStatusFailed: false };
    }
    return { view: toUsageView(body, Date.now(), t), selfStatusFailed: own.kind === "failed" };
  }
  return { view: toUsageView(body, Date.now(), t), selfStatusFailed: false };
}

/** The usage view for the panel. Throws `UsageUnsupportedError` for a server
 * that predates ?format=json, and anything else when the endpoint cannot be read. */
export async function fetchUsage(
  baseUrl: string,
  apiKey: string | undefined,
  t: Translate = untranslated,
  timeoutMs = 6000
): Promise<UsageView> {
  return (await loadUsage(baseUrl, apiKey, t, timeoutMs)).view;
}

/** The key's personal view alone, for callers that do not draw the panel (the
 * status bar). Null is an answer: usage is not available for the key (not
 * enabled, a refusal from the self-service call, a server that predates
 * ?format=json) or the key has no limits and no spend. Throws when the read
 * failed: an unreachable server, a time-out, a 5xx on either call, a proxy
 * answering in the server's place, a body that is not the expected JSON. */
export async function fetchPersonalUsage(
  baseUrl: string,
  apiKey: string | undefined,
  t: Translate = untranslated,
  timeoutMs = 6000
): Promise<UsageLimitView | null> {
  try {
    const { view, selfStatusFailed } = await loadUsage(baseUrl, apiKey, t, timeoutMs);
    if (selfStatusFailed) throw new UsageReadError("the key's own status could not be read");
    return view.kind === "ready" ? view.personal : null;
  } catch (err) {
    if (err instanceof UsageUnsupportedError) return null;
    throw err;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A money amount only counts when it is finite and not negative. */
const amount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

interface WindowReading {
  limit: number | null;
  spent: number | null;
  resetAt: string | null;
  exceeded: boolean;
  /** Something real was read, so the window is worth a row. */
  known: boolean;
}

/** One window (`daily` / `weekly`) of a `/v1/me/status` body: the
 * `usage_limit:<window>` entry gives the limit; the totals under `usage.<window>`
 * stand in for what the entry does not give (all of it, when there is no entry). */
function readWindow(body: Record<string, unknown>, window: "daily" | "weekly"): WindowReading {
  const entries = Array.isArray(body.limits) ? body.limits : [];
  const entry = entries.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      candidate.id === `usage_limit:${window}` &&
      (amount(candidate.limit) ?? 0) > 0 // the server never emits a limit of zero: that is no limit
  );
  const totals = isRecord(body.usage) && isRecord(body.usage[window]) ? body.usage[window] : {};
  const spent = amount(entry?.used) ?? amount(totals.costUsd);
  return {
    limit: entry ? amount(entry.limit) : null,
    spent,
    resetAt: text(entry?.resetAt) ?? text(totals.resetAt),
    exceeded: entry?.exceeded === true,
    known: entry !== undefined || spent !== null,
  };
}

/** Map a `GET /v1/me/status` body (OmniRoute `buildApiKeySelfServiceStatus`) to
 * the personal shape the panel already draws. Null when the body is not an
 * object or has neither a usage limit nor usage totals. Provider quotas
 * (`accountQuotas`) are not read: they need another scope. */
export function personalFromSelfStatus(body: unknown): UsageLimitStatus | null {
  if (!isRecord(body)) return null;
  const daily = readWindow(body, "daily");
  const weekly = readWindow(body, "weekly");
  if (!daily.known && !weekly.known) return null;
  return {
    enabled: daily.limit !== null || weekly.limit !== null,
    dailyLimitUsd: daily.limit,
    dailySpentUsd: daily.spent ?? 0,
    dailyResetAtIso: daily.resetAt,
    dailyExceeded: daily.exceeded,
    weeklyLimitUsd: weekly.limit,
    weeklySpentUsd: weekly.spent ?? 0,
    weeklyResetAtIso: weekly.resetAt,
    weeklyExceeded: weekly.exceeded,
  };
}

/** Same coercion as the server's `toNumber`: finite numbers and numeric
 * strings count, everything else is "absent". */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

/** A window carrying a non-empty `currency` measures money, not a share. */
const isMoneyQuota = (q: UsageQuotaWindow): q is UsageQuotaWindow & { currency: string } =>
  typeof q.currency === "string" && q.currency.trim() !== "";

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

/** Percentage of a quota window still available, or null when unknowable.
 *
 * Mirrors the server's `getQuotaUsedPercent`
 * (OmniRoute `src/lib/usage/internalUsageCommand.ts`), in the same order, then
 * converts "used" to "left". The unit of `remaining` is not fixed — a
 * percentage, a currency balance or an absolute count depending on the
 * provider — so it only counts when it already sits between 0 and 100; so
 * does `used`. Anything else is null rather than a guess.
 *
 * One deliberate difference from the server: a window with a `currency` is a
 * money quota. Its text is the balance (`quotaBalance`); the percentage only
 * sizes a bar, and only when `total` is positive (from `used`/`total`, else from
 * `remainingPercentage`). Servers send `total: 0` with `remainingPercentage: 100`
 * for a prepaid balance, which says nothing about how much is left. */
export function quotaRemainingPercent(q: UsageQuotaWindow): number | null {
  if (isMoneyQuota(q)) {
    const total = toNumber(q.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    const spent = toNumber(q.used);
    if (Number.isFinite(spent)) return Math.round(clampPercent(100 - (spent / total) * 100));
    const remainingPercentage = toNumber(q.remainingPercentage);
    return Number.isFinite(remainingPercentage) ? Math.round(clampPercent(remainingPercentage)) : null;
  }
  const used = ((): number | null => {
    const usedPercentage = toNumber(q.usedPercentage);
    if (Number.isFinite(usedPercentage)) return clampPercent(usedPercentage);

    const spent = toNumber(q.used);
    const total = toNumber(q.total);
    if (Number.isFinite(spent) && Number.isFinite(total) && total > 0) {
      return clampPercent((spent / total) * 100);
    }
    if (Number.isFinite(spent) && spent >= 0 && spent <= 100) return spent;

    const remainingPercentage = toNumber(q.remainingPercentage);
    if (Number.isFinite(remainingPercentage)) return clampPercent(100 - remainingPercentage);

    const remaining = toNumber(q.remaining);
    if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) {
      return clampPercent(100 - remaining);
    }
    return null;
  })();
  return used === null ? null : Math.round(clampPercent(100 - used));
}

/** From this amount on, JavaScript prints a number with an exponent ("1e+21"). */
const MAX_PRINTABLE_AMOUNT = 1e21;

/** A money quota whose `remaining` is a number that cannot be shown as a balance: a
 * negative one (no existing wording says "owed"), or one that would print with an
 * exponent. Its line reads "—" rather than falling back to a share. */
function hasUnprintableBalance(q: UsageQuotaWindow): boolean {
  if (!isMoneyQuota(q)) return false;
  const remaining = toNumber(q.remaining);
  return Number.isFinite(remaining) && (remaining < 0 || remaining >= MAX_PRINTABLE_AMOUNT);
}

/** The amount left on a money quota, formatted for display: "$12.50" for USD,
 * "12.5 EUR" for anything else. Null for a window without a currency, without a
 * finite, non-negative `remaining`, or with one too large to print without an
 * exponent. */
export function quotaBalance(q: UsageQuotaWindow): string | null {
  if (!isMoneyQuota(q)) return null;
  const remaining = toNumber(q.remaining);
  if (!Number.isFinite(remaining) || remaining < 0 || remaining >= MAX_PRINTABLE_AMOUNT) return null;
  const code = q.currency.trim().toUpperCase();
  if (code === "USD") return formatUsd(remaining);
  return `${Math.round(remaining * 100) / 100} ${code}`;
}

/** Mime type VS Code's Copilot Chat reads from a language-model response to
 * feed the Context Window widget. Without it the widget shows 0 tokens. */
export const USAGE_MIME_TYPE = "usage";

export interface TokenUsagePayload {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

/** Builds the payload to report once a response ends. Uses the server's numbers
 * when present; otherwise falls back to a ~4 chars/token estimate so the widget
 * is approximately right instead of stuck at 0. */
export function buildUsagePayload(
  usage: import("./types").StreamUsage | null,
  fallback: { promptChars: number; completionChars: number }
): { payload: TokenUsagePayload; estimated: boolean } {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const p = num(usage?.prompt_tokens) ?? num(usage?.input_tokens);
  const c = num(usage?.completion_tokens) ?? num(usage?.output_tokens);
  const prompt = p ?? Math.ceil(fallback.promptChars / 4);
  const completion = c ?? Math.ceil(fallback.completionChars / 4);
  return {
    estimated: p === null || c === null,
    payload: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: num(usage?.prompt_tokens_details?.cached_tokens) ?? 0 },
    },
  };
}
