import { advertisedEffortTiers } from "./reasoning";
import type { OmniRouteCombo, OmniRouteModel } from "./types";

export interface ModelShapingConfig {
  /** `omnicopilot.maxOutputTokens`: the most output the user is willing to reserve. */
  maxOutputTokens: number;
  /** `omnicopilot.defaultContextLength`: used when the catalog omits the window. */
  defaultContextLength: number;
}

export interface ModelDescription {
  name: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Tiers the catalog advertises; `undefined` when it advertises none. */
  effortTiers: string[] | undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Turn one catalog entry into the numbers and names the model picker needs.
 *
 * OmniRoute sends `name`, `max_output_tokens` and `max_input_tokens`;
 * `display_name` and `max_completion_tokens` are still read for servers that
 * use the OpenAI-style names.
 */
export function describeModel(model: OmniRouteModel, cfg: ModelShapingConfig): ModelDescription {
  const contextLength = positive(model.context_length) ?? cfg.defaultContextLength;
  const modelCeiling = positive(model.max_output_tokens) ?? positive(model.max_completion_tokens);
  // Never reserve more than half of the window: a small model with the default
  // 16k budget would otherwise be left with almost no room for the prompt.
  const maxOutputTokens = Math.max(
    Math.min(modelCeiling ?? cfg.maxOutputTokens, cfg.maxOutputTokens, Math.floor(contextLength / 2)),
    1
  );
  const maxInputTokens = Math.max(
    Math.min(contextLength - maxOutputTokens, positive(model.max_input_tokens) ?? Infinity),
    1024
  );
  const tiers = advertisedEffortTiers(model);

  return {
    name: model.display_name?.trim() || model.name?.trim() || model.id,
    contextLength,
    maxInputTokens,
    maxOutputTokens,
    effortTiers: tiers.length > 0 ? tiers : undefined,
  };
}

/** Localisation hook: the VS Code `l10n.t` shape, so this module stays free of `vscode`. */
export type Localize = (message: string, ...args: string[]) => string;

const substitute: Localize = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (match, index: string) => args[Number(index)] ?? match);

function priceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** At most four significant digits, no trailing zeros, never exponent notation. */
function formatPrice(value: number): string {
  if (value === 0) return "$0";
  const rounded = Number(value.toPrecision(4));
  const decimals = Math.min(100, Math.max(0, 3 - Math.floor(Math.log10(rounded))));
  const plain = rounded.toFixed(decimals);
  return `$${plain.includes(".") ? plain.replace(/\.?0+$/, "") : plain}`;
}

/**
 * The price shown in the model picker: "Free", or "$1.25 in · $10 out per 1M".
 *
 * `undefined` when the catalog gives no usable price. Zero is not proof of a
 * free model, because providers that bill per request report zero per-token
 * prices: "Free" needs the server to say so (`free: true`, or both per-token
 * strings "0").
 */
export function priceLabel(model: OmniRouteModel, t: Localize = substitute): string | undefined {
  const input = priceNumber(model.pricing?.input);
  const output = priceNumber(model.pricing?.output);
  if (input === undefined && output === undefined) return undefined;

  if ((input ?? 0) === 0 && (output ?? 0) === 0) {
    const provenFree =
      model.free === true || (model.pricing?.prompt === "0" && model.pricing?.completion === "0");
    return provenFree ? t("Free") : undefined;
  }
  // One side missing next to a non-zero one: the price is incomplete, show nothing.
  if (input === undefined || output === undefined) return undefined;
  return t("{0} in · {1} out per 1M", formatPrice(input), formatPrice(output));
}

const MAX_COMBO_STEPS = 6;

/** Names of the usable steps of a combo; a step without any name is skipped. */
function comboStepNames(combo: OmniRouteCombo, clean: (name: string) => string = (n) => n): string[] {
  const steps = Array.isArray(combo.models) ? combo.models : [];
  const names: string[] = [];
  for (const step of steps) {
    const preferred = step?.kind === "combo-ref" ? step.comboName : step?.model;
    const fallback = step?.kind === "combo-ref" ? step.model : step?.comboName;
    const raw = [preferred, fallback].find((n) => typeof n === "string" && n.length > 0);
    const name = raw === undefined ? "" : clean(raw);
    if (name) names.push(name);
  }
  return names;
}

function comboStrategy(combo: OmniRouteCombo): string {
  return typeof combo.strategy === "string" && combo.strategy ? combo.strategy : "combo";
}

function joinSummary(strategy: string, steps: string[], truncated: boolean): string {
  if (steps.length === 0) return strategy;
  return `${strategy} · ${steps.join(" → ")}${truncated ? " → …" : ""}`;
}

/** Plain text: "priority · cx/gpt-test → free/tiny". At most six steps. */
export function comboSummary(combo: OmniRouteCombo): string {
  const names = comboStepNames(combo);
  return joinSummary(comboStrategy(combo), names.slice(0, MAX_COMBO_STEPS), names.length > MAX_COMBO_STEPS);
}

/** The same summary as markdown, for the host's info banner: steps in inline
 * code (model ids contain `_` and `*`) and the strategy escaped. */
export function comboSummaryMarkdown(combo: OmniRouteCombo): string {
  const names = comboStepNames(combo, (name) => name.replace(/`/g, ""));
  const code = names.slice(0, MAX_COMBO_STEPS).map((name) => `\`${name}\``);
  const strategy = comboStrategy(combo).replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, "\\$&");
  return joinSummary(strategy, code, names.length > MAX_COMBO_STEPS);
}
