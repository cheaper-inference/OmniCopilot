/** Shapes exchanged with the OmniRoute OpenAI-compatible API. */

/** The `pricing` object of a priced `/v1/models` entry. The numbers are US
 * dollars per 1M tokens; `prompt` and `completion` (current servers only) are
 * dollars per token, as decimal strings. A provider that bills per request
 * keeps the numbers but has no strings, and its numbers can be zero without
 * the model being free. */
export interface OmniRoutePricing {
  input?: number;
  output?: number;
  cached?: number;
  cache_creation?: number;
  reasoning?: number;
  prompt?: string;
  completion?: string;
}

/** One entry of GET /v1/models. OmniRoute enriches the OpenAI shape with
 * capabilities and context metadata; every extra field is optional so the
 * extension also works against vanilla OpenAI-compatible servers. */
export interface OmniRouteModel {
  id: string;
  object?: string;
  owned_by?: string;
  /** Human-readable name. OmniRoute sends `name`; `display_name` is kept for
   * servers that use it and wins when both are present. */
  name?: string;
  display_name?: string;
  context_length?: number;
  /** What OmniRoute's catalog really sends for the output ceiling. */
  max_output_tokens?: number;
  /** Input ceiling, when smaller than the context window minus the output. */
  max_input_tokens?: number;
  /** OpenAI-style name for the output ceiling; read as a fallback. */
  max_completion_tokens?: number;
  /** Absent (or "chat") for conversational models; "audio", "image",
   * "embedding", "rerank", "video", "moderation"… for specialty registries
   * that must never reach the Copilot Chat picker. */
  type?: string;
  /** Endpoints the model answers on. When present and missing "chat", the
   * model is not usable from a chat request. */
  supported_endpoints?: string[];
  /** Set on a duplicate id that mirrors another entry in the same response
   * (OmniRoute `dual` prefix mode). Points at the primary id. */
  parent?: string | null;
  /** Absent when the server does not know the price. */
  pricing?: OmniRoutePricing;
  /** Set by the server on a model it lists as free. */
  free?: boolean;
  capabilities?: {
    tool_calling?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    structured_output?: boolean;
    thinking?: boolean;
    /** Reasoning tiers the model accepts, in the server's vocabulary. */
    effort_tiers?: string[];
    [key: string]: unknown;
  };
}

export interface ModelsResponse {
  object: string;
  data: OmniRouteModel[];
}

/** One step of a combo, as GET /v1/combos lists it. */
export interface OmniRouteComboStep {
  kind: "model" | "combo-ref";
  model?: string;
  comboName?: string;
  providerId?: string;
  accountPinned?: boolean;
  supportsVision?: boolean | null;
}

/** One entry of GET /v1/combos. A combo also appears in /v1/models, as a row
 * whose `id` is the combo `name`. */
export interface OmniRouteCombo {
  name: string;
  strategy: string;
  description?: string;
  models: OmniRouteComboStep[];
}

/** OpenAI Chat Completions request/stream shapes (subset we use). */

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  /** Ask for the final usage chunk (OpenAI-compatible). */
  stream_options?: { include_usage: boolean };
  tools?: ChatTool[];
  tool_choice?: "auto" | "required";
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  /** One stop sequence, or up to four. */
  stop?: string | string[];
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  /** `{ type: "json_object" }`, `{ type: "json_schema", … }`, …: passed through as given. */
  response_format?: { type: string; [key: string]: unknown };
  /** Canonical reasoning tier (none/low/medium/high/xhigh/max). OmniRoute maps it
   * onto each provider's own field — reasoning_effort, reasoning.effort or a
   * thinking budget — and an explicit value here always wins over its own
   * heuristics. Plain OpenAI-compatible servers read it natively. */
  reasoning_effort?: string;
}

/** Incremental tool-call fragment inside a stream delta. */
export interface StreamToolCallDelta {
  /** Missing on some servers, and sent as a string of digits by others; anything
   * else that is not a non-negative integer is treated as missing. */
  index?: number | string;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** One piece of a `reasoning_details` array (OpenRouter shape). Encrypted
 * reasoning carries `data` instead of readable text and is ignored. */
export interface StreamReasoningDetail {
  type?: string;
  text?: string | null;
  summary?: string | null;
}

export interface StreamDelta {
  content?: string | null;
  /** The model's reasoning, under the name DeepSeek-style servers use. */
  reasoning_content?: string | null;
  /** The same, under the name OpenRouter-style servers use. */
  reasoning?: string | null;
  /** Structured reasoning; read only when neither plain field has text. */
  reasoning_details?: StreamReasoningDetail[];
  tool_calls?: StreamToolCallDelta[];
}

/** Token accounting as reported by an OpenAI-compatible server. */
export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic-style names some gateways use. */
  input_tokens?: number;
  output_tokens?: number;
}

export interface StreamChunk {
  /** Present on the final chunk when `stream_options.include_usage` is set;
   * some servers send it with an empty `choices` array. */
  usage?: StreamUsage | null;
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  error?: StreamErrorBody;
}

/** `error` object of an OpenAI-compatible server, in a stream or an HTTP body.
 * Servers differ on which fields they send; every one is optional. OmniRoute
 * adds `reset_seconds` (and an ISO `retry_after`) to model-cooldown errors. */
export interface StreamErrorBody {
  message?: string;
  status?: number | string;
  status_code?: number | string;
  /** Numeric on some servers, a symbolic name (`model_cooldown`) on OmniRoute. */
  code?: number | string;
  retry_after_seconds?: number;
  reset_seconds?: number;
  /** ISO timestamp. */
  retry_after?: string;
}

/** Normalized streaming events yielded by the client. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  /** `cutOff`: the output limit (`finish_reason: "length"`) came before any argument
   * text (or only whitespace) arrived, so the call is incomplete; `args` is then the
   * raw text. Without the flag, a call that got no argument text has `args: "{}"`. */
  | { kind: "toolCall"; id: string; name: string; args: string; cutOff?: true }
  | { kind: "usage"; usage: StreamUsage }
  /** Why the server ended the answer (`stop`, `length`, `tool_calls`…); sent after
   * the tool calls it flushed. A stream that ends without one sends no event. */
  | { kind: "finish"; reason: string };
