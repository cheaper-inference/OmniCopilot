import { randomBytes } from "node:crypto";
import { classifyNetworkError, type ProbeFailure, type ProbeResult } from "./diagnostics";
import { isFramingAllowed } from "./embed";
import { parseRetryAfter, retryDelayFromMessage } from "./retry";
import type {
  ChatRequest,
  ModelsResponse,
  OmniRouteCombo,
  OmniRouteModel,
  StreamChunk,
  StreamDelta,
  StreamErrorBody,
  StreamEvent,
  StreamReasoningDetail,
  StreamToolCallDelta,
} from "./types";

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** The project name to send as `x-omniroute-project` on chat requests, already
   * reduced by `projectHeaderValue`. Nothing is sent without it. */
  project?: string;
}

const USER_AGENT = "OmniCopilot-VSCode";

/** The model catalog call gives up on its own after this long. */
const MODELS_TIMEOUT_MS = 15_000;

/** The combo lookup only decorates the picker, so it must never hold it for
 * long: a server that black-holes the call costs this much, not 15 s. */
const COMBOS_TIMEOUT_MS = 3_000;

export interface RequestErrorInfo {
  /** HTTP status, from the response or from an error reported inside the stream. */
  status?: number;
  /** How long the server asked the caller to wait before trying again. */
  retryAfterMs?: number;
  /** The server could not be reached at all (no HTTP answer). */
  network?: boolean;
}

/** A request the server rejected or could not be reached for. `info` is what
 * the retry logic and the connection indicator need; the message is for people. */
export class OmniRouteRequestError extends Error {
  constructor(
    message: string,
    readonly info: RequestErrorInfo,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Server root the user configures — the `/v1` suffix is an implementation
 * detail this client appends, so it never leaks into settings or the UI. */
export const DEFAULT_BASE_URL = "http://localhost:20128";

function headers(apiKey: string | undefined, json: boolean): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": USER_AGENT };
  if (json) h["Content-Type"] = "application/json";
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

/** Longest project name sent; the server reads up to 120 characters. */
const MAX_PROJECT_HEADER_CHARS = 80;

/**
 * A workspace name as an `x-omniroute-project` value. An HTTP header value must be
 * a byte string, so every character outside printable ASCII (a letter with an
 * accent, an emoji, a line break) becomes `-`; runs of `-` and of spaces collapse,
 * the ends are trimmed of both, and the result is cut to 80 characters.
 * Undefined when nothing is left, so no header is sent.
 */
export function projectHeaderValue(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const tidy = (text: string) => text.replace(/^[- ]+|[- ]+$/g, "");
  const reduced = name
    .replace(/[^\x20-\x7E]/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/ {2,}/g, " ");
  return tidy(tidy(reduced).slice(0, MAX_PROJECT_HEADER_CHARS)) || undefined;
}

/** Normalize a user-supplied base URL for API calls: trim, drop trailing
 * slashes, ensure /v1. Accepts either form, so a stored `…:20128/v1` from an
 * older install keeps working without being doubled. */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  if (!url) return `${DEFAULT_BASE_URL}/v1`;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}

/** Base URL without the /v1 suffix (dashboard, CLI --remote flag). */
export function serverRootUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

/** Thin HTTP client for an OmniRoute (or any OpenAI-compatible) server. */
export class OmniRouteClient {
  constructor(private readonly opts: ClientOptions) {}

  get baseUrl(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  /** Fast availability probe: `HEAD /v1/models`, which OmniRoute serves explicitly. */
  async ping(timeoutMs = 4000): Promise<boolean> {
    return (await this.probe(timeoutMs)).ok;
  }

  /** Same probe as `ping`, but says why it failed. A server that answers 404,
   * 405 or 501 to HEAD (an OpenAI-compatible server without it) gets one GET. */
  async probe(timeoutMs = 4000): Promise<ProbeResult> {
    let attempt = await this.probeOnce("HEAD", timeoutMs);
    if (
      "status" in attempt &&
      (attempt.status === 404 || attempt.status === 405 || attempt.status === 501)
    ) {
      attempt = await this.probeOnce("GET", timeoutMs);
    }
    if ("failure" in attempt) return { ok: false, ...attempt };
    const { status } = attempt;
    if ((status >= 200 && status < 300) || status === 401 || status === 403) {
      return { ok: true, status };
    }
    return { ok: false, failure: "http", status };
  }

  private async probeOnce(
    method: "HEAD" | "GET",
    timeoutMs: number
  ): Promise<{ status: number } | { failure: ProbeFailure; code?: string }> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method,
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      // Only the status matters; do not hold the connection open for a body.
      void res.body?.cancel().catch(() => undefined);
      return { status: res.status };
    } catch (err) {
      return classifyNetworkError(err, timedOut);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether the dashboard may be framed by the VS Code Simple Browser.
   * Fails closed: an unreachable server is not embeddable either. */
  async canEmbedDashboard(timeoutMs = 4000): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(serverRootUrl(this.baseUrl), {
        method: "HEAD",
        redirect: "manual",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      return isFramingAllowed(res.headers);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(token?: { isCancellationRequested?: boolean }): Promise<OmniRouteModel[]> {
    // `?prefix=alias` asks OmniRoute for one id per model instead of its
    // default `dual` mode, which advertises BOTH the short alias prefix and
    // the canonical provider prefix (`cc/claude-…` *and* `claude/claude-…`)
    // for backward compatibility — that shows up as duplicates in the picker.
    // Alias mode is the safe direction: every model keeps an entry, whereas
    // `canonical` drops models whose provider has no distinct alias. Unknown
    // query params are ignored by other OpenAI-compatible servers.
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, MODELS_TIMEOUT_MS);
    const timeoutError = (cause: unknown) =>
      new OmniRouteRequestError(
        `OmniRoute /models did not answer within ${MODELS_TIMEOUT_MS / 1000} s`,
        { network: true },
        cause
      );

    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/models?prefix=alias`, {
          headers: headers(this.opts.apiKey, false),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw timedOut ? timeoutError(err) : networkError(err);
      }
      if (!res.ok) {
        throw new OmniRouteRequestError(`OmniRoute /models returned HTTP ${res.status}`, {
          status: res.status,
        });
      }
      if (token?.isCancellationRequested) return [];
      let body: ModelsResponse;
      try {
        body = (await res.json()) as ModelsResponse;
      } catch (err) {
        if (timedOut) throw timeoutError(err);
        throw err;
      }
      return Array.isArray(body.data) ? body.data : [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET /v1/combos: what each combo is made of, for the model picker.
   *
   * The picker works without it, so this never throws: a 401/403/404 (an
   * older server, or a key that may not read combos), a network error, the
   * time limit and a body of the wrong shape all give `[]`.
   */
  async listCombos(token?: { isCancellationRequested?: boolean }): Promise<OmniRouteCombo[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), COMBOS_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/combos`, {
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return [];
      }
      const body: unknown = await res.json();
      if (token?.isCancellationRequested) return [];
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return [];
      const combos: OmniRouteCombo[] = [];
      for (const entry of data) {
        if (typeof entry !== "object" || entry === null) continue;
        const raw = entry as Partial<OmniRouteCombo>;
        if (typeof raw.name !== "string") continue;
        combos.push({
          ...raw,
          name: raw.name,
          strategy: typeof raw.strategy === "string" ? raw.strategy : "",
          models: Array.isArray(raw.models) ? raw.models : [],
        });
      }
      return combos;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /chat/completions with stream:true, yielding normalized events. */
  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...headers(this.opts.apiKey, true),
          ...(this.opts.project ? { "x-omniroute-project": this.opts.project } : {}),
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (err) {
      // A cancelled request keeps propagating as an abort; anything else means
      // the server could not be reached.
      if (signal.aborted || (err as { name?: string } | null)?.name === "AbortError") throw err;
      throw networkError(err);
    }

    if (!res.ok || !res.body) {
      const { detail, retryAfterMs } = await readErrorBody(res);
      throw new OmniRouteRequestError(
        `OmniRoute request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? retryAfterMs,
        }
      );
    }

    const assembler = new ToolCallAssembler();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          // The headers arrived, then the connection dropped. A cancelled request
          // keeps propagating as an abort; anything else is a network failure
          // like one before the headers (the provider retries it while nothing
          // has reached the editor).
          if (signal.aborted || (err as { name?: string } | null)?.name === "AbortError") throw err;
          throw networkError(err);
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          yield* this.handleSseLine(line, assembler);
        }
      }
      // Flush any tool calls still being assembled when the stream ends
      // without an explicit finish_reason line.
      yield* assembler.flush();
    } finally {
      // Free the connection of an attempt that ended before the body was
      // fully read (an error inside the stream, a consumer that stopped), so
      // its socket does not linger while a retry runs. Cancelling a stream
      // that already finished is a no-op.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private *handleSseLine(line: string, assembler: ToolCallAssembler): Generator<StreamEvent> {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") yield* assembler.flush();
      return;
    }

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return; // tolerate malformed keep-alive/comment payloads
    }

    if (chunk.error?.message) {
      throw streamError(chunk.error, chunk.error.message);
    }

    if (chunk.usage && typeof chunk.usage === "object") {
      yield { kind: "usage", usage: chunk.usage };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;

    const delta = choice.delta;
    const reasoning = delta ? reasoningText(delta) : "";
    if (reasoning) {
      yield { kind: "thinking", text: reasoning };
    }
    if (delta?.content) {
      yield { kind: "text", text: delta.content };
    }
    if (delta?.tool_calls) {
      assembler.accept(delta.tool_calls);
    }
    if (choice.finish_reason) {
      yield* assembler.flush(choice.finish_reason);
      yield { kind: "finish", reason: choice.finish_reason };
    }
  }
}

/** The reasoning a delta carries: the first non-empty of `reasoning_content`,
 * `reasoning` and the readable text of `reasoning_details`. Servers that send
 * the same thought under several names would otherwise show it twice, so the
 * fields are never added together. Whitespace counts as text; a field that is
 * not a string is ignored. */
function reasoningText(delta: StreamDelta): string {
  for (const field of [delta.reasoning_content, delta.reasoning]) {
    if (typeof field === "string" && field.length > 0) return field;
  }
  const details: unknown = delta.reasoning_details;
  if (!Array.isArray(details)) return "";
  let text = "";
  for (const entry of details as Array<StreamReasoningDetail | null>) {
    if (typeof entry !== "object" || entry === null) continue;
    if (typeof entry.text === "string" && entry.text.length > 0) text += entry.text;
    else if (typeof entry.summary === "string" && entry.summary.length > 0) text += entry.summary;
  }
  return text;
}

interface ToolCallSlot {
  id: string;
  name: string;
  args: string;
}

/** The slot number of a delta: a non-negative integer, or a string of digits
 * (some servers send `"0"`); anything else is no index. */
function deltaIndex(index: unknown): number | undefined {
  if (typeof index === "number") return Number.isInteger(index) ? index : undefined;
  if (typeof index === "string" && /^\d+$/.test(index)) return Number(index);
  return undefined;
}

/** Reassembles incremental tool_calls deltas into complete calls, emitted once
 * their JSON arguments are whole.
 *
 * A delta with an index is routed among the slots opened under that index and
 * never leaves it, so an id cannot reach across indexes. Inside a scope: to the
 * slot that has the delta's id; to a new slot when its id is new there and it
 * names a function, as a new call must; otherwise to the slot opened last (a
 * continuation, which keeps its first id), or a new one when there is none.
 *
 * A delta without an index is routed the same way among the slots opened
 * without one. When there are none (the server sent the index only on the first
 * fragment), it continues the single slot that has its id, else a new indexless
 * slot is opened for a new id that names a function, else it continues the slot
 * opened last. Servers do not agree on any of this: some leave `index` out, some
 * reuse one index for several calls, some stamp a new id on every fragment of one
 * call, some label calls on different indexes with one id, and some repeat the
 * whole name in every delta. */
class ToolCallAssembler {
  /** Every slot, in the order it was opened. */
  private slots: ToolCallSlot[] = [];
  /** The slots of each scope (an index, or "none"), in the order they were opened. */
  private scopes = new Map<number | "none", ToolCallSlot[]>();

  /** The slot a delta belongs to, or undefined when it opens a new one. */
  private route(scope: number | "none", id: string, name: string): ToolCallSlot | undefined {
    const inScope = this.scopes.get(scope) ?? [];
    if (scope === "none" && inScope.length === 0) return this.routeWithoutIndex(id, name);

    const known = id ? inScope.find((candidate) => candidate.id === id) : undefined;
    if (known) return known;
    const last = inScope[inScope.length - 1];
    // A new id on a call that already has another id starts a call only if the
    // delta names a function too.
    return last && id && last.id && name ? undefined : last;
  }

  /** An indexless delta when no slot was opened without an index. */
  private routeWithoutIndex(id: string, name: string): ToolCallSlot | undefined {
    const last = this.slots[this.slots.length - 1];
    if (!id) return last;
    const owners = this.slots.filter((candidate) => candidate.id === id);
    if (owners.length === 1) {
      // Naming a function that does not continue this call's name is a new call
      // that happens to repeat the id.
      const [owner] = owners;
      return name && owner.name && !name.startsWith(owner.name) ? undefined : owner;
    }
    if (owners.length === 0 && name) return undefined;
    return last;
  }

  accept(deltas: StreamToolCallDelta[]): void {
    for (const d of deltas) {
      const id = typeof d.id === "string" ? d.id : "";
      const name = typeof d.function?.name === "string" ? d.function.name : "";
      const scope = deltaIndex(d.index) ?? "none";

      let slot = this.route(scope, id, name);
      if (!slot) {
        slot = { id: "", name: "", args: "" };
        this.slots.push(slot);
        const inScope = this.scopes.get(scope);
        if (inScope) inScope.push(slot);
        else this.scopes.set(scope, [slot]);
      }
      if (id && !slot.id) slot.id = id;

      if (name) {
        // Same rule as the server's own bookkeeping: a name that repeats or
        // extends what was collected replaces it, anything else is appended.
        // That cannot tell `a` + `ab` (one name, two fragments) from the name
        // `a` followed by a fragment `ab`; it is the server's reading too, so
        // leave it alone.
        slot.name = slot.name && name.startsWith(slot.name) ? name : slot.name + name;
      }
      if (d.function?.arguments) slot.args += d.function.arguments;
    }
  }

  /** Emit the assembled calls. `finishReason` is the reason the server gave with the
   * flush, if any: with `length`, a call that got no argument text was cut off before
   * its first argument (a tool without parameters is told apart only by the reason). */
  *flush(finishReason?: string): Generator<StreamEvent> {
    for (const call of this.slots) {
      if (!call.name) continue;
      // Some servers never send an id; the editor needs one to pair the call
      // with its result, so make one up rather than dropping the call.
      const id = call.id || `call_${randomBytes(4).toString("hex")}`;
      if (finishReason === "length" && call.args.trim() === "") {
        yield { kind: "toolCall", id, name: call.name, args: call.args, cutOff: true };
      } else {
        yield { kind: "toolCall", id, name: call.name, args: call.args || "{}" };
      }
    }
    this.slots = [];
    this.scopes.clear();
  }
}

/** Error message and retry hint from the JSON body of a rejected request. */
async function readErrorBody(res: Response): Promise<{ detail: string; retryAfterMs?: number }> {
  try {
    const text = await res.text();
    const { error } = JSON.parse(text) as { error?: StreamErrorBody };
    return {
      detail: error?.message ?? text.slice(0, 200),
      retryAfterMs: error && typeof error === "object" ? retryHint(error) : undefined,
    };
  } catch {
    return { detail: "" };
  }
}

/** Wait the server asks for in an error object: OmniRoute's `reset_seconds`,
 * the generic `retry_after_seconds`, or an ISO `retry_after` timestamp. */
function retryHint(error: StreamErrorBody): number | undefined {
  return (
    secondsToMs(error.reset_seconds) ??
    secondsToMs(error.retry_after_seconds) ??
    (typeof error.retry_after === "string" ? parseRetryAfter(error.retry_after) : undefined)
  );
}

function secondsToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : undefined;
}

/** An HTTP-looking status: a number, or digits in a string. A symbolic code
 * such as `model_cooldown` is not one. */
function asStatus(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}

/** An error the server reported inside an otherwise healthy 200 stream. Its
 * HTTP-style status comes from the error object, else from the first `[503]`
 * in the message; the retry hint from the object, else from `(reset after 24s)`. */
function streamError(error: StreamErrorBody, message: string): OmniRouteRequestError {
  const inMessage = /\[(\d{3})\]/.exec(message);
  return new OmniRouteRequestError(message, {
    status:
      asStatus(error.status) ??
      asStatus(error.status_code) ??
      asStatus(error.code) ??
      (inMessage ? Number(inMessage[1]) : undefined),
    retryAfterMs: retryHint(error) ?? retryDelayFromMessage(message),
  });
}

/** `fetch` rejected without an HTTP answer. Node reports `TypeError: fetch
 * failed` and keeps the real reason (ECONNREFUSED, ENOTFOUND…) in `cause`. */
function networkError(err: unknown): OmniRouteRequestError {
  const reason = errorText(err);
  const cause = err instanceof Error ? errorText(err.cause) : "";
  const detail = [reason, cause].filter(Boolean).join(": ");
  return new OmniRouteRequestError(
    `OmniRoute request failed (network error)${detail ? `: ${detail}` : ""}`,
    { network: true },
    err
  );
}

function errorText(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0 && !err.message) {
    return errorText(err.errors[0]);
  }
  if (err instanceof Error) return err.message || (err as NodeJS.ErrnoException).code || "";
  return "";
}
