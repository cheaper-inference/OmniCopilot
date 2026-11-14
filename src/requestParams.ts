import type { ChatRequest } from "./types";

/** The request fields a caller can set through `modelOptions`. */
export type RequestParams = Pick<
  ChatRequest,
  | "max_tokens"
  | "temperature"
  | "top_p"
  | "stop"
  | "seed"
  | "presence_penalty"
  | "frequency_penalty"
  | "response_format"
>;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first spelling in `keys` whose value passes `accept`. */
function firstValid<T>(
  options: Record<string, unknown>,
  keys: readonly string[],
  accept: (value: unknown) => value is T
): T | undefined {
  for (const key of keys) {
    const value = options[key];
    if (accept(value)) return value;
  }
  return undefined;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isTemperature = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= 2;
const isTopP = (value: unknown): value is number => isNumber(value) && value > 0 && value <= 1;
const isPenalty = (value: unknown): value is number =>
  isNumber(value) && value >= -2 && value <= 2;
/** Beyond the safe range a number no longer round-trips through JSON as an integer (`1e21`). */
const isSeed = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isStop = (value: unknown): value is string | string[] =>
  (typeof value === "string" && value.length > 0) ||
  (Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 4 &&
    value.every((item) => typeof item === "string" && item.length > 0));
const isResponseFormat = (value: unknown): value is { type: string } =>
  isPlainObject(value) && typeof value.type === "string";

/**
 * The standard sampling parameters from what a caller passed in
 * `modelOptions`, ready to be copied into the request body. A value of the wrong
 * type or out of range is dropped (the request goes out without it) and nothing
 * outside the list is forwarded. `max_tokens` never goes above `maxOutputTokens`,
 * the limit the model was listed with.
 */
export function requestParamsFromModelOptions(
  modelOptions: unknown,
  limits: { maxOutputTokens?: number }
): RequestParams {
  if (!isPlainObject(modelOptions)) return {};
  const params: RequestParams = {};

  const maxTokens = firstValid(
    modelOptions,
    ["max_tokens", "max_completion_tokens", "maxTokens"],
    isPositiveInteger
  );
  if (maxTokens !== undefined) {
    const cap = limits.maxOutputTokens;
    params.max_tokens = isPositiveInteger(cap) ? Math.min(maxTokens, cap) : maxTokens;
  }

  if (isTemperature(modelOptions.temperature)) params.temperature = modelOptions.temperature;

  const topP = firstValid(modelOptions, ["top_p", "topP"], isTopP);
  if (topP !== undefined) params.top_p = topP;

  if (isStop(modelOptions.stop)) params.stop = modelOptions.stop;
  if (isSeed(modelOptions.seed)) params.seed = modelOptions.seed;
  if (isPenalty(modelOptions.presence_penalty)) {
    params.presence_penalty = modelOptions.presence_penalty;
  }
  if (isPenalty(modelOptions.frequency_penalty)) {
    params.frequency_penalty = modelOptions.frequency_penalty;
  }
  if (isResponseFormat(modelOptions.response_format)) {
    params.response_format = modelOptions.response_format;
  }
  return params;
}
