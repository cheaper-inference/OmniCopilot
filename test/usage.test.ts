import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUsagePayload,
  dailyUsageLine,
  exactPercentLeft,
  fetchPersonalUsage,
  fetchUsage,
  formatResetIn,
  formatUsd,
  percentLeft,
  personalFromSelfStatus,
  quotaRemainingPercent,
  resetLabel,
  toUsageView,
} from "../src/usage";
import type { UsageResponse } from "../src/usage";

describe("toUsageView", () => {
  it("maps a refusal to the disabled state, carrying the reason", () => {
    const body: UsageResponse = { allowed: false, error: { message: "no" } };
    expect(toUsageView(body)).toEqual({ kind: "disabled", message: "no" });
  });

  it("reads providers[] when the server has the per-connection array", () => {
    const body: UsageResponse = {
      allowed: true,
      personal: null,
      provider: { connectionId: "c1", provider: "claude" },
      providers: [
        { connectionId: "c1", provider: "claude" },
        { connectionId: "c2", provider: "codex" },
      ],
    };
    const view = toUsageView(body);
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.providers).toHaveLength(2);
  });

  it("falls back to the single provider on a server that predates providers[]", () => {
    // OmniRoute #11190 without #11192: only the selected snapshot is present.
    const body: UsageResponse = {
      allowed: true,
      personal: null,
      provider: { connectionId: "c1", provider: "claude" },
    };
    const view = toUsageView(body);
    if (view.kind === "ready") {
      expect(view.providers.map((p) => p.provider)).toEqual(["claude"]);
    } else {
      expect.unreachable();
    }
  });

  it("yields an empty providers list (not a refusal) when nothing is cached", () => {
    // Distinct from disabled: the key may ask, the server just has nothing yet.
    const view = toUsageView({ allowed: true, personal: null, provider: null });
    expect(view).toEqual({ kind: "ready", personal: null, providers: [] });
  });

  it("prepares personal and provider reset labels for the panel", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const view = toUsageView(
      {
        allowed: true,
        personal: {
          enabled: true,
          dailyLimitUsd: 10,
          weeklyLimitUsd: 50,
          dailySpentUsd: 2,
          weeklySpentUsd: 8,
          dailyResetAtIso: "2026-08-19T15:12:00Z",
          weeklyResetAtIso: "2026-08-21T16:00:00Z",
          dailyExceeded: false,
          weeklyExceeded: false,
        },
        provider: null,
        providers: [
          {
            connectionId: "c1",
            provider: "codex",
            quotas: {
              primary: { remaining: 75, resetAt: "2026-08-19T12:30:00Z" },
              secondary: { remaining: 100 },
            },
          },
        ],
      },
      now
    );

    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.personal?.dailyResetIn).toBe("3h 12m");
      expect(view.personal?.weeklyResetIn).toBe("2d 4h");
      expect(view.providers[0]?.quotas?.primary?.resetIn).toBe("30m");
      expect(view.providers[0]?.quotas?.secondary?.resetIn).toBeNull();
    }
  });

  it("precomputes percentages, the unlimited flag and reset labels for the panel", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const view = toUsageView(
      {
        allowed: true,
        personal: {
          enabled: true,
          dailyLimitUsd: 10,
          weeklyLimitUsd: null,
          dailySpentUsd: 2.5,
          weeklySpentUsd: 8,
          dailyResetAtIso: "2026-08-19T11:00:00Z", // already past
          weeklyResetAtIso: null,
          dailyExceeded: false,
          weeklyExceeded: false,
        },
        provider: null,
        providers: [
          {
            connectionId: "c1",
            provider: "mixed",
            quotas: {
              session: { usedPercentage: 30, resetAt: "2026-08-19T12:30:00Z" },
              balance: { remaining: 250, currency: "USD" },
              plan: { unlimited: true },
              count: { used: 1500 },
            },
          },
        ],
      },
      now
    );

    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.personal).toMatchObject({
      dailyPercentLeft: 75,
      weeklyPercentLeft: null,
      dailyResetIn: null,
      weeklyResetIn: null,
    });
    const quotas = view.providers[0]?.quotas ?? {};
    expect(quotas.session).toMatchObject({ percentLeft: 70, unlimited: false, resetIn: "30m" });
    expect(quotas.balance).toMatchObject({ percentLeft: null, unlimited: false, resetIn: null });
    expect(quotas.plan).toMatchObject({ percentLeft: null, unlimited: true, resetIn: null });
    expect(quotas.count?.percentLeft).toBeNull();
  });
});

describe("money quotas in the panel view", () => {
  const quotasOf = (quotas: Record<string, object>) => {
    const view = toUsageView({
      allowed: true,
      personal: null,
      provider: null,
      providers: [{ connectionId: "c1", provider: "p", quotas }],
    });
    if (view.kind !== "ready") throw new Error("expected a ready view");
    return view.providers[0]?.quotas ?? {};
  };

  it("shows a USD balance and no percentage", () => {
    const q = quotasOf({ w: { remaining: 12.5, currency: "USD" } });
    expect(q.w).toMatchObject({ balance: "$12.50", percentLeft: null, text: "$12.50 left" });
  });

  it("formats other currencies as amount plus upper-cased code", () => {
    const q = quotasOf({
      eur: { remaining: 12.5, currency: "eur" },
      cny: { remaining: 300, currency: "CNY" },
      long: { remaining: 1.23456, currency: "gbp" },
      usd: { remaining: 3, currency: "usd" },
    });
    expect(q.eur?.balance).toBe("12.5 EUR");
    expect(q.cny?.balance).toBe("300 CNY");
    expect(q.long?.balance).toBe("1.23 GBP");
    expect(q.usd?.balance).toBe("$3.00");
  });

  it("has no balance without a currency, or without a usable remaining", () => {
    const q = quotasOf({
      plain: { remaining: 12.5 },
      empty: { remaining: 12.5, currency: "" },
      negative: { remaining: -1, currency: "USD" },
      none: { currency: "USD" },
    });
    expect(q.plain?.balance).toBeNull();
    expect(q.empty?.balance).toBeNull();
    expect(q.negative?.balance).toBeNull();
    expect(q.none?.balance).toBeNull();
  });
});

describe("formatters", () => {
  it("formatUsd renders USD and em-dash for non-numbers", () => {
    expect(formatUsd(1.25)).toBe("$1.25");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });

  it("percentLeft clamps into 0–100 and is null without a limit", () => {
    expect(percentLeft(1, 4)).toBe(75);
    expect(percentLeft(10, 4)).toBe(0); // overspent never goes negative
    expect(percentLeft(0, 4)).toBe(100);
    expect(percentLeft(1, null)).toBeNull();
  });

  it("formatResetIn mirrors the server's phrasing", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    expect(formatResetIn("2026-08-21T16:00:00Z", now)).toBe("2d 4h");
    expect(formatResetIn("2026-08-19T15:12:00Z", now)).toBe("3h 12m");
    expect(formatResetIn("2026-08-19T12:30:00Z", now)).toBe("30m");
    expect(formatResetIn(null, now)).toBe("unknown");
    expect(formatResetIn("not-a-date", now)).toBe("unknown");
    expect(formatResetIn("2026-08-19T11:00:00Z", now)).toBe("now"); // already past
  });
});

describe("quotaRemainingPercent", () => {
  it("resolves the remaining percentage in the server's order", () => {
    expect(quotaRemainingPercent({ usedPercentage: 30, used: 1, total: 2 })).toBe(70);
    expect(quotaRemainingPercent({ used: 25, total: 100 })).toBe(75);
    expect(quotaRemainingPercent({ used: 40 })).toBe(60);
    expect(quotaRemainingPercent({ remainingPercentage: 42 })).toBe(42);
    expect(quotaRemainingPercent({ remaining: 60 })).toBe(60);
  });

  it("lets used/total and a small `used` win over remainingPercentage and remaining", () => {
    expect(quotaRemainingPercent({ remainingPercentage: 42, used: 1, total: 10, remaining: 7 })).toBe(90);
    expect(quotaRemainingPercent({ used: 5, total: 0 })).toBe(95); // total unusable, used read as a percentage
    expect(quotaRemainingPercent({ remainingPercentage: 42, remaining: 7 })).toBe(42);
  });

  it("does not read a balance or an absolute count as a percentage", () => {
    expect(quotaRemainingPercent({ remaining: 250 })).toBeNull();
    expect(quotaRemainingPercent({ used: 1500 })).toBeNull();
    expect(quotaRemainingPercent({ used: -3 })).toBeNull();
    expect(quotaRemainingPercent({ remaining: -1 })).toBeNull();
    expect(quotaRemainingPercent({})).toBeNull();
  });

  it("never reads `remaining` (or a small `used`) as a percentage on a money quota", () => {
    expect(quotaRemainingPercent({ remaining: 12.5, currency: "USD" })).toBeNull();
    expect(quotaRemainingPercent({ remaining: 60 })).toBe(60);
    expect(quotaRemainingPercent({ used: 3, total: 10, currency: "USD" })).toBe(70);
    expect(quotaRemainingPercent({ used: 3, currency: "USD" })).toBeNull();
    expect(quotaRemainingPercent({ usedPercentage: 20, remaining: 12.5, currency: "USD" })).toBeNull();
    expect(quotaRemainingPercent({ remainingPercentage: 40, currency: "EUR" })).toBeNull();
    expect(quotaRemainingPercent({ remaining: 12.5, currency: "" })).toBe(13); // empty currency is not money: remaining 12.5 read as a percentage
  });

  it("gives a money quota a percentage only for its bar, and only when total is positive", () => {
    expect(quotaRemainingPercent({ total: 10, remainingPercentage: 40, currency: "EUR" })).toBe(40);
    expect(quotaRemainingPercent({ used: 8, total: 10, remainingPercentage: 50, currency: "USD" })).toBe(20);
    expect(
      quotaRemainingPercent({ used: 0, total: 0, remaining: 0.37, remainingPercentage: 100, currency: "USD" })
    ).toBeNull();
    expect(quotaRemainingPercent({ total: 10, currency: "USD" })).toBeNull();
  });

  it("clamps to 0-100 and rounds", () => {
    expect(quotaRemainingPercent({ used: 150, total: 100 })).toBe(0);
    expect(quotaRemainingPercent({ usedPercentage: 130 })).toBe(0);
    expect(quotaRemainingPercent({ usedPercentage: -5 })).toBe(100);
    expect(quotaRemainingPercent({ remainingPercentage: 130 })).toBe(100);
    expect(quotaRemainingPercent({ used: 1, total: 3 })).toBe(67);
  });

  it("accepts numeric strings the way the server does and ignores other values", () => {
    const loose = (q: object) => q as Parameters<typeof quotaRemainingPercent>[0];
    expect(quotaRemainingPercent(loose({ usedPercentage: "20" }))).toBe(80);
    expect(quotaRemainingPercent(loose({ used: "1", total: "4" }))).toBe(75);
    expect(quotaRemainingPercent(loose({ usedPercentage: "abc", remaining: 30 }))).toBe(30);
    expect(quotaRemainingPercent(loose({ usedPercentage: "  " }))).toBeNull();
  });
});

describe("resetLabel", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");

  it("returns the formatted countdown for a future reset", () => {
    expect(resetLabel("2026-08-21T16:00:00Z", now)).toBe("2d 4h");
    expect(resetLabel("2026-08-19T12:30:00Z", now)).toBe("30m");
  });

  it("drops the label when the time is unknown or already past", () => {
    expect(resetLabel(null, now)).toBeNull();
    expect(resetLabel(undefined, now)).toBeNull();
    expect(resetLabel("", now)).toBeNull();
    expect(resetLabel("not-a-date", now)).toBeNull();
    expect(resetLabel("2026-08-19T11:00:00Z", now)).toBeNull();
  });
});

describe("buildUsagePayload", () => {
  const fb = { promptChars: 400, completionChars: 80 };

  it("uses the server's numbers when present", () => {
    const r = buildUsagePayload(
      { prompt_tokens: 407, completion_tokens: 169, prompt_tokens_details: { cached_tokens: 5 } },
      fb
    );
    expect(r.estimated).toBe(false);
    expect(r.payload).toEqual({
      prompt_tokens: 407,
      completion_tokens: 169,
      total_tokens: 576,
      prompt_tokens_details: { cached_tokens: 5 },
    });
  });

  it("accepts input_tokens/output_tokens naming", () => {
    const r = buildUsagePayload({ input_tokens: 10, output_tokens: 4 }, fb);
    expect(r.payload.total_tokens).toBe(14);
    expect(r.estimated).toBe(false);
  });

  it("falls back to ~4 chars/token and flags it as estimated", () => {
    const r = buildUsagePayload(null, fb);
    expect(r.estimated).toBe(true);
    expect(r.payload).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  });
});

describe("quota text with the shapes the server sends", () => {
  // Fixtures copied from OmniRoute open-sse/services/usage/{deepseek,kilocode,lyceum}.ts.
  const deepseek = {
    used: 0,
    total: 0,
    remaining: 0.37,
    remainingPercentage: 100,
    resetAt: null,
    unlimited: true,
    currency: "USD",
  };
  const kiloBalance = { ...deepseek, displayName: "Balance (USD)" };
  const kiloPassUsage = {
    used: 0,
    total: 19,
    remaining: 19,
    remainingPercentage: 100,
    resetAt: "2026-12-01T00:00:00Z",
    unlimited: false,
    currency: "USD",
    displayName: "Kilo Pass Usage",
  };
  const lyceum = {
    used: 8,
    total: 10,
    remaining: 2,
    remainingPercentage: 20,
    resetAt: null,
    unlimited: false,
    displayName: "Credits balance",
    currency: "USD",
  };

  const viewOf = (quotas: Record<string, object>, t?: (s: string, ...a: Array<string | number>) => string) => {
    const view = toUsageView(
      { allowed: true, personal: null, provider: null, providers: [{ connectionId: "c", provider: "p", quotas }] },
      Date.parse("2026-11-14T00:00:00Z"),
      t
    );
    if (view.kind !== "ready") throw new Error("expected a ready view");
    return view.providers[0]?.quotas ?? {};
  };

  it("shows the DeepSeek balance, not unlimited, and no bar", () => {
    expect(viewOf({ credits_usd: deepseek }).credits_usd).toMatchObject({
      text: "$0.37 left",
      percentLeft: null,
      label: "credits_usd",
    });
  });

  it("shows the Kilo balance under the server's display name", () => {
    expect(viewOf({ balance: kiloBalance }).balance).toMatchObject({
      text: "$0.37 left",
      percentLeft: null,
      label: "Balance (USD)",
    });
  });

  it("shows the Kilo Pass usage balance with a full bar", () => {
    expect(viewOf({ kiloPassUsage }).kiloPassUsage).toMatchObject({
      text: "$19.00 left",
      percentLeft: 100,
      label: "Kilo Pass Usage",
    });
  });

  it("shows the Lyceum balance with a bar at 20", () => {
    expect(viewOf({ credits: lyceum }).credits).toMatchObject({ text: "$2.00 left", percentLeft: 20 });
  });

  it("keeps the rules for windows without a currency", () => {
    const q = viewOf({ plan: { unlimited: true }, session: { usedPercentage: 38 }, count: { remaining: 250 } });
    expect(q.plan).toMatchObject({ text: "unlimited", percentLeft: null });
    expect(q.session).toMatchObject({ text: "62% left", percentLeft: 62 });
    expect(q.count).toMatchObject({ text: "—", percentLeft: null });
  });

  it("draws no bar under an unlimited window", () => {
    expect(viewOf({ plan: { unlimited: true, usedPercentage: 30 } }).plan).toMatchObject({
      text: "unlimited",
      percentLeft: null,
    });
  });

  it("localises the text through the function it is given", () => {
    const t = (source: string, ...args: Array<string | number>) =>
      `<${source.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)]))}>`;
    const q = viewOf({ a: lyceum, b: { usedPercentage: 38 }, c: { unlimited: true } }, t);
    expect(q.a?.text).toBe("<$2.00 left>");
    expect(q.b?.text).toBe("<62% left>");
    expect(q.c?.text).toBe("<unlimited>");
  });
});

describe("personal limit text", () => {
  const personal = {
    enabled: true,
    dailyLimitUsd: 5,
    weeklyLimitUsd: null,
    dailySpentUsd: 1.2,
    weeklySpentUsd: 3,
    dailyResetAtIso: "2026-11-15T00:00:00Z",
    weeklyResetAtIso: null,
    dailyExceeded: false,
    weeklyExceeded: false,
  };

  it("spells out spent, limit and the share left", () => {
    const view = toUsageView({ allowed: true, personal, provider: null });
    if (view.kind !== "ready") throw new Error("expected a ready view");
    expect(view.personal?.dailyText).toBe("$1.20 / $5.00 (76% left)");
    // A window with spend and no limit reads as the spend alone.
    expect(view.personal?.weeklyText).toBe("$3.00");
  });

  it("leaves the text empty for a window with neither a limit nor any spend", () => {
    const view = toUsageView({
      allowed: true,
      personal: { ...personal, dailyLimitUsd: null, dailySpentUsd: 0 },
      provider: null,
    });
    if (view.kind !== "ready") throw new Error("expected a ready view");
    expect(view.personal?.dailyText).toBe("");
    expect(view.personal?.dailyPercentLeft).toBeNull();
  });
});

describe("malformed quota windows", () => {
  it("skips a window that is null or not an object instead of hiding the whole section", () => {
    const view = toUsageView({
      allowed: true,
      personal: null,
      provider: null,
      providers: [
        {
          connectionId: "c",
          provider: "p",
          quotas: { gone: null, text: "x", count: 3, session: { usedPercentage: 38 } } as never,
        },
      ],
    });
    if (view.kind !== "ready") throw new Error("expected a ready view");
    expect(Object.keys(view.providers[0]?.quotas ?? {})).toEqual(["session"]);
    expect(view.providers[0]?.quotas?.session?.text).toBe("62% left");
  });
});

// Bodies of GET /v1/me/status, shaped as the server builds them
// (OmniRoute src/lib/usage/apiKeySelfService.ts, buildApiKeySelfServiceStatus).
// The limit entry is the one in tests/unit/api-key-self-service-limits.test.ts.
const dailyEntry = {
  id: "usage_limit:daily",
  source: "usage_limit",
  metric: "usd",
  window: "daily",
  scope: { type: "global", value: null },
  limit: 10,
  used: 12,
  remaining: 0,
  utilization: 1,
  exceeded: true,
  periodStartAt: "2026-05-27T03:00:00.000Z",
  resetAt: "2026-05-28T03:00:00.000Z",
};
const weeklyEntry = {
  ...dailyEntry,
  id: "usage_limit:weekly",
  window: "weekly",
  limit: 50,
  used: 5,
  remaining: 45,
  utilization: 0.1,
  exceeded: false,
  periodStartAt: "2026-05-25T03:00:00.000Z",
  resetAt: "2026-06-01T03:00:00.000Z",
};
const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 };
const usageWindows = {
  cost: { periodStartAt: null },
  tokens: { periodStartAt: null, ...tokens },
  daily: {
    periodStartAt: "2026-05-27T03:00:00.000Z",
    resetAt: "2026-05-28T03:00:00.000Z",
    costUsd: 1.2,
    requests: 4,
    tokens,
  },
  weekly: {
    periodStartAt: "2026-05-25T03:00:00.000Z",
    resetAt: "2026-06-01T03:00:00.000Z",
    costUsd: 3.4,
    requests: 9,
    tokens,
  },
};
const selfStatus = (over: Record<string, unknown> = {}) => ({
  apiKey: { id: "key-1", name: "laptop" },
  generatedAt: "2026-05-27T12:00:00.000Z",
  usage: usageWindows,
  limits: [dailyEntry, weeklyEntry],
  ...over,
});

describe("personalFromSelfStatus", () => {
  it("reads both limits from the usage_limit entries", () => {
    expect(personalFromSelfStatus(selfStatus())).toEqual({
      enabled: true,
      dailyLimitUsd: 10,
      dailySpentUsd: 12,
      dailyResetAtIso: "2026-05-28T03:00:00.000Z",
      dailyExceeded: true,
      weeklyLimitUsd: 50,
      weeklySpentUsd: 5,
      weeklyResetAtIso: "2026-06-01T03:00:00.000Z",
      weeklyExceeded: false,
    });
  });

  it("takes the other window from the usage totals when only one has a limit", () => {
    expect(personalFromSelfStatus(selfStatus({ limits: [dailyEntry] }))).toEqual({
      enabled: true,
      dailyLimitUsd: 10,
      dailySpentUsd: 12,
      dailyResetAtIso: "2026-05-28T03:00:00.000Z",
      dailyExceeded: true,
      weeklyLimitUsd: null,
      weeklySpentUsd: 3.4,
      weeklyResetAtIso: "2026-06-01T03:00:00.000Z",
      weeklyExceeded: false,
    });
  });

  it("reports the spend alone when there are no limits", () => {
    expect(personalFromSelfStatus(selfStatus({ limits: [] }))).toEqual({
      enabled: false,
      dailyLimitUsd: null,
      dailySpentUsd: 1.2,
      dailyResetAtIso: "2026-05-28T03:00:00.000Z",
      dailyExceeded: false,
      weeklyLimitUsd: null,
      weeklySpentUsd: 3.4,
      weeklyResetAtIso: "2026-06-01T03:00:00.000Z",
      weeklyExceeded: false,
    });
  });

  it("ignores limit entries that are not the two usage limits", () => {
    const budget = { ...dailyEntry, id: "budget:monthly", source: "budget", window: "monthly" };
    const personal = personalFromSelfStatus(selfStatus({ limits: [budget] }));
    expect(personal?.dailyLimitUsd).toBeNull();
    expect(personal?.dailySpentUsd).toBe(1.2);
  });

  it("counts a number only when it is finite and not negative", () => {
    const broken = { ...dailyEntry, limit: -1, used: Number.NaN, resetAt: 5 };
    const personal = personalFromSelfStatus(
      selfStatus({ limits: [broken], usage: { ...usageWindows, weekly: { costUsd: "3" } } })
    );
    // The broken entry is treated as absent: the daily window falls back to its totals.
    expect(personal?.dailyLimitUsd).toBeNull();
    expect(personal?.dailySpentUsd).toBe(1.2);
    expect(personal?.dailyResetAtIso).toBe("2026-05-28T03:00:00.000Z");
    expect(personal?.weeklySpentUsd).toBe(0);
    expect(personal?.weeklyResetAtIso).toBeNull();
  });

  it("treats a limit entry whose limit is zero as no limit", () => {
    const personal = personalFromSelfStatus(
      selfStatus({ limits: [{ ...dailyEntry, limit: 0, used: 0, remaining: 0, utilization: 0, exceeded: false }] })
    );
    expect(personal?.dailyLimitUsd).toBeNull();
    expect(personal?.enabled).toBe(false);
    expect(personal?.dailySpentUsd).toBe(1.2);
  });

  it("is null when the body has neither limits nor usage, or is not an object", () => {
    expect(personalFromSelfStatus({})).toBeNull();
    expect(personalFromSelfStatus({ limits: [], usage: {} })).toBeNull();
    expect(personalFromSelfStatus(selfStatus({ limits: "none", usage: null }))).toBeNull();
    expect(personalFromSelfStatus(null)).toBeNull();
    expect(personalFromSelfStatus("nope")).toBeNull();
    expect(personalFromSelfStatus([dailyEntry])).toBeNull();
  });
});

describe("fetchUsage fallback to the key's own status", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const refusal = { allowed: false, error: { message: "Usage command is not enabled" } };
  const urls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map((call) => String(call[0]));

  afterEach(() => vi.unstubAllGlobals());

  it("shows the key's own numbers when om-usage refuses and /v1/me/status answers 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(refusal))
      .mockResolvedValueOnce(json(selfStatus()));
    vi.stubGlobal("fetch", fetchMock);

    const view = await fetchUsage("http://gateway.test/v1", "sk-test");

    expect(urls(fetchMock)).toEqual([
      "http://gateway.test/api/usage/om-usage?format=json",
      "http://gateway.test/v1/me/status",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer sk-test" });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.providers).toEqual([]);
    expect(view.personal?.dailyText).toBe("$12.00 / $10.00 (0% left)");
    expect(view.personal?.dailyPercentLeft).toBe(0);
    expect(view.personal?.weeklyText).toBe("$5.00 / $50.00 (90% left)");
  });

  it("shows a window that has spend and no limit as the spend alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(refusal))
        .mockResolvedValueOnce(json(selfStatus({ limits: [] })))
    );
    const view = await fetchUsage("http://gateway.test", "sk-test");
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.personal?.dailyText).toBe("$1.20");
    expect(view.personal?.dailyPercentLeft).toBeNull();
    expect(view.personal?.weeklyText).toBe("$3.40");
  });

  it.each([401, 403, 404, 500])("keeps the not-enabled state on a %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(refusal))
        .mockResolvedValueOnce(json({ error: "no" }, status))
    );
    expect(await fetchUsage("http://gateway.test", "sk-test")).toEqual({
      kind: "disabled",
      message: "Usage command is not enabled",
    });
  });

  it.each([
    ["a body that is not an object", "[1, 2]"],
    ["a body that is not JSON", "<html>"],
    ["an object without limits or usage", "{}"],
  ])("keeps the not-enabled state for %s", async (_name, raw) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(refusal))
        .mockResolvedValueOnce(new Response(raw, { status: 200 }))
    );
    const view = await fetchUsage("http://gateway.test", "sk-test");
    expect(view.kind).toBe("disabled");
  });

  it("keeps the not-enabled state, without throwing, when the second call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(refusal))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
    );
    expect((await fetchUsage("http://gateway.test", "sk-test")).kind).toBe("disabled");
  });

  it("gives the second call the same time limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(refusal))
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
        )
    );
    expect((await fetchUsage("http://gateway.test", "sk-test", undefined, 20)).kind).toBe(
      "disabled"
    );
  });

  it("does not call /v1/me/status when om-usage allows the key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ allowed: true, personal: null, provider: null }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await fetchUsage("http://gateway.test", "sk-test");
    expect(view.kind).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call /v1/me/status without a stored key", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(refusal));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchUsage("http://gateway.test", undefined)).kind).toBe("disabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("exactPercentLeft", () => {
  it("is the share left, unrounded, clamped to 0-100", () => {
    expect(exactPercentLeft(1.2, 5)).toBeCloseTo(76, 10);
    expect(exactPercentLeft(1, 3)).toBeCloseTo(66.6667, 3);
    expect(exactPercentLeft(12, 10)).toBe(0);
    expect(exactPercentLeft(0, 10)).toBe(100);
  });

  it("is null without a usable limit", () => {
    expect(exactPercentLeft(1, null)).toBeNull();
    expect(exactPercentLeft(1, 0)).toBeNull();
    expect(exactPercentLeft(1, Number.NaN)).toBeNull();
  });
});

describe("dailyUsageLine", () => {
  const personal = {
    enabled: true,
    dailyLimitUsd: 5,
    weeklyLimitUsd: null,
    dailySpentUsd: 1.2,
    weeklySpentUsd: 0,
    dailyResetAtIso: "2026-11-15T03:00:00Z",
    weeklyResetAtIso: null,
    dailyExceeded: false,
    weeklyExceeded: false,
  };
  const now = Date.parse("2026-11-15T00:00:00Z");

  it("words the daily line the way the panel does", () => {
    const view = toUsageView({ allowed: true, personal, provider: null }, now);
    if (view.kind !== "ready" || !view.personal) throw new Error("expected a personal view");
    expect(dailyUsageLine(view.personal)).toBe("Daily: $1.20 / $5.00 (76% left) · resets in 3h 0m");
  });

  it("goes through the translation function it is given", () => {
    const t = (source: string, ...args: unknown[]) => `<${source}|${args.join(",")}>`;
    const view = toUsageView({ allowed: true, personal, provider: null }, now, t);
    if (view.kind !== "ready" || !view.personal) throw new Error("expected a personal view");
    expect(dailyUsageLine(view.personal, t)).toBe("<Daily|>: $1.20 / $5.00 (<{0}% left|76>) · <resets in {0}|3h 0m>");
  });

  it("has no line without a daily limit", () => {
    const view = toUsageView({ allowed: true, personal: { ...personal, dailyLimitUsd: null }, provider: null }, now);
    if (view.kind !== "ready" || !view.personal) throw new Error("expected a personal view");
    expect(dailyUsageLine(view.personal)).toBeNull();
  });
});

describe("fetchPersonalUsage", () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  it("returns the personal view, also through the /v1/me/status fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ allowed: false }))
        .mockResolvedValueOnce(json(selfStatus()))
    );
    const personal = await fetchPersonalUsage("http://gateway.test", "sk-test");
    expect(personal?.dailyLimitUsd).toBe(10);
  });

  it("is null when usage is not enabled and the fallback has nothing, or the server answers text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ allowed: false })));
    expect(await fetchPersonalUsage("http://gateway.test", undefined)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("text", { headers: { "content-type": "text/plain" } }))
    );
    expect(await fetchPersonalUsage("http://gateway.test", "sk-test")).toBeNull();
  });

  it("throws when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")));
    await expect(fetchPersonalUsage("http://gateway.test", "sk-test")).rejects.toThrow("fetch failed");
  });
});

describe("fetchPersonalUsage: a failed read is told apart from nothing to show", () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refusal = { allowed: false };
  const read = () => fetchPersonalUsage("http://gateway.test", "sk-test", undefined, 50);

  it.each([
    ["a 502 from a proxy, HTML", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["a 503 with a text body", () => new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } })],
    ["a 500 with a JSON body", () => json({ error: "boom" }, 500)],
    ["a 200 page that is not the server's (HTML)", () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } })],
    ["a 200 JSON body that is not an object", () => json([1, 2])],
    ["a 200 JSON object without allowed", () => json({ hello: "world" })],
    ["a 400 JSON error object without allowed", () => json({ error: { message: "bad request" } }, 400)],
    ["a 404 JSON object without allowed", () => json({ message: "not found" }, 404)],
  ])("throws on the first call: %s", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(answer()));
    await expect(read()).rejects.toThrow();
  });

  it("throws when the first call times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      )
    );
    await expect(read()).rejects.toThrow("aborted");
  });

  it.each([
    ["a 500", () => Promise.resolve(json({ error: "boom" }, 500))],
    ["a 502 from a proxy", () => Promise.resolve(new Response("<html>", { status: 502, headers: { "content-type": "text/html" } }))],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a page that is not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["a JSON body that is not an object", () => Promise.resolve(json("nope"))],
  ])("throws when the second call meets %s", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(refusal)).mockImplementationOnce(answer));
    await expect(read()).rejects.toThrow();
  });

  it("throws when the second call times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(refusal))
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
        )
    );
    await expect(read()).rejects.toThrow();
  });

  it.each([401, 403, 404])("answers nothing to show on a %i from the second call", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(json(refusal)).mockResolvedValueOnce(json({ error: "no" }, status))
    );
    await expect(read()).resolves.toBeNull();
  });

  it("answers nothing to show for an older server that answers plain text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("usage", { headers: { "content-type": "text/plain" } }))
    );
    await expect(read()).resolves.toBeNull();
  });

  it("answers nothing to show for a key without a daily limit or usage, as the server says it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(json(refusal)).mockResolvedValueOnce(json({ limits: [], usage: {} }))
    );
    await expect(read()).resolves.toBeNull();
  });
});

describe("fetchUsage keeps the panel's rule for a failed second call", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows not enabled when only the second call failed", async () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(json({ allowed: false })).mockResolvedValueOnce(json({}, 500))
    );
    expect((await fetchUsage("http://gateway.test", "sk-test")).kind).toBe("disabled");
  });
});
