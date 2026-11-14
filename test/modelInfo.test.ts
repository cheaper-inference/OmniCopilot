import { describe, expect, it } from "vitest";
import { comboSummary, comboSummaryMarkdown, describeModel, priceLabel } from "../src/modelInfo";
import type { OmniRouteCombo, OmniRouteModel } from "../src/types";

const cfg = { maxOutputTokens: 16_384, defaultContextLength: 128_000 };

describe("describeModel", () => {
  it("reads max_output_tokens and name, the fields OmniRoute sends", () => {
    expect(
      describeModel({ id: "x/y", name: "Y Pro", context_length: 200_000, max_output_tokens: 8_192 }, cfg)
    ).toEqual({
      name: "Y Pro",
      contextLength: 200_000,
      maxOutputTokens: 8_192,
      maxInputTokens: 191_808,
      effortTiers: undefined,
    });
  });

  it("still honours max_completion_tokens and display_name", () => {
    const d = describeModel(
      { id: "x/y", display_name: "Shown", name: "Other", context_length: 100_000, max_completion_tokens: 4_000 },
      cfg
    );
    expect(d.name).toBe("Shown");
    expect(d.maxOutputTokens).toBe(4_000);
    expect(d.maxInputTokens).toBe(96_000);
  });

  it("falls back to the id when no name is sent", () => {
    expect(describeModel({ id: "x/y", name: "  " }, cfg).name).toBe("x/y");
  });

  it("uses the default context length when the catalog omits it", () => {
    expect(describeModel({ id: "x/y" }, cfg).contextLength).toBe(128_000);
  });

  it("never reserves more output than the configured budget", () => {
    const d = describeModel({ id: "x/y", context_length: 200_000, max_output_tokens: 64_000 }, cfg);
    expect(d.maxOutputTokens).toBe(16_384);
    expect(d.maxInputTokens).toBe(183_616);
  });

  it("ignores a non-positive model output limit", () => {
    expect(describeModel({ id: "x/y", max_output_tokens: 0 }, cfg).maxOutputTokens).toBe(16_384);
    expect(describeModel({ id: "x/y", max_output_tokens: -5, max_completion_tokens: 2_000 }, cfg).maxOutputTokens).toBe(2_000);
  });

  it("never reserves more than half of a small context window", () => {
    const d = describeModel({ id: "tiny", context_length: 8_192 }, cfg);
    expect(d.maxOutputTokens).toBe(4_096);
    expect(d.maxInputTokens).toBe(4_096);
  });

  it("caps the input budget at max_input_tokens when the server sends a smaller one", () => {
    const d = describeModel(
      { id: "x/y", context_length: 200_000, max_output_tokens: 8_192, max_input_tokens: 100_000 },
      cfg
    );
    expect(d.maxInputTokens).toBe(100_000);
  });

  it("keeps at least 1024 input tokens", () => {
    expect(describeModel({ id: "x/y", context_length: 1_500 }, cfg).maxInputTokens).toBe(1_024);
    expect(describeModel({ id: "x/y", max_input_tokens: 10 }, cfg).maxInputTokens).toBe(1_024);
  });

  it("exposes the advertised effort tiers, without empty entries", () => {
    const d = describeModel(
      { id: "x/y", capabilities: { effort_tiers: ["low", "", "high", "max"] } },
      cfg
    );
    expect(d.effortTiers).toEqual(["low", "high", "max"]);
  });

  it.each([["high"], [{}], [null], [42]])(
    "treats effort_tiers %j that is not an array as absent",
    (effort_tiers) => {
      const model = { id: "x/y", capabilities: { effort_tiers } } as unknown as OmniRouteModel;
      expect(() => describeModel(model, cfg)).not.toThrow();
      expect(describeModel(model, cfg).effortTiers).toBeUndefined();
    }
  );

  it("drops non-string and empty entries from effort_tiers", () => {
    const model = {
      id: "x/y",
      capabilities: { effort_tiers: ["low", 3, "", "high"] },
    } as unknown as OmniRouteModel;
    expect(describeModel(model, cfg).effortTiers).toEqual(["low", "high"]);
  });

  it("reports no tiers when none survive", () => {
    expect(describeModel({ id: "x/y", capabilities: { effort_tiers: ["", " "] } }, cfg).effortTiers).toBeUndefined();
    expect(describeModel({ id: "x/y", capabilities: { effort_tiers: [] } }, cfg).effortTiers).toBeUndefined();
  });

  it.each([0, -5, Number.NaN])(
    "falls back to the default context length when context_length is %s",
    (context_length) => {
      const d = describeModel({ id: "x/y", context_length }, cfg);
      expect(d.contextLength).toBe(128_000);
      expect(d.maxOutputTokens).toBe(16_384);
      expect(d.maxInputTokens).toBe(111_616);
    }
  );

  it("never reserves less than one output token, even for a one-token window", () => {
    const d = describeModel({ id: "x/y", context_length: 1 }, cfg);
    expect(d.maxOutputTokens).toBe(1);
    expect(d.maxInputTokens).toBe(1_024);
  });
});

describe("priceLabel", () => {
  const priced = (input: number, output: number, extra: Partial<OmniRouteModel> = {}): OmniRouteModel => ({
    id: "m",
    pricing: { input, output },
    ...extra,
  });

  it("shows both prices per 1M tokens with at most four significant digits", () => {
    expect(priceLabel(priced(1.25, 10))).toBe("$1.25 in · $10 out per 1M");
    expect(priceLabel(priced(0.075, 0.3))).toBe("$0.075 in · $0.3 out per 1M");
    expect(priceLabel(priced(2.5, 1234.5678))).toBe("$2.5 in · $1235 out per 1M");
    expect(priceLabel(priced(0.00000015, 2))).toBe("$0.00000015 in · $2 out per 1M");
  });

  it("prints a zero side as $0 when the other side is not free", () => {
    expect(priceLabel(priced(0, 5))).toBe("$0 in · $5 out per 1M");
  });

  it("calls a model Free when the server says so", () => {
    expect(priceLabel(priced(0, 0, { free: true }))).toBe("Free");
    expect(priceLabel({ id: "m", pricing: { input: 0, output: 0, prompt: "0", completion: "0" } })).toBe("Free");
    expect(priceLabel({ id: "m", pricing: { prompt: "0", completion: "0", input: 0 } })).toBe("Free");
  });

  it("does not call zero numbers Free without proof (per-request providers)", () => {
    expect(priceLabel(priced(0, 0))).toBeUndefined();
    expect(priceLabel({ id: "m", pricing: { input: 0, output: 0, prompt: "0.000001", completion: "0" } })).toBeUndefined();
  });

  it("returns undefined when there is nothing usable to show", () => {
    expect(priceLabel({ id: "m" })).toBeUndefined();
    expect(priceLabel({ id: "m", pricing: {} })).toBeUndefined();
    expect(priceLabel({ id: "m", pricing: { cached: 1 } })).toBeUndefined();
    expect(priceLabel({ id: "m", free: true })).toBeUndefined();
  });

  it("ignores values that are not finite numbers >= 0", () => {
    expect(priceLabel(priced(-1, 10))).toBeUndefined();
    expect(priceLabel(priced(Number.NaN, 10))).toBeUndefined();
    expect(priceLabel({ id: "m", pricing: { input: "1", output: 2 } as never })).toBeUndefined();
    expect(priceLabel(priced(Infinity, 10))).toBeUndefined();
  });

  it("treats a price above one million dollars per 1M tokens as absent", () => {
    expect(priceLabel(priced(1e21, 2))).toBeUndefined();
    expect(priceLabel(priced(2, 1_000_001))).toBeUndefined();
    expect(priceLabel(priced(2, 1_000_000))).toBe("$2 in · $1000000 out per 1M");
    expect(priceLabel(priced(1e21, 1e21, { free: true }))).toBeUndefined();
  });

  it("localises through the function it is given", () => {
    const t = (message: string, ...args: string[]) => `<${message}|${args.join(",")}>`;
    expect(priceLabel(priced(0, 0, { free: true }), t)).toBe("<Free|>");
    expect(priceLabel(priced(1.25, 10), t)).toBe("<{0} in · {1} out per 1M|$1.25,$10>");
  });
});

describe("comboSummary", () => {
  const combo = (over: Partial<OmniRouteCombo> = {}): OmniRouteCombo => ({
    name: "c",
    strategy: "priority",
    models: [
      { kind: "model", model: "cx/gpt-test" },
      { kind: "model", model: "free/tiny" },
    ],
    ...over,
  });

  it("joins the strategy and the steps", () => {
    expect(comboSummary(combo())).toBe("priority · cx/gpt-test → free/tiny");
  });

  it("shows the name of a combo-ref step", () => {
    expect(
      comboSummary(combo({ models: [{ kind: "combo-ref", comboName: "inner" }, { kind: "model", model: "a/b" }] }))
    ).toBe("priority · inner → a/b");
  });

  it("stops after six steps with an ellipsis", () => {
    const models = Array.from({ length: 8 }, (_, i) => ({ kind: "model" as const, model: `m${i + 1}` }));
    expect(comboSummary(combo({ models }))).toBe("priority · m1 → m2 → m3 → m4 → m5 → m6 → …");
    expect(comboSummary(combo({ models: models.slice(0, 6) }))).toBe("priority · m1 → m2 → m3 → m4 → m5 → m6");
  });

  it("skips a step with no name and survives a bad strategy", () => {
    expect(
      comboSummary(combo({ models: [{ kind: "model" }, { kind: "model", model: "a/b" }] }))
    ).toBe("priority · a/b");
    expect(comboSummary(combo({ models: [{ kind: "combo-ref" }] }))).toBe("priority");
    expect(comboSummary(combo({ models: [] }))).toBe("priority");
    expect(comboSummary(combo({ strategy: undefined as never }))).toBe("combo · cx/gpt-test → free/tiny");
    expect(comboSummary(combo({ strategy: 3 as never, models: undefined as never }))).toBe("combo");
  });
});

describe("comboSummaryMarkdown", () => {
  it("puts every step in inline code and escapes the strategy", () => {
    expect(
      comboSummaryMarkdown({
        name: "c",
        strategy: "round_robin*",
        models: [
          { kind: "model", model: "cx/gpt_test*" },
          { kind: "combo-ref", comboName: "in`ner" },
        ],
      })
    ).toBe("round\\_robin\\* · `cx/gpt_test*` → `inner`");
  });

  it("keeps the ellipsis outside the code spans and handles an empty combo", () => {
    const models = Array.from({ length: 7 }, (_, i) => ({ kind: "model" as const, model: `m${i}` }));
    expect(comboSummaryMarkdown({ name: "c", strategy: "p", models })).toBe(
      "p · `m0` → `m1` → `m2` → `m3` → `m4` → `m5` → …"
    );
    expect(comboSummaryMarkdown({ name: "c", strategy: "p", models: [] })).toBe("p");
  });
});

describe("combo summaries with server-supplied text", () => {
  const withStep = (model: string, strategy = "priority"): OmniRouteCombo => ({
    name: "c",
    strategy,
    models: [{ kind: "model", model }],
  });

  it("collapses every kind of line break and whitespace run into one space", () => {
    const messy = " a\r\n\r\nb\t\tc\u2028d\u2029e  f ";
    expect(comboSummary(withStep(messy, "pri\n\n  ority"))).toBe("pri ority · a b c d e f");
    expect(comboSummaryMarkdown(withStep(messy, "pri\n\n  ority"))).toBe("pri ority · `a b c d e f`");
  });

  it("skips a step, and falls back to the default strategy, when only whitespace is left", () => {
    const combo: OmniRouteCombo = {
      name: "c",
      strategy: " \n\t ",
      models: [{ kind: "model", model: " \n " }, { kind: "model", model: "a/b" }],
    };
    expect(comboSummary(combo)).toBe("combo · a/b");
    expect(comboSummaryMarkdown(combo)).toBe("combo · `a/b`");
  });

  it("keeps a blank line and a link in a step name inside one code span", () => {
    const md = comboSummaryMarkdown(withStep("a\n\n[x](http://evil.example)\n\nb"));
    expect(md).toBe("priority · `a [x](http://evil.example) b`");
    expect(md).not.toMatch(/\n/);
    // Everything outside the code spans stays free of markdown syntax.
    expect(md.replace(/`[^`]*`/g, "")).toBe("priority · ");
  });

  it("cannot turn a strategy into a heading underline or a break", () => {
    const md = comboSummaryMarkdown(withStep("a/b", "pri\n===\n\n[x](http://evil.example)"));
    expect(md).not.toMatch(/\n/);
    const outside = md.replace(/`[^`]*`/g, "");
    expect(outside).not.toMatch(/(^|[^\\])[=\[\]()&]/);
    expect(outside).toBe("pri \\=\\=\\= \\[x\\]\\(http://evil\\.example\\) · ");
  });

  it("escapes & and = in the strategy", () => {
    expect(comboSummaryMarkdown(withStep("a/b", "a&amp;b=c"))).toBe("a\\&amp;b\\=c · `a/b`");
  });

  it("caps a step name at 80 characters and the strategy at 40, then adds an ellipsis", () => {
    const md = comboSummaryMarkdown(withStep("m".repeat(81), "s".repeat(41)));
    expect(md).toBe(`${"s".repeat(40)}… · \`${"m".repeat(80)}…\``);
    expect(comboSummaryMarkdown(withStep("m".repeat(80), "s".repeat(40)))).toBe(
      `${"s".repeat(40)} · \`${"m".repeat(80)}\``
    );
  });
});
