import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  OmniRouteClient,
  OmniRouteRequestError,
  normalizeBaseUrl,
  projectHeaderValue,
  serverRootUrl,
} from "../src/client";
import type { StreamEvent } from "../src/types";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(client: OmniRouteClient): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const ctrl = new AbortController();
  for await (const e of client.streamChat(
    { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    ctrl.signal
  )) {
    events.push(e);
  }
  return events;
}

describe("OmniRouteClient.streamChat", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("yields text deltas from SSE chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
  });

  it("yields usage from a final chunk with empty choices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "text", text: "ok" },
      { kind: "usage", usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]);
  });

  it("yields usage when it rides on the finish_reason chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":407,"completion_tokens":169,"total_tokens":576}}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "usage", usage: { prompt_tokens: 407, completion_tokens: 169, total_tokens: 576 } },
      { kind: "finish", reason: "stop" },
    ]);
  });

  it("reassembles fragmented tool calls and flushes on finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "toolCall", id: "c1", name: "read_file", args: '{"path":"a"}' },
      { kind: "finish", reason: "tool_calls" },
    ]);
  });

  it("flushes pending tool calls when the stream ends without finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"run","arguments":"{}"}}]}}]}',
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "toolCall", id: "c9", name: "run", args: "{}" }]);
  });

  it("throws with the upstream error message on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 })
      )
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      /HTTP 404.*no such model/
    );
  });

  it("surfaces in-stream error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['data: {"error":{"message":"rate limited"}}']))
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "rate limited"
    );
  });

  it("cancels the body of an attempt that ends on an in-stream error", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // The server sends the error and keeps the connection open.
        controller.enqueue(
          new TextEncoder().encode('data: {"error":{"message":"rate limited"}}\n')
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "rate limited"
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  /** A 200 answer whose connection drops after `lines` were delivered. */
  function droppedResponse(lines: string[], failure: unknown = new TypeError("terminated")): Response {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < lines.length) controller.enqueue(new TextEncoder().encode(`${lines[sent++]}\n`));
        else controller.error(failure);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("reports a connection dropped while the answer is read as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(droppedResponse([])));
    const error = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" })).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(OmniRouteRequestError);
    expect((error as OmniRouteRequestError).info.network).toBe(true);
    expect((error as OmniRouteRequestError).message).toMatch(/network error.*terminated/);
  });

  it("still delivers what arrived before the connection dropped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        droppedResponse(['data: {"choices":[{"delta":{"content":"par"}}]}'])
      )
    );
    const seen: StreamEvent[] = [];
    const ctrl = new AbortController();
    const run = async () => {
      for await (const e of new OmniRouteClient({ baseUrl: "http://x/v1" }).streamChat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        ctrl.signal
      )) {
        seen.push(e);
      }
    };
    await expect(run()).rejects.toMatchObject({ info: { network: true } });
    expect(seen).toEqual([{ kind: "text", text: "par" }]);
  });

  it("keeps a cancelled read an abort, not a network failure", async () => {
    const ctrl = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        ctrl.abort();
        controller.error(abortError);
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const run = async () => {
      for await (const e of new OmniRouteClient({ baseUrl: "http://x/v1" }).streamChat(
        { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
        ctrl.signal
      )) {
        void e;
      }
    };
    const error = await run().then(
      () => undefined,
      (err: unknown) => err
    );
    expect(error).toBe(abortError);
  });

  it("ignores malformed keep-alive lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          ": keep-alive",
          "data: not-json",
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "text", text: "ok" }]);
  });

  it("sends Authorization only when an API key is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    await collect(new OmniRouteClient({ baseUrl: "http://x/v1", apiKey: "sk-1" }));
    let headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(sseResponse(["data: [DONE]"]));
    await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("OmniRouteClient.streamChat reasoning", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Streams the given deltas, one chunk each, and returns the events. */
  async function streamDeltas(...deltas: unknown[]): Promise<StreamEvent[]> {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            ...deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}`),
            "data: [DONE]",
          ])
        )
    );
    return collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
  }

  it("yields reasoning_content as thinking", async () => {
    const events = await streamDeltas(
      { reasoning_content: "Let me " },
      { reasoning_content: "think." },
      { content: "Done." }
    );
    expect(events).toEqual([
      { kind: "thinking", text: "Let me " },
      { kind: "thinking", text: "think." },
      { kind: "text", text: "Done." },
    ]);
  });

  it("yields reasoning when reasoning_content is absent", async () => {
    expect(await streamDeltas({ reasoning: "step one" })).toEqual([
      { kind: "thinking", text: "step one" },
    ]);
    expect(await streamDeltas({ reasoning_content: "", reasoning: "step two" })).toEqual([
      { kind: "thinking", text: "step two" },
    ]);
    expect(await streamDeltas({ reasoning_content: null, reasoning: "step three" })).toEqual([
      { kind: "thinking", text: "step three" },
    ]);
  });

  it("falls back to reasoning_details text", async () => {
    const events = await streamDeltas({
      reasoning_details: [
        { type: "reasoning.text", text: "first " },
        { type: "reasoning.encrypted", data: "opaque" },
        { type: "reasoning.text", text: "second" },
      ],
    });
    expect(events).toEqual([{ kind: "thinking", text: "first second" }]);
  });

  it("falls back to the summary of a reasoning_details entry that has no text", async () => {
    const events = await streamDeltas({
      reasoning_details: [
        { type: "reasoning.summary", summary: "In short, " },
        { type: "reasoning.text", text: "", summary: "it works." },
        { type: "reasoning.text", text: "text wins", summary: "ignored" },
      ],
    });
    expect(events).toEqual([{ kind: "thinking", text: "In short, it works.text wins" }]);
  });

  it("yields nothing for encrypted-only reasoning_details", async () => {
    const events = await streamDeltas({
      reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }, {}],
    });
    expect(events).toEqual([]);
  });

  it("does not duplicate reasoning that arrives in two fields of the same delta", async () => {
    const events = await streamDeltas({
      reasoning_content: "same thought",
      reasoning: "same thought",
      reasoning_details: [{ type: "reasoning.text", text: "same thought" }],
    });
    expect(events).toEqual([{ kind: "thinking", text: "same thought" }]);

    const second = await streamDeltas({
      reasoning: "from reasoning",
      reasoning_details: [{ type: "reasoning.text", text: "from details" }],
    });
    expect(second).toEqual([{ kind: "thinking", text: "from reasoning" }]);
  });

  it("keeps whitespace-only reasoning, which is real text", async () => {
    expect(await streamDeltas({ reasoning_content: "\n" })).toEqual([
      { kind: "thinking", text: "\n" },
    ]);
  });

  it("ignores reasoning fields that are not strings or not arrays", async () => {
    const events = await streamDeltas(
      { reasoning_content: 42, reasoning: { text: "x" }, reasoning_details: "nope" },
      { reasoning_details: { text: "x" } },
      { reasoning_details: [null, 7, "x", { text: 3, summary: {} }] },
      { content: "still fine" }
    );
    expect(events).toEqual([{ kind: "text", text: "still fine" }]);
  });

  it("yields the thinking event before the text of the same delta", async () => {
    const events = await streamDeltas({ reasoning_content: "hm", content: "Answer" });
    expect(events).toEqual([
      { kind: "thinking", text: "hm" },
      { kind: "text", text: "Answer" },
    ]);
  });
});

describe("OmniRouteClient.streamChat errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function failure(client: OmniRouteClient): Promise<OmniRouteRequestError> {
    try {
      await collect(client);
    } catch (err) {
      expect(err).toBeInstanceOf(OmniRouteRequestError);
      return err as OmniRouteRequestError;
    }
    throw new Error("expected the request to fail");
  }

  const client = () => new OmniRouteClient({ baseUrl: "http://x/v1" });
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it("carries the status and Retry-After of a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: { message: "All credentials for model m are cooling down" } }, 429, {
          "Retry-After": "24",
        })
      )
    );
    const err = await failure(client());
    expect(err.info).toEqual({ status: 429, retryAfterMs: 24_000 });
    expect(err.message).toBe(
      "OmniRoute request failed (HTTP 429): All credentials for model m are cooling down"
    );
  });

  it("falls back to the reset hint in the body when there is no Retry-After header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: { message: "cooling down", code: "model_cooldown", reset_seconds: 7 } }, 429)
      )
    );
    expect((await failure(client())).info).toEqual({ status: 429, retryAfterMs: 7_000 });
  });

  it("reads retry_after_seconds and an ISO retry_after from the body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "busy", retry_after_seconds: 3 } }, 503)
    );
    expect((await failure(client())).info.retryAfterMs).toBe(3_000);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "busy", retry_after: "2026-11-14T12:00:09Z" } }, 429)
    );
    expect((await failure(client())).info.retryAfterMs).toBe(9_000);
  });

  it("prefers the Retry-After header over the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ error: { message: "x", reset_seconds: 99 } }, 429, { "Retry-After": "2" })
      )
    );
    expect((await failure(client())).info.retryAfterMs).toBe(2_000);
  });

  it("has no retry hint on an error that carries none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: { message: "no such model" } }, 404))
    );
    expect((await failure(client())).info).toEqual({ status: 404, retryAfterMs: undefined });
  });

  it("carries the status and reset hint of an error that arrives inside the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"error":{"message":"[x/y] [503]: busy (reset after 24s)"}}'])
      )
    );
    const err = await failure(client());
    expect(err.info).toEqual({ status: 503, retryAfterMs: 24_000 });
    expect(err.message).toBe("[x/y] [503]: busy (reset after 24s)");
  });

  it("prefers the fields of an in-stream error over its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"error":{"message":"[503]: busy (reset after 24s)","status":429,"retry_after_seconds":3}}',
        ])
      )
    );
    expect((await failure(client())).info).toEqual({ status: 429, retryAfterMs: 3_000 });
  });

  it("reads the status of an in-stream error from status_code or a numeric code", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      sseResponse(['data: {"error":{"message":"x","status_code":502}}'])
    );
    expect((await failure(client())).info.status).toBe(502);
    fetchMock.mockResolvedValueOnce(sseResponse(['data: {"error":{"message":"x","code":504}}']));
    expect((await failure(client())).info.status).toBe(504);
    // a symbolic code is not a status
    fetchMock.mockResolvedValueOnce(
      sseResponse(['data: {"error":{"message":"x","code":"model_cooldown"}}'])
    );
    expect((await failure(client())).info.status).toBeUndefined();
  });

  it("reads the reset hint OmniRoute puts in an in-stream error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"error":{"message":"cooling down","reset_seconds":5}}'])
      )
    );
    expect((await failure(client())).info.retryAfterMs).toBe(5_000);
  });

  it("marks a failed fetch as a network error and keeps the cause", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:20128");
    const failed = new TypeError("fetch failed", { cause });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failed));
    const err = await failure(client());
    expect(err.info).toEqual({ network: true });
    expect(err.cause).toBe(failed);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("lets an aborted request propagate untouched", async () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(collect(client())).rejects.toBe(aborted);
  });

  it("keeps a tool call that arrives without an id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"run","arguments":"{}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(client());
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ kind: "finish", reason: "tool_calls" });
    expect(events[0]).toMatchObject({ kind: "toolCall", name: "run", args: "{}" });
    expect((events[0] as { id: string }).id).toMatch(/^call_[0-9a-f]{8}$/);
  });

  it("still drops a fragment that never got a name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"arguments":"{}"}}]}}]}',
          "data: [DONE]",
        ])
      )
    );
    expect(await collect(client())).toEqual([]);
  });
});

describe("OmniRouteClient.streamChat tool-call assembly", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** One SSE line carrying the given tool_calls deltas. */
  const toolDelta = (...deltas: unknown[]) =>
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: deltas } }] })}`;
  const finish = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}';

  async function toolCalls(lines: string[]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([...lines, finish, "data: [DONE]"])));
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    return events.filter((e) => e.kind === "toolCall");
  }

  it("marks a call that got no argument text before the output limit as cut off", async () => {
    const cutAt = (reason: string) => `data: {"choices":[{"delta":{},"finish_reason":"${reason}"}]}`;
    const run = async (args: string, reason: string) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          sseResponse([toolDelta({ index: 0, id: "a", function: { name: "run", arguments: args } }), cutAt(reason)])
        )
      );
      const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
      return events.filter((e) => e.kind === "toolCall");
    };

    expect(await run("", "length")).toEqual([{ kind: "toolCall", id: "a", name: "run", args: "", cutOff: true }]);
    expect(await run(" \n", "length")).toEqual([{ kind: "toolCall", id: "a", name: "run", args: " \n", cutOff: true }]);
    // Any other reason: a tool without parameters.
    expect(await run("", "tool_calls")).toEqual([{ kind: "toolCall", id: "a", name: "run", args: "{}" }]);
    expect(await run("", "stop")).toEqual([{ kind: "toolCall", id: "a", name: "run", args: "{}" }]);
    // Argument text that arrived is the provider's to judge, whatever the reason.
    expect(await run('{"x":1}', "length")).toEqual([{ kind: "toolCall", id: "a", name: "run", args: '{"x":1}' }]);
  });

  it("keeps two calls apart when the deltas carry no index", async () => {
    const calls = await toolCalls([
      toolDelta({ id: "a", function: { name: "read_file", arguments: '{"p":1}' } }),
      toolDelta({ id: "b", function: { name: "list_dir", arguments: '{"d":2}' } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("follows the id for the fragments of an indexless call", async () => {
    const calls = await toolCalls([
      toolDelta({ id: "a", function: { name: "read_file", arguments: '{"p"' } }),
      toolDelta({ id: "b", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ id: "a", function: { arguments: ":1}" } }),
      toolDelta({ id: "b", function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("continues the latest call with a delta that has neither index nor id", async () => {
    const calls = await toolCalls([
      toolDelta({ id: "a", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ function: { arguments: ":1}" } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "a", name: "run", args: '{"x":1}' }]);
  });

  it("opens a new call when a different id arrives under the same index", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p":1}' } }),
      toolDelta({ index: 0, id: "b", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ index: 0, function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("keeps a name that is re-sent whole in every delta", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p"' } }),
      toolDelta({ index: 0, function: { name: "read_file", arguments: ':1}' } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' }]);
  });

  it("replaces a partial name with a longer one that starts with it", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "read", arguments: "{}" } }),
      toolDelta({ index: 0, function: { name: "read_file" } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "a", name: "read_file", args: "{}" }]);
  });

  it("flushes the calls in the order they were opened", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 1, id: "b", function: { name: "second", arguments: "{}" } }),
      toolDelta({ index: 0, id: "a", function: { name: "first", arguments: "{}" } }),
    ]);
    expect(calls.map((c) => (c as { name: string }).name)).toEqual(["second", "first"]);
  });

  it("keeps the first id when a server stamps a fresh id on every fragment of one call", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "t1", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ index: 0, id: "t2", function: { arguments: ":1," } }),
      toolDelta({ index: 0, id: "t3", function: { arguments: '"y":2}' } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "t1", name: "run", args: '{"x":1,"y":2}' }]);
  });

  it("does the same without an index", async () => {
    const calls = await toolCalls([
      toolDelta({ id: "t1", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ id: "t2", function: { arguments: ":1}" } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "t1", name: "run", args: '{"x":1}' }]);
  });

  it("opens a new call for a different id only when the delta names a function", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "first", arguments: "{}" } }),
      toolDelta({ index: 0, id: "b", function: { name: "", arguments: "" } }),
      toolDelta({ index: 0, id: "c", function: { name: "second", arguments: "{}" } }),
    ]);
    expect(calls.map((c) => (c as { id: string }).id)).toEqual(["a", "c"]);
  });

  it("sends a fragment to the call of the id it carries, whatever index it has", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p"' } }),
      toolDelta({ index: 0, id: "b", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ index: 0, id: "a", function: { arguments: ":1}" } }),
      toolDelta({ index: 0, id: "b", function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("never lets an id reach across indexes: one id on two indexes is two calls", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "same", function: { name: "read_file", arguments: '{"p"' } }),
      toolDelta({ index: 1, id: "same", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ index: 0, id: "same", function: { arguments: ":1}" } }),
      toolDelta({ index: 1, id: "same", function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "same", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "same", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("finds a call again by its id when a later fragment carries no index", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ index: 1, id: "b", function: { name: "other", arguments: "{}" } }),
      toolDelta({ id: "a", function: { arguments: ":1}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "run", args: '{"x":1}' },
      { kind: "toolCall", id: "b", name: "other", args: "{}" },
    ]);
  });

  it("continues the one open call from fragments that carry neither index nor id", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ function: { arguments: ":1," } }),
      toolDelta({ function: { arguments: '"y":2}' } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "a", name: "run", args: '{"x":1,"y":2}' }]);
  });

  it("sends id-carrying indexless fragments to their own indexed calls", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p"' } }),
      toolDelta({ index: 1, id: "b", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ id: "a", function: { arguments: ":1}" } }),
      toolDelta({ id: "b", function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("sends an indexless fragment whose id matches two indexed calls to the one opened last", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "same", function: { name: "read_file", arguments: '{"p":1}' } }),
      toolDelta({ index: 1, id: "same", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ id: "same", function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "same", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "same", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("opens an indexless call for a new id that names a function, next to indexed ones", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "first", arguments: "{}" } }),
      toolDelta({ id: "b", function: { name: "second", arguments: "{}" } }),
    ]);
    expect(calls.map((c) => (c as { name: string }).name)).toEqual(["first", "second"]);
  });

  it("keeps an indexed call apart from an indexless one that carries the same id", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "same", function: { name: "indexed", arguments: "{}" } }),
      toolDelta({ id: "same", function: { name: "plain", arguments: "{}" } }),
    ]);
    expect(calls.map((c) => (c as { name: string }).name)).toEqual(["indexed", "plain"]);
  });

  it("routes by id among the calls of one index and among the indexless ones", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, id: "a", function: { name: "x", arguments: '{"p"' } }),
      toolDelta({ index: 0, id: "b", function: { name: "y", arguments: '{"q"' } }),
      toolDelta({ id: "c", function: { name: "u", arguments: '{"r"' } }),
      toolDelta({ id: "d", function: { name: "v", arguments: '{"s"' } }),
      toolDelta({ index: 0, id: "a", function: { arguments: ":1}" } }),
      toolDelta({ id: "c", function: { arguments: ":3}" } }),
      toolDelta({ index: 0, id: "b", function: { arguments: ":2}" } }),
      toolDelta({ id: "d", function: { arguments: ":4}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "x", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "y", args: '{"q":2}' },
      { kind: "toolCall", id: "c", name: "u", args: '{"r":3}' },
      { kind: "toolCall", id: "d", name: "v", args: '{"s":4}' },
    ]);
  });

  it("reads an index sent as a string of digits as that integer", async () => {
    const calls = await toolCalls([
      toolDelta({ index: "0", id: "a", function: { name: "read_file", arguments: '{"p"' } }),
      toolDelta({ index: "1", id: "b", function: { name: "list_dir", arguments: '{"d"' } }),
      toolDelta({ index: "0", function: { arguments: ":1}" } }),
      toolDelta({ index: "1", function: { arguments: ":2}" } }),
    ]);
    expect(calls).toEqual([
      { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
      { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
    ]);
  });

  it("mixes a string index with an integer one for the same call", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 3, id: "a", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ index: "3", function: { arguments: ":1}" } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "a", name: "run", args: '{"x":1}' }]);
  });

  it.each([["x1"], [""], ["-1"], ["1.5"]])("treats the index %j as missing", async (index) => {
    const calls = await toolCalls([
      toolDelta({ index, id: "a", function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ function: { arguments: ":1}" } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "a", name: "run", args: '{"x":1}' }]);
  });

  it("still assembles every input the first version of the rule was written for", async () => {
    const scenarios: Array<[string[], unknown[]]> = [
      [
        [
          toolDelta({ id: "a", function: { name: "read_file", arguments: '{"p":1}' } }),
          toolDelta({ id: "b", function: { name: "list_dir", arguments: '{"d":2}' } }),
        ],
        [
          { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
          { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
        ],
      ],
      [
        [
          toolDelta({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p":1}' } }),
          toolDelta({ index: 0, id: "b", function: { name: "list_dir", arguments: '{"d"' } }),
          toolDelta({ index: 0, function: { arguments: ":2}" } }),
        ],
        [
          { kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' },
          { kind: "toolCall", id: "b", name: "list_dir", args: '{"d":2}' },
        ],
      ],
      [
        [
          toolDelta({ index: 0, id: "a", function: { name: "read_file", arguments: '{"p"' } }),
          toolDelta({ index: 0, function: { name: "read_file", arguments: ":1}" } }),
        ],
        [{ kind: "toolCall", id: "a", name: "read_file", args: '{"p":1}' }],
      ],
      [
        [
          toolDelta({ index: 0, function: { name: "run", arguments: '{"x"' } }),
          toolDelta({ index: 0, id: "late", function: { arguments: ":1}" } }),
        ],
        [{ kind: "toolCall", id: "late", name: "run", args: '{"x":1}' }],
      ],
    ];
    for (const [lines, expected] of scenarios) {
      expect(await toolCalls(lines)).toEqual(expected);
    }
  });

  it("is one call when the id only shows up in a later delta", async () => {
    const calls = await toolCalls([
      toolDelta({ index: 0, function: { name: "run", arguments: '{"x"' } }),
      toolDelta({ index: 0, id: "late", function: { arguments: ":1}" } }),
    ]);
    expect(calls).toEqual([{ kind: "toolCall", id: "late", name: "run", args: '{"x":1}' }]);
  });
});

describe("OmniRouteClient.streamChat finish reason", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the finish_reason after the tool calls it flushed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"run","arguments":"{}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "toolCall", id: "c1", name: "run", args: "{}" },
      { kind: "finish", reason: "length" },
    ]);
  });

  it("reports no finish event for a stream that ended without a finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}']))
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
  });
});

describe("normalizeBaseUrl / serverRootUrl", () => {
  it("appends /v1 to a bare server root (the new default shape)", () => {
    expect(normalizeBaseUrl("http://localhost:20128")).toBe("http://localhost:20128/v1");
  });

  it("does not double /v1 when the user pasted it (older stored settings)", () => {
    expect(normalizeBaseUrl("http://localhost:20128/v1")).toBe("http://localhost:20128/v1");
    expect(normalizeBaseUrl("http://localhost:20128/v1/")).toBe("http://localhost:20128/v1");
  });

  it("adds a scheme and trims trailing slashes", () => {
    expect(normalizeBaseUrl("192.168.0.17:20128//")).toBe("http://192.168.0.17:20128/v1");
  });

  it("falls back to the default server root when empty", () => {
    expect(normalizeBaseUrl("  ")).toBe(`${DEFAULT_BASE_URL}/v1`);
  });

  it("serverRootUrl strips /v1 back off for the dashboard and CLI bridge", () => {
    expect(serverRootUrl("http://192.168.0.17:20128/v1")).toBe("http://192.168.0.17:20128");
    expect(serverRootUrl("http://192.168.0.17:20128")).toBe("http://192.168.0.17:20128");
  });
});

describe("OmniRouteClient.listModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for one id per model (?prefix=alias) so dual-mode mirrors never reach the picker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: "list", data: [{ id: "a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await new OmniRouteClient({ baseUrl: "http://x" }).listModels();

    expect(fetchMock.mock.calls[0][0]).toBe("http://x/v1/models?prefix=alias");
    expect(models.map((m) => m.id)).toEqual(["a"]);
  });

  it("throws with the status when the catalog call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    await expect(new OmniRouteClient({ baseUrl: "http://x" }).listModels()).rejects.toThrow("401");
  });

  it("reports a rejected catalog call as a request error with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const err = await new OmniRouteClient({ baseUrl: "http://x" }).listModels().catch((e) => e);
    expect(err).toBeInstanceOf(OmniRouteRequestError);
    expect(err.info).toEqual({ status: 401 });
  });

  it("marks an unreachable server as a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))
    );
    const err = await new OmniRouteClient({ baseUrl: "http://x" }).listModels().catch((e) => e);
    expect(err).toBeInstanceOf(OmniRouteRequestError);
    expect(err.info).toEqual({ network: true });
  });

  it("gives up by itself after 15 seconds and calls that a network error", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("This operation was aborted", "AbortError"))
              );
            })
        )
      );
      const pending = new OmniRouteClient({ baseUrl: "http://x" })
        .listModels()
        .catch((e) => e as OmniRouteRequestError);
      await vi.advanceTimersByTimeAsync(14_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await pending;
      expect(err).toBeInstanceOf(OmniRouteRequestError);
      expect(err.info).toEqual({ network: true });
      expect(err.message).toContain("15");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OmniRouteClient.listCombos", () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads /v1/combos and keeps only entries with a name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        object: "list",
        data: [
          { name: "fast", strategy: "priority", description: "d", models: [{ kind: "model", model: "a/b" }] },
          { strategy: "priority", models: [] },
          "junk",
          null,
          { name: "bare" },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const combos = await new OmniRouteClient({ baseUrl: "http://x", apiKey: "k" }).listCombos();

    expect(fetchMock.mock.calls[0][0]).toBe("http://x/v1/combos");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
    expect(combos).toEqual([
      { name: "fast", strategy: "priority", description: "d", models: [{ kind: "model", model: "a/b" }] },
      { name: "bare", strategy: "", models: [] },
    ]);
  });

  it.each([401, 403, 404, 500])("returns [] on HTTP %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status })));
    expect(await new OmniRouteClient({ baseUrl: "http://x" }).listCombos()).toEqual([]);
  });

  it("returns [] on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await new OmniRouteClient({ baseUrl: "http://x" }).listCombos()).toEqual([]);
  });

  it("returns [] on a malformed body", async () => {
    for (const body of [null, [], "text", { data: "x" }, { object: "list" }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
      expect(await new OmniRouteClient({ baseUrl: "http://x" }).listCombos()).toEqual([]);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    expect(await new OmniRouteClient({ baseUrl: "http://x" }).listCombos()).toEqual([]);
  });

  it("gives up by itself after 3 seconds, aborts the request and returns []", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              signal = init.signal ?? undefined;
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("This operation was aborted", "AbortError"))
              );
            })
        )
      );
      const pending = new OmniRouteClient({ baseUrl: "http://x" }).listCombos();
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual([]);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("projectHeaderValue", () => {
  it("keeps a plain ASCII name as it is", () => {
    expect(projectHeaderValue("my-project")).toBe("my-project");
    expect(projectHeaderValue("acme api (Workspace)")).toBe("acme api (Workspace)");
  });

  it("replaces each non-ASCII character with a hyphen, so the value is a byte string", () => {
    expect(projectHeaderValue("São Paulo")).toBe("S-o Paulo");
    expect(projectHeaderValue("rocket \u{1F680} app")).toBe("rocket - app");
    expect(projectHeaderValue("ação-2")).toBe("a-o-2");
  });

  it("sends nothing for a name made only of non-ASCII characters", () => {
    expect(projectHeaderValue("项目")).toBeUndefined();
    expect(projectHeaderValue("\u{1F680}\u{1F680}")).toBeUndefined();
  });

  it("turns line breaks and other control characters into hyphens that cannot split a header", () => {
    const value = projectHeaderValue("a\r\nX-Evil: 1\tb\u0000c");
    expect(value).toBe("a-X-Evil: 1-b-c");
    expect(value).toMatch(/^[\x20-\x7E]+$/);
  });

  it("collapses runs of hyphens and of spaces, and trims the ends", () => {
    expect(projectHeaderValue("  a    b  ")).toBe("a b");
    expect(projectHeaderValue("a\u00e9\u00e9\u00e9b")).toBe("a-b");
    expect(projectHeaderValue("--a--")).toBe("a");
    expect(projectHeaderValue("caf\u00e9")).toBe("caf");
  });

  it("cuts a long name to 80 characters without leaving a dangling separator", () => {
    expect(projectHeaderValue("x".repeat(200))).toBe("x".repeat(80));
    expect(projectHeaderValue(`${"x".repeat(79)} tail`)).toBe("x".repeat(79));
  });

  it("sends nothing for an empty or missing name", () => {
    expect(projectHeaderValue("")).toBeUndefined();
    expect(projectHeaderValue("   ")).toBeUndefined();
    expect(projectHeaderValue(undefined)).toBeUndefined();
  });
});

describe("the project header", () => {
  afterEach(() => vi.unstubAllGlobals());

  const sent = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls[0][1].headers as Record<string, string>;

  it("goes on chat requests only when the client was given a project", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    await collect(new OmniRouteClient({ baseUrl: "http://x/v1", project: "acme" }));
    expect(sent(fetchMock)["x-omniroute-project"]).toBe("acme");

    fetchMock.mockClear();
    await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(sent(fetchMock)["x-omniroute-project"]).toBeUndefined();
  });

  it("stays off the model listing, the combo lookup, the probe and the usage call", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://x/v1", apiKey: "k", project: "acme" });

    await client.listModels();
    await client.listCombos();
    await client.probe();

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).not.toHaveProperty("x-omniroute-project");
    }
  });
});
