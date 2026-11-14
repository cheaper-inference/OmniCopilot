import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { OmniRouteClient } from "../src/client";
import type { Connection } from "../src/connection";
import type { ProbeResult } from "../src/diagnostics";
import { setMockConfig } from "./vscode.mock";
import { fetchPersonalUsage, toUsageView } from "../src/usage";
import type { UsageLimitView } from "../src/usage";
import {
  ConnectionStatusBar,
  applyStatus,
  connectionFingerprint,
  nextUsageSample,
  shouldRefreshModels,
  shouldRefreshUsage,
  statusBarUsageSuffix,
  statusPresentation,
} from "../src/statusBar";

describe("applyStatus", () => {
  it("notifies only when the status actually changes", () => {
    const notify = vi.fn();
    let status = applyStatus("checking", "offline", notify);
    expect(status).toBe("offline");
    status = applyStatus(status, "offline", notify);
    expect(status).toBe("offline");
    expect(notify).toHaveBeenCalledTimes(1);

    status = applyStatus(status, "online", notify);
    status = applyStatus(status, "online", notify);
    expect(status).toBe("online");
    expect(notify.mock.calls).toEqual([["offline"], ["online"]]);
  });

  it("works without a listener", () => {
    expect(applyStatus("online", "offline")).toBe("offline");
  });
});

describe("shouldRefreshModels", () => {
  it("refreshes after the first accepted poll", () => {
    expect(shouldRefreshModels({ previousPollOk: undefined, pollOk: true })).toBe(true);
  });

  it("does not refresh after an accepted poll that followed an accepted poll", () => {
    expect(shouldRefreshModels({ previousPollOk: true, pollOk: true })).toBe(false);
  });

  it("refreshes after an accepted poll that followed a failed or 401/403 poll", () => {
    expect(shouldRefreshModels({ previousPollOk: false, pollOk: true })).toBe(true);
  });

  it("does not refresh on a poll that was not accepted", () => {
    expect(shouldRefreshModels({ previousPollOk: undefined, pollOk: false })).toBe(false);
    expect(shouldRefreshModels({ previousPollOk: true, pollOk: false })).toBe(false);
    expect(shouldRefreshModels({ previousPollOk: false, pollOk: false })).toBe(false);
  });
});

describe("ConnectionStatusBar model refill", () => {
  function bar(answers: ProbeResult[]) {
    const onModelsReachable = vi.fn();
    const client = {
      baseUrl: "http://gateway.test/v1",
      probe: async () => {
        const next = answers.shift();
        if (!next) throw new Error("no probe answer left");
        return next;
      },
    };
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const statusBar = new ConnectionStatusBar(
      async () => client as unknown as OmniRouteClient,
      log as unknown as vscode.LogOutputChannel,
      undefined,
      undefined,
      onModelsReachable
    );
    return { statusBar, onModelsReachable };
  }

  it("compares poll to poll and ignores status changes reported by requests", async () => {
    const { statusBar, onModelsReachable } = bar([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: false, failure: "refused" },
      { ok: true, status: 200 },
      { ok: true, status: 401 },
      { ok: true, status: 200 },
    ]);

    await statusBar.checkNow(); // first poll accepted
    expect(onModelsReachable).toHaveBeenCalledTimes(1);
    await statusBar.checkNow(); // accepted after accepted
    expect(onModelsReachable).toHaveBeenCalledTimes(1);

    statusBar.reportActivity(false); // a listing failed between two accepted polls
    await statusBar.checkNow();
    expect(onModelsReachable).toHaveBeenCalledTimes(1);

    await statusBar.checkNow(); // unreachable
    await statusBar.checkNow(); // back
    expect(onModelsReachable).toHaveBeenCalledTimes(2);

    await statusBar.checkNow(); // 401: there, but the listing would be refused
    expect(onModelsReachable).toHaveBeenCalledTimes(2);
    await statusBar.checkNow();
    expect(onModelsReachable).toHaveBeenCalledTimes(3);
    statusBar.dispose();
  });
});

describe("statusPresentation", () => {
  it("shows a warning on an online server while the stored key is withheld", () => {
    expect(statusPresentation({ status: "online", keyWithheld: true })).toEqual({
      text: "$(warning) OmniRoute",
      color: undefined,
      background: "statusBarItem.warningBackground",
    });
  });

  it("shows the green dot on an online server that gets the key (or needs none)", () => {
    expect(statusPresentation({ status: "online", keyWithheld: false })).toEqual({
      text: "$(circle-filled) OmniRoute",
      color: "testing.iconPassed",
      background: undefined,
    });
  });

  it.each([true, false])("shows an unreachable server as offline (key withheld: %s)", (keyWithheld) => {
    expect(statusPresentation({ status: "offline", keyWithheld })).toEqual({
      text: "$(circle-outline) OmniRoute",
      color: undefined,
      background: "statusBarItem.warningBackground",
    });
  });

  it("spins while checking", () => {
    expect(statusPresentation({ status: "checking", keyWithheld: true })).toEqual({
      text: "$(sync~spin) OmniRoute",
      color: undefined,
      background: undefined,
    });
  });
});

describe("statusBarUsageSuffix", () => {
  const on = { enabled: true, online: true, keyWithheld: false, dailyPercentLeft: 76 };

  it("appends the percentage left of the daily limit", () => {
    expect(statusBarUsageSuffix(on)).toBe(" · 76%");
    expect(statusBarUsageSuffix({ ...on, dailyPercentLeft: 0 })).toBe(" · 0%");
    expect(statusBarUsageSuffix({ ...on, dailyPercentLeft: 100 })).toBe(" · 100%");
  });

  it("rounds down and stays within 0-100", () => {
    expect(statusBarUsageSuffix({ ...on, dailyPercentLeft: 76.9 })).toBe(" · 76%");
    expect(statusBarUsageSuffix({ ...on, dailyPercentLeft: 0.4 })).toBe(" · 0%");
    expect(statusBarUsageSuffix({ ...on, dailyPercentLeft: -3 })).toBe(" · 0%");
    expect(statusBarUsageSuffix({ ...on, dailyPercentLeft: 140 })).toBe(" · 100%");
  });

  it.each([
    ["the setting is off", { enabled: false }],
    ["the server is not online", { online: false }],
    ["the key is withheld", { keyWithheld: true }],
    ["there is no daily limit", { dailyPercentLeft: null }],
    ["the percentage is not a number", { dailyPercentLeft: Number.NaN }],
  ])("is empty when %s", (_name, over) => {
    expect(statusBarUsageSuffix({ ...on, ...over })).toBe("");
  });
});

describe("shouldRefreshUsage", () => {
  const minIntervalMs = 5 * 60_000;

  it("refreshes when nothing was tried yet", () => {
    expect(shouldRefreshUsage({ now: 1000, lastAttemptAt: undefined, minIntervalMs })).toBe(true);
  });

  it("waits for the whole interval after an attempt", () => {
    expect(shouldRefreshUsage({ now: 1000 + minIntervalMs - 1, lastAttemptAt: 1000, minIntervalMs })).toBe(
      false
    );
    expect(shouldRefreshUsage({ now: 1000 + minIntervalMs, lastAttemptAt: 1000, minIntervalMs })).toBe(true);
  });

  it("refreshes when the clock went back", () => {
    expect(shouldRefreshUsage({ now: 500, lastAttemptAt: 1000, minIntervalMs })).toBe(true);
  });
});

describe("nextUsageSample", () => {
  const fresh = { percentLeft: 76.4, line: "Daily: $1.20 / $5.00 (76% left)" };

  it("takes a fresh reading", () => {
    expect(nextUsageSample(undefined, { kind: "read", ...fresh })).toEqual({ ...fresh, failures: 0 });
  });

  it("keeps the last number through one failed refresh and drops it on the second", () => {
    const first = nextUsageSample(undefined, { kind: "read", ...fresh });
    const afterOne = nextUsageSample(first, { kind: "failed" });
    expect(afterOne).toEqual({ ...fresh, failures: 1 });
    expect(nextUsageSample(afterOne, { kind: "failed" })).toBeUndefined();
  });

  it("a good reading after a failure starts over", () => {
    const failed = nextUsageSample(nextUsageSample(undefined, { kind: "read", ...fresh }), { kind: "failed" });
    expect(nextUsageSample(failed, { kind: "read", ...fresh })?.failures).toBe(0);
  });

  it("drops the number when the key has no daily limit to report", () => {
    const first = nextUsageSample(undefined, { kind: "read", ...fresh });
    expect(nextUsageSample(first, { kind: "none" })).toBeUndefined();
  });

  it("has nothing to keep when the first refresh fails", () => {
    expect(nextUsageSample(undefined, { kind: "failed" })).toBeUndefined();
  });
});

describe("ConnectionStatusBar daily quota", () => {
  const WINDOW = 5 * 60_000;
  let now = 1_700_000_000_000;

  afterEach(() => {
    vi.restoreAllMocks();
    setMockConfig({});
  });

  const personal = (dailyLimitUsd: number | null, spent = 1.2): UsageLimitView => {
    const view = toUsageView({
      allowed: true,
      provider: null,
      personal: {
        enabled: dailyLimitUsd !== null,
        dailyLimitUsd,
        weeklyLimitUsd: null,
        dailySpentUsd: spent,
        weeklySpentUsd: spent,
        dailyResetAtIso: new Date(now + 3 * 3_600_000 + 30_000).toISOString(),
        weeklyResetAtIso: null,
        dailyExceeded: false,
        weeklyExceeded: false,
      },
    });
    if (view.kind !== "ready" || !view.personal) throw new Error("expected a personal view");
    return view.personal;
  };

  function bar(options: {
    probes?: ProbeResult[];
    fetchPersonal?: (connection: Connection) => Promise<UsageLimitView | null>;
    connection?: Partial<Connection>;
  }) {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const probes = options.probes ?? [];
    const client = {
      baseUrl: "http://gateway.test/v1",
      probe: async () => probes.shift() ?? ({ ok: true, status: 200 } as ProbeResult),
    };
    const connection = {
      baseUrl: "http://gateway.test/v1",
      origin: "http://gateway.test",
      approvedOrigins: ["http://gateway.test"],
      apiKey: "sk-test",
      hasStoredKey: true,
      keyWithheld: false,
      keyScope: "global",
      ...options.connection,
    } as Connection;
    const fetchPersonal = vi.fn(options.fetchPersonal ?? (async () => personal(5)));
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const statusBar = new ConnectionStatusBar(
      async () => client as unknown as OmniRouteClient,
      log as unknown as vscode.LogOutputChannel,
      undefined,
      async () => connection,
      undefined,
      fetchPersonal
    );
    const item = () => (statusBar as unknown as { item: { text: string; tooltip: string } }).item;
    return { statusBar, fetchPersonal, item, connection };
  }

  it("shows the share of the daily limit left next to the status, and the daily line in the tooltip", async () => {
    const { statusBar, item } = bar({});
    await statusBar.checkNow();
    await vi.waitFor(() => expect(item().text).toBe("$(circle-filled) OmniRoute · 76%"));
    expect(item().tooltip).toContain("Daily: $1.20 / $5.00 (76% left) · resets in 3h 0m");
    statusBar.dispose();
  });

  it("sends the key and root of the connection it polled", async () => {
    const { statusBar, fetchPersonal, connection } = bar({});
    await statusBar.checkNow();
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(1));
    expect(fetchPersonal).toHaveBeenCalledWith(connection);
    statusBar.dispose();
  });

  it("leaves the text alone when the key has no daily limit", async () => {
    const { statusBar, fetchPersonal, item } = bar({ fetchPersonal: async () => personal(null) });
    await statusBar.checkNow();
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(1));
    expect(item().text).toBe("$(circle-filled) OmniRoute");
    expect(item().tooltip).not.toContain("Daily");
    statusBar.dispose();
  });

  it("never fetches while the setting is off", async () => {
    setMockConfig({ statusBarUsage: false });
    const { statusBar, fetchPersonal, item } = bar({});
    await statusBar.checkNow();
    now += 10 * WINDOW;
    await statusBar.checkNow();
    statusBar.reportActivity(true);
    expect(fetchPersonal).not.toHaveBeenCalled();
    expect(item().text).toBe("$(circle-filled) OmniRoute");
    statusBar.dispose();
  });

  it.each([
    ["no key is stored", { apiKey: undefined, hasStoredKey: false, keyScope: "none" as const }],
    ["the key is withheld", { apiKey: undefined, keyWithheld: true }],
  ])("never fetches when %s", async (_name, connection) => {
    const { statusBar, fetchPersonal, item } = bar({ connection });
    await statusBar.checkNow();
    statusBar.reportActivity(true);
    await Promise.resolve();
    expect(fetchPersonal).not.toHaveBeenCalled();
    expect(item().text).not.toContain("%");
    statusBar.dispose();
  });

  it("does not fetch, and shows no number, while the server is offline", async () => {
    const { statusBar, fetchPersonal, item } = bar({ probes: [{ ok: false, failure: "refused" }] });
    await statusBar.checkNow();
    await Promise.resolve();
    expect(fetchPersonal).not.toHaveBeenCalled();
    expect(item().text).toBe("$(circle-outline) OmniRoute");
    statusBar.dispose();
  });

  it("refreshes at most once per 5 minutes, from polls and from finished chat responses alike", async () => {
    const { statusBar, fetchPersonal } = bar({});
    await statusBar.checkNow();
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(1));

    now += WINDOW - 1;
    await statusBar.checkNow();
    statusBar.reportActivity(true);
    await Promise.resolve();
    expect(fetchPersonal).toHaveBeenCalledTimes(1);

    now += 1;
    statusBar.reportActivity(true); // a chat response finished
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(2));

    statusBar.reportActivity(true);
    await statusBar.checkNow();
    await Promise.resolve();
    expect(fetchPersonal).toHaveBeenCalledTimes(2);
    statusBar.dispose();
  });

  it("keeps the last number through one failed refresh, then drops it", async () => {
    let answer: "ok" | "fail" = "ok";
    const { statusBar, fetchPersonal, item } = bar({
      fetchPersonal: async () => {
        if (answer === "fail") throw new Error("unreachable");
        return personal(5);
      },
    });
    await statusBar.checkNow();
    await vi.waitFor(() => expect(item().text).toContain("76%"));

    answer = "fail";
    now += WINDOW;
    await statusBar.checkNow();
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(2));
    expect(item().text).toContain("76%");

    now += WINDOW;
    await statusBar.checkNow();
    await vi.waitFor(() => expect(item().text).toBe("$(circle-filled) OmniRoute"));
    statusBar.dispose();
  });

  it("starts over on restart, so a changed key or setting is read at once", async () => {
    const { statusBar, fetchPersonal } = bar({});
    await statusBar.checkNow();
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(1));
    statusBar.restart();
    await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(2));
    statusBar.dispose();
  });

  describe("the number belongs to the key and the server it was read for", () => {
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it("drops the number at once when another key is stored, and reads again without waiting", async () => {
      const pending: Array<(view: UsageLimitView | null) => void> = [];
      let calls = 0;
      const { statusBar, fetchPersonal, item, connection } = bar({
        fetchPersonal: () =>
          ++calls === 1
            ? Promise.resolve(personal(5))
            : new Promise<UsageLimitView | null>((resolve) => void pending.push(resolve)),
      });
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));

      connection.apiKey = "sk-other"; // same server, another key; no restart(), 1 s later
      now += 1000;
      await statusBar.checkNow();

      expect(item().text).toBe("$(circle-filled) OmniRoute");
      expect(item().tooltip).not.toContain("Daily");
      await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(2));
      pending[0]?.(personal(10, 2));
      await vi.waitFor(() => expect(item().text).toContain("80%"));
      statusBar.dispose();
    });

    it("drops the number when the key is cleared", async () => {
      const { statusBar, fetchPersonal, item, connection } = bar({});
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));

      connection.apiKey = undefined;
      connection.hasStoredKey = false;
      connection.keyScope = "none";
      await statusBar.checkNow();

      expect(item().text).toBe("$(circle-filled) OmniRoute");
      await flush();
      expect(fetchPersonal).toHaveBeenCalledTimes(1);
      statusBar.dispose();
    });

    /** First read answers at once; later reads stay out until the test lets them go. */
    const firstThenHeld = () => {
      let calls = 0;
      return () =>
        ++calls === 1
          ? Promise.resolve(personal(5))
          : new Promise<UsageLimitView | null>(() => undefined);
    };

    it("drops the number when the key scope changes under the same key", async () => {
      const { statusBar, item, connection } = bar({ fetchPersonal: firstThenHeld() });
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));
      connection.keyScope = "workspace";
      await statusBar.checkNow();
      expect(item().text).toBe("$(circle-filled) OmniRoute");
      statusBar.dispose();
    });

    it("drops the number when the server changes", async () => {
      const { statusBar, fetchPersonal, item, connection } = bar({ fetchPersonal: firstThenHeld() });
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));

      connection.origin = "http://other.test";
      connection.baseUrl = "http://other.test/v1";
      await statusBar.checkNow();

      expect(item().text).toBe("$(circle-filled) OmniRoute");
      await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(2));
      statusBar.dispose();
    });

    it("keeps the number while the connection stays the same", async () => {
      const { statusBar, fetchPersonal, item } = bar({});
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));
      await statusBar.checkNow();
      await flush();
      expect(item().text).toContain("76%");
      expect(fetchPersonal).toHaveBeenCalledTimes(1);
      statusBar.dispose();
    });

    it("ignores a read that finishes after restart()", async () => {
      const pending: Array<(view: UsageLimitView | null) => void> = [];
      let calls = 0;
      const { statusBar, fetchPersonal, item } = bar({
        fetchPersonal: () =>
          ++calls === 1
            ? new Promise<UsageLimitView | null>((resolve) => void pending.push(resolve))
            : Promise.resolve(null),
      });
      await statusBar.checkNow();
      await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(1));

      statusBar.restart(); // a changed key or setting, while the first read is still out
      await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(2)); // not blocked by the stale one
      await flush();
      pending[0]?.(personal(5)); // the old read finally lands
      await flush();

      expect(item().text).toBe("$(circle-filled) OmniRoute");
      statusBar.dispose();
    });

    it("lets a read that was waiting for the connection when restart() ran change nothing", async () => {
      const releases: Array<(value: Connection) => void> = [];
      const { statusBar, fetchPersonal, connection } = bar({});
      const resolveConnection = vi
        .fn<() => Promise<Connection>>()
        .mockImplementationOnce(() => new Promise<Connection>((resolve) => void releases.push(resolve)))
        .mockImplementationOnce(() => new Promise<Connection>((resolve) => void releases.push(resolve)))
        .mockResolvedValue(connection);
      (statusBar as unknown as { getConnection: unknown }).getConnection = resolveConnection;

      statusBar.reportActivity(true); // a chat response; its usage read waits for the connection
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      statusBar.restart(); // its poll waits for the connection too
      await vi.waitFor(() => expect(releases).toHaveLength(2));

      releases[0]?.(connection); // the stale read resumes first
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(fetchPersonal).not.toHaveBeenCalled(); // it neither read nor took the floor

      releases[1]?.(connection);
      await vi.waitFor(() => expect(fetchPersonal).toHaveBeenCalledTimes(1));
      statusBar.dispose();
    });

    it("removes the suffix from the status bar as soon as restart() runs with the setting off", async () => {
      const { statusBar, item } = bar({});
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));

      setMockConfig({ statusBarUsage: false });
      statusBar.restart();

      expect(item().text).toBe("$(circle-filled) OmniRoute"); // synchronously, not at the next poll
      statusBar.dispose();
    });

    it("hides the number as soon as the key becomes withheld while a sample exists", async () => {
      const { statusBar, fetchPersonal, item, connection } = bar({});
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toBe("$(circle-filled) OmniRoute · 76%"));

      connection.apiKey = undefined; // saved for another origin: not sent
      connection.keyWithheld = true;
      await statusBar.checkNow();

      expect(item().text).toBe("$(warning) OmniRoute");
      expect(item().tooltip).not.toContain("Daily");
      await flush();
      expect(fetchPersonal).toHaveBeenCalledTimes(1);
      statusBar.dispose();
    });

    it("clears the number on restart() before any probe answers", async () => {
      const { statusBar, item } = bar({});
      await statusBar.checkNow();
      await vi.waitFor(() => expect(item().text).toContain("76%"));
      statusBar.restart();
      expect(item().text).not.toContain("%");
      statusBar.dispose();
    });
  });
});

describe("connectionFingerprint", () => {
  const base = {
    origin: "http://gateway.test",
    apiKey: "sk-secret-key",
    keyScope: "global",
  } as Connection;

  it("changes with the origin, the key scope and the key", () => {
    const fp = connectionFingerprint(base);
    expect(connectionFingerprint({ ...base })).toBe(fp);
    expect(connectionFingerprint({ ...base, origin: "http://other.test" })).not.toBe(fp);
    expect(connectionFingerprint({ ...base, keyScope: "workspace" })).not.toBe(fp);
    expect(connectionFingerprint({ ...base, apiKey: "sk-other" })).not.toBe(fp);
    expect(connectionFingerprint({ ...base, apiKey: undefined })).not.toBe(fp);
  });

  it("never contains the key", () => {
    expect(connectionFingerprint(base)).not.toContain("sk-secret-key");
  });
});

describe("ConnectionStatusBar daily quota through the real usage read", () => {
  const WINDOW = 5 * 60_000;
  let now = 1_800_000_000_000;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setMockConfig({});
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const allowed = () =>
    json({
      allowed: true,
      provider: null,
      personal: {
        enabled: true,
        dailyLimitUsd: 5,
        weeklyLimitUsd: null,
        dailySpentUsd: 1.2,
        weeklySpentUsd: 1.2,
        dailyResetAtIso: "2999-01-01T00:00:00Z",
        weeklyResetAtIso: null,
        dailyExceeded: false,
        weeklyExceeded: false,
      },
    });

  /** `script[n]` answers the n-th usage request (om-usage or me/status), in order. */
  function setUp(script: Array<() => Promise<Response> | Response>) {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: string[] = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        const answer = script[n++];
        if (!answer) throw new Error(`no answer left for ${url}`);
        return answer();
      })
    );
    const client = {
      baseUrl: "http://gateway.test/v1",
      probe: async () => ({ ok: true, status: 200 }) as ProbeResult,
    };
    const connection = {
      baseUrl: "http://gateway.test/v1",
      origin: "http://gateway.test",
      approvedOrigins: ["http://gateway.test"],
      apiKey: "sk-test",
      hasStoredKey: true,
      keyWithheld: false,
      keyScope: "global",
    } as Connection;
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const statusBar = new ConnectionStatusBar(
      async () => client as unknown as OmniRouteClient,
      log as unknown as vscode.LogOutputChannel,
      undefined,
      async () => connection,
      undefined,
      (c) => fetchPersonalUsage(c.baseUrl, c.apiKey)
    );
    const item = () => (statusBar as unknown as { item: { text: string } }).item;
    /** One poll a whole window after the last one, then let its usage read settle. */
    const nextWindow = async (expectedCalls: number) => {
      now += WINDOW;
      await statusBar.checkNow();
      await vi.waitFor(() => expect(calls.length).toBe(expectedCalls));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { statusBar, item, calls, nextWindow };
  }

  it.each([
    ["a 502 from a proxy on the first call", [() => new Response("<html>", { status: 502, headers: { "content-type": "text/html" } })]],
    ["a 500 JSON body on the first call", [() => json({ error: "boom" }, 500)]],
    ["a 500 on the second call", [() => json({ allowed: false }), () => json({ error: "boom" }, 500)]],
    ["a network error on the second call", [() => json({ allowed: false }), () => Promise.reject(new TypeError("fetch failed"))]],
  ])("keeps the number for one window and drops it after the second failure: %s", async (_name, failing) => {
    const failure = failing as Array<() => Promise<Response> | Response>;
    const { statusBar, item, nextWindow } = setUp([allowed, ...failure, ...failure]);
    await statusBar.checkNow();
    await vi.waitFor(() => expect(item().text).toContain("76%"));

    await nextWindow(1 + failure.length); // first failed read: the number stays
    expect(item().text).toContain("76%");

    await nextWindow(1 + 2 * failure.length); // second in a row: it goes
    expect(item().text).toBe("$(circle-filled) OmniRoute");
    statusBar.dispose();
  });

  it("clears the number at once when the self-service call answers 403", async () => {
    const { statusBar, item, nextWindow } = setUp([
      allowed,
      () => json({ allowed: false }),
      () => json({ error: "Forbidden" }, 403),
    ]);
    await statusBar.checkNow();
    await vi.waitFor(() => expect(item().text).toContain("76%"));

    await nextWindow(3);
    expect(item().text).toBe("$(circle-filled) OmniRoute");
    statusBar.dispose();
  });
});

describe("ConnectionStatusBar polls and key changes", () => {
  let now = 1_900_000_000_000;

  afterEach(() => {
    vi.restoreAllMocks();
    setMockConfig({});
  });

  /** 10% of the daily limit left for sk-1, 90% for sk-2. */
  const viewFor = (key: string | undefined): UsageLimitView => {
    const view = toUsageView({
      allowed: true,
      provider: null,
      personal: {
        enabled: true,
        dailyLimitUsd: 10,
        weeklyLimitUsd: null,
        dailySpentUsd: key === "sk-1" ? 9 : 1,
        weeklySpentUsd: 0,
        dailyResetAtIso: "2999-01-01T00:00:00Z",
        weeklyResetAtIso: null,
        dailyExceeded: false,
        weeklyExceeded: false,
      },
    });
    if (view.kind !== "ready" || !view.personal) throw new Error("expected a personal view");
    return view.personal;
  };

  /** Probes stay out until the test settles them; each connection read hands out a fresh copy. */
  function setUp(options: { heldUsage?: (key: string | undefined) => boolean } = {}) {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const probes: Array<{ ok: (status?: number) => void; fail: () => void }> = [];
    const client = {
      baseUrl: "http://gateway.test/v1",
      probe: () =>
        new Promise<ProbeResult>((resolve, reject) => {
          probes.push({
            ok: (status = 200) => resolve({ ok: true, status }),
            fail: () => reject(new Error("probe lost")),
          });
        }),
    };
    let key: string | undefined = "sk-1";
    const current = (): Connection =>
      ({
        baseUrl: "http://gateway.test/v1",
        origin: "http://gateway.test",
        approvedOrigins: ["http://gateway.test"],
        apiKey: key,
        hasStoredKey: key !== undefined,
        keyWithheld: false,
        keyScope: key ? "global" : "none",
      }) as Connection;
    const usageKeys: Array<string | undefined> = [];
    const releases: Array<() => void> = [];
    const fetchPersonal = vi.fn((connection: Connection) => {
      usageKeys.push(connection.apiKey);
      if (options.heldUsage?.(connection.apiKey)) {
        return new Promise<UsageLimitView | null>((resolve) => {
          releases.push(() => resolve(viewFor(connection.apiKey)));
        });
      }
      return Promise.resolve(viewFor(connection.apiKey));
    });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const statusBar = new ConnectionStatusBar(
      async () => client as unknown as OmniRouteClient,
      log as unknown as vscode.LogOutputChannel,
      undefined,
      async () => current(),
      undefined,
      fetchPersonal
    );
    const item = statusBar as unknown as { item: { text: string; tooltip: string } };
    const writes: string[] = [];
    let text = "";
    Object.defineProperty(item.item, "text", {
      get: () => text,
      set: (value: string) => {
        text = value;
        writes.push(value);
      },
    });
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return {
      statusBar,
      probes,
      usageKeys,
      releases,
      fetchPersonal,
      writes,
      text: () => text,
      setKey: (next: string | undefined) => void (key = next),
      flush,
    };
  }

  it("does not send the old key, nor show its number, when a poll that began before a key change finishes last", async () => {
    const t = setUp();
    const pollA = t.statusBar.checkNow(); // begins under sk-1
    await vi.waitFor(() => expect(t.probes).toHaveLength(1));

    t.setKey("sk-2");
    t.statusBar.restart(); // poll B begins under sk-2
    await vi.waitFor(() => expect(t.probes).toHaveLength(2));
    t.probes[1]?.ok();
    await vi.waitFor(() => expect(t.text()).toBe("$(circle-filled) OmniRoute · 90%"));
    expect(t.usageKeys).toEqual(["sk-2"]);

    t.probes[0]?.ok(); // poll A's probe, late
    await pollA;
    await t.flush();

    expect(t.usageKeys).toEqual(["sk-2"]); // sk-1 was not sent again
    expect(t.text()).toBe("$(circle-filled) OmniRoute · 90%");
    expect(t.writes.some((text) => text.includes("10%"))).toBe(false);
    t.statusBar.dispose();
  });

  it("keeps poll B's status and number when poll A's probe is lost late", async () => {
    const t = setUp();
    const pollA = t.statusBar.checkNow();
    await vi.waitFor(() => expect(t.probes).toHaveLength(1));

    t.setKey("sk-2");
    t.statusBar.restart();
    await vi.waitFor(() => expect(t.probes).toHaveLength(2));
    t.probes[1]?.ok();
    await vi.waitFor(() => expect(t.text()).toBe("$(circle-filled) OmniRoute · 90%"));

    t.probes[0]?.fail();
    await expect(pollA).rejects.toThrow("probe lost");
    await t.flush();

    expect(t.text()).toBe("$(circle-filled) OmniRoute · 90%");
    expect(t.usageKeys).toEqual(["sk-2"]);
    t.statusBar.dispose();
  });

  it("applies nothing of a stale poll: not its status, not its model refill", async () => {
    const onModelsReachable = vi.fn();
    const t = setUp();
    (t.statusBar as unknown as { onModelsReachable: unknown }).onModelsReachable = onModelsReachable;
    const pollA = t.statusBar.checkNow();
    await vi.waitFor(() => expect(t.probes).toHaveLength(1));
    t.statusBar.restart();
    await vi.waitFor(() => expect(t.probes).toHaveLength(2));
    t.probes[1]?.ok(401); // the new poll: there, but the listing would be refused
    await vi.waitFor(() => expect(t.text()).toContain("OmniRoute"));

    t.probes[0]?.ok(200); // the old poll would read as "accepted after not accepted"
    await pollA;
    await t.flush();
    expect(onModelsReachable).not.toHaveBeenCalled();
    t.statusBar.dispose();
  });

  it("does not let a poll that resolved its connection before a key change adopt it afterwards", async () => {
    const t = setUp();
    const stale = {
      baseUrl: "http://gateway.test/v1",
      origin: "http://gateway.test",
      approvedOrigins: ["http://gateway.test"],
      apiKey: "sk-1",
      hasStoredKey: true,
      keyWithheld: false,
      keyScope: "global",
    } as Connection;
    let releaseStale: ((connection: Connection) => void) | undefined;
    const original = (t.statusBar as unknown as { getConnection: () => Promise<Connection> }).getConnection;
    (t.statusBar as unknown as { getConnection: unknown }).getConnection = vi
      .fn<() => Promise<Connection>>()
      .mockImplementationOnce(() => new Promise<Connection>((resolve) => void (releaseStale = resolve)))
      .mockImplementation(original);

    const pollA = t.statusBar.checkNow(); // waiting for its connection
    await vi.waitFor(() => expect(releaseStale).toBeDefined());
    t.setKey("sk-2");
    t.statusBar.restart(); // poll B resolves sk-2 and adopts it
    await vi.waitFor(() => expect(t.probes).toHaveLength(1));
    const fingerprintNow = (t.statusBar as unknown as { usageFingerprint: string }).usageFingerprint;

    releaseStale?.(stale); // poll A's old answer arrives
    await t.flush();

    expect((t.statusBar as unknown as { usageFingerprint: string }).usageFingerprint).toBe(fingerprintNow);
    expect(fingerprintNow).toBe(
      connectionFingerprint({ ...stale, apiKey: "sk-2" } as Connection)
    );
    t.probes[0]?.ok();
    void pollA;
    t.statusBar.dispose();
  });

  describe("a render between a key change and the next read", () => {
    it("never draws the old key's number when the status changes on chat activity", async () => {
      const t = setUp({ heldUsage: (key) => key === "sk-2" });
      const poll = t.statusBar.checkNow();
      await vi.waitFor(() => expect(t.probes).toHaveLength(1));
      t.probes[0]?.ok();
      await poll;
      await vi.waitFor(() => expect(t.text()).toContain("10%"));
      t.statusBar.reportActivity(false); // the server stopped answering: offline, number hidden
      expect(t.text()).toBe("$(circle-outline) OmniRoute");

      t.setKey("sk-2"); // changed behind the extension's back, no restart()
      t.writes.length = 0;
      t.statusBar.reportActivity(true); // a chat response finished: status back to online
      await vi.waitFor(() => expect(t.usageKeys).toEqual(["sk-1", "sk-2"]));
      await t.flush();

      expect(t.writes.some((text) => text.includes("10%"))).toBe(false);
      expect(t.text()).toBe("$(circle-filled) OmniRoute");
      t.releases[0]?.();
      await vi.waitFor(() => expect(t.text()).toBe("$(circle-filled) OmniRoute · 90%"));
      t.statusBar.dispose();
    });

    it("does not redraw at all when chat activity leaves the status as it was", async () => {
      const t = setUp({ heldUsage: (key) => key === "sk-2" });
      const poll = t.statusBar.checkNow();
      await vi.waitFor(() => expect(t.probes).toHaveLength(1));
      t.probes[0]?.ok();
      await poll;
      await vi.waitFor(() => expect(t.text()).toContain("10%"));

      t.setKey("sk-2");
      t.writes.length = 0;
      t.statusBar.reportActivity(true);
      // The old number is on screen until the new connection is known; nothing wrote it again,
      // and once the connection is resolved it goes.
      await vi.waitFor(() => expect(t.usageKeys).toEqual(["sk-1", "sk-2"]));
      await t.flush();
      expect(t.writes.every((text) => !text.includes("10%"))).toBe(true);
      expect(t.text()).toBe("$(circle-filled) OmniRoute");
      t.statusBar.dispose();
    });
  });
});
