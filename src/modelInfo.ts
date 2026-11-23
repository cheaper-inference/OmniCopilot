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
  // The 1024 floor is deliberate: a window under 2048 tokens is far more likely a wrong or
  // missing catalog value than a real limit, so it is treated as unreliable and the request
  // still goes out; the server enforces the real limit.
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

/** No real model costs a million dollars per 1M tokens: anything above that is
 * junk, and treating it as absent also keeps `toFixed` out of exponent notation. */
const MAX_PLAUSIBLE_PRICE = 1_000_000;

function priceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PLAUSIBLE_PRICE
    ? value
    : undefined;
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
/** Caps for server text shown in the picker (banner, tooltip and detail). */
const MAX_STEP_CHARS = 80;
const MAX_STRATEGY_CHARS = 40;

/** One line: every run of whitespace (line breaks, tabs, U+2028/U+2029) becomes one space. */
function oneLine(text: string): string {
  return text.replace(/[\s\u2028\u2029]+/g, " ").trim();
}

function capped(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** C0/C1 control characters and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Server text for a plain field the picker shows (tooltip, detail): one line, no
 * control characters, at most `max` characters, and no `](` left to form a link,
 * as notifications require. */
function plainServerText(text: string, max: number): string {
  const tidy = oneLine(oneLine(text).replace(CONTROL_CHARACTERS, ""));
  return capped(tidy, max).split("](").join("] (");
}

/** A model's id (tooltip) or owner (detail line) as the picker shows it: `plainServerText`
 * with the cap of a combo step's name, which is a model id too. */
export function plainModelText(text: string): string {
  return plainServerText(text, MAX_STEP_CHARS);
}

/** Names of the usable steps of a combo; a step without any name is skipped. */
function comboStepNames(combo: OmniRouteCombo, clean: (name: string) => string = (n) => n): string[] {
  const steps = Array.isArray(combo.models) ? combo.models : [];
  const names: string[] = [];
  for (const step of steps) {
    const preferred = step?.kind === "combo-ref" ? step.comboName : step?.model;
    const fallback = step?.kind === "combo-ref" ? step.model : step?.comboName;
    const raw = [preferred, fallback].find((n) => typeof n === "string" && oneLine(n) !== "");
    const name = raw === undefined ? "" : clean(oneLine(raw));
    if (name) names.push(name);
  }
  return names;
}

function comboStrategy(combo: OmniRouteCombo): string {
  return (typeof combo.strategy === "string" && oneLine(combo.strategy)) || "combo";
}

function joinSummary(strategy: string, steps: string[], truncated: boolean): string {
  if (steps.length === 0) return strategy;
  return `${strategy} · ${steps.join(" → ")}${truncated ? " → …" : ""}`;
}

/** Plain text for the tooltip: "priority · cx/gpt-test → free/tiny". At most six
 * steps; each name and the strategy go through `plainServerText` (one line, no control
 * characters, capped, no link syntax). */
export function comboSummary(combo: OmniRouteCombo): string {
  const names = comboStepNames(combo, (name) => plainServerText(name, MAX_STEP_CHARS));
  return joinSummary(
    plainServerText(comboStrategy(combo), MAX_STRATEGY_CHARS) || "combo",
    names.slice(0, MAX_COMBO_STEPS),
    names.length > MAX_COMBO_STEPS
  );
}

/** The detail line of a combo in the picker: "combo · priority", or "combo" when the
 * server gave no strategy that is left after `plainServerText`. */
export function comboDetail(combo: OmniRouteCombo | undefined): string {
  const strategy = typeof combo?.strategy === "string" ? plainServerText(combo.strategy, MAX_STRATEGY_CHARS) : "";
  return strategy ? `combo · ${strategy}` : "combo";
}

/** The same summary as markdown, for the host's info banner. The names come
 * from the server and the host renders this field as markdown, so everything is
 * one line: steps in one inline-code span each (model ids contain `_` and `*`;
 * backticks stripped), the strategy escaped (including `&` and `=`), and both
 * capped in length. */
export function comboSummaryMarkdown(combo: OmniRouteCombo): string {
  const names = comboStepNames(combo, (name) => oneLine(name.replace(/`/g, "")));
  const code = names
    .slice(0, MAX_COMBO_STEPS)
    .map((name) => `\`${capped(name, MAX_STEP_CHARS)}\``);
  const strategy = capped(comboStrategy(combo), MAX_STRATEGY_CHARS).replace(
    /[\\`*_{}[\]()<>#+\-.!|~&=]/g,
    "\\$&"
  );
  return joinSummary(strategy, code, names.length > MAX_COMBO_STEPS);
}
