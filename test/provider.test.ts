import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig, setMockInspect, setMockWorkspace, setThinkingPartAvailable } from "./vscode.mock";
import { SECRET_API_KEY, SECRET_API_KEY_ORIGINS } from "../src/connection";
import { OmniRouteChatProvider } from "../src/provider";
import { aliasToolName } from "../src/toolNames";

function sseResponse(chunks: unknown[]): Response {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

function fakeContext() {
  const secrets = new Map<string, string>();
  return {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: memento(),
    workspaceState: memento(),
    subscriptions: [] as { dispose(): void }[],
  };
}

type Reported = vscode.LanguageModelResponsePart;

/** A provider wired to a fake extension context, with the global `fetch`
 * stubbed by the test. `reported` collects everything sent to `progress.report`;
 * `activity` collects every connection signal; `cancel()` fires the token. */
function makeProvider(overrides: { config?: Record<string, unknown> } = {}) {
  setMockConfig({ baseUrl: "http://gateway.test/v1", ...overrides.config });
  const reported: Reported[] = [];
  const activity: boolean[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context = fakeContext();
  const provider = new OmniRouteChatProvider({
    context: context as unknown as vscode.ExtensionContext,
    log: log as unknown as vscode.LogOutputChannel,
    onActivity: (ok) => void activity.push(ok),
  });
  const progress: vscode.Progress<Reported> = { report: (part) => void reported.push(part) };
  const listeners = new Set<() => void>();
  const state = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
  const token = state as unknown as vscode.CancellationToken;
  const cancel = () => {
    state.isCancellationRequested = true;
    for (const listener of [...listeners]) listener();
  };
  return { provider, context, reported, activity, log, progress, token, cancel };
}

/** `LanguageModelThinkingPart` is proposed API, so the typings do not know it. */
const ThinkingPart = () =>
  (vscode as unknown as { LanguageModelThinkingPart?: new (value: string) => { value: unknown } })
    .LanguageModelThinkingPart;
const thinkingParts = (reported: Reported[]) =>
  reported.filter((part) => {
    const cls = ThinkingPart();
    return cls !== undefined && part instanceof cls;
  });

function modelInfo(imageInput: boolean) {
  return {
    id: "m",
    omniModelId: "m",
    name: "m",
    family: "f",
    version: "1",
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { toolCalling: true, imageInput },
  } as never;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
} {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const long = "mcp_" + "a".repeat(40) + "_" + "b".repeat(30); // 75 characters

describe("provider chat path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends aliased tool names and reports the original name back to the editor", async () => {
    const wire = aliasToolName(long);
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_9", function: { name: wire, arguments: "{}" } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    );
    const { provider, reported, progress, token } = makeProvider();

    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [{ name: long, description: "d", inputSchema: {} }], toolMode: 1 } as never,
      progress,
      token
    );

    const body = requestBody(fetchMock);
    expect(body.tools?.[0].function.name).toHaveLength(64);
    expect(body.tools?.[0].function.name).toBe(wire);
    const call = reported[0];
    expect(call).toBeInstanceOf(vscode.LanguageModelToolCallPart);
    expect((call as vscode.LanguageModelToolCallPart).name).toBe(long);
  });

  it("aliases names of tool calls already in the history", async () => {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    const { provider, progress, token } = makeProvider();
    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.Assistant,
          content: [new vscode.LanguageModelToolCallPart("call_1", long, {})],
        } as never,
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [
            new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("done")]),
          ],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    const messages = requestBody(fetchMock).messages as Array<{
      tool_calls?: Array<{ function: { name: string } }>;
    }>;
    expect(messages[0].tool_calls?.[0].function.name).toBe(aliasToolName(long));
  });

  it.each([
    [false, false],
    [true, true],
  ])("passes imageInput=%s from the model to the conversion", async (imageInput, expectImage) => {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    const { provider, progress, token } = makeProvider();
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
    await provider.provideLanguageModelChatResponse(
      modelInfo(imageInput),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelToolResultPart("call_1", [img])],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    const sent = JSON.stringify(requestBody(fetchMock).messages);
    expect(sent.includes("image_url")).toBe(expectImage);
    expect(sent.includes("[1,2,3]")).toBe(false);
  });

  it("still reports a usage part at the end of the response", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { content: "hi" } }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ])
    );
    const { provider, reported, progress, token } = makeProvider();
    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    expect(reported[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect(reported[reported.length - 1]).toBeInstanceOf(vscode.LanguageModelDataPart);
  });
});

describe("provider reasoning", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    setThinkingPartAvailable(true);
    vi.unstubAllGlobals();
  });

  async function ask(ctx: ReturnType<typeof makeProvider>) {
    await ctx.provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      ctx.progress,
      ctx.token
    );
  }

  const reasoningStream = () =>
    sseResponse([
      { choices: [{ delta: { reasoning_content: "Let me " } }] },
      { choices: [{ delta: { reasoning_content: "think." } }] },
      { choices: [{ delta: { content: "Done." } }] },
    ]);

  it("reports one thinking part per delta, in order, before the answer", async () => {
    fetchMock.mockResolvedValue(reasoningStream());
    const ctx = makeProvider();
    await ask(ctx);

    expect(ctx.reported.slice(0, 3).map((p) => p.constructor)).toEqual([
      ThinkingPart(),
      ThinkingPart(),
      vscode.LanguageModelTextPart,
    ]);
    const parts = thinkingParts(ctx.reported) as unknown as Array<{ value: unknown; id?: string }>;
    expect(parts.map((p) => p.value)).toEqual(["Let me ", "think."]);
    expect(parts.every((p) => p.id === undefined)).toBe(true);
    expect(ctx.reported[ctx.reported.length - 1]).toBeInstanceOf(vscode.LanguageModelDataPart);
  });

  it("reports thinking parts when the host has the class, and drops them when it does not", async () => {
    fetchMock.mockImplementation(async () => reasoningStream());

    const withClass = makeProvider();
    await ask(withClass);
    expect(thinkingParts(withClass.reported)).toHaveLength(2);

    setThinkingPartAvailable(false);
    const withoutClass = makeProvider();
    await ask(withoutClass);
    expect(withoutClass.reported.map((p) => p.constructor)).toEqual([
      vscode.LanguageModelTextPart,
      vscode.LanguageModelDataPart,
    ]);
  });
});

describe("provider cut-off answers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const CUT_OFF =
    "The model's answer was cut off before the tool call was complete. Raise omnicopilot.maxOutputTokens or ask for smaller steps.";
  const INVALID = "The model sent a tool call with invalid arguments.";

  const toolCallChunk = (args: string) => ({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: args } }] },
      },
    ],
  });
  const finishChunk = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] });

  function ask(ctx: ReturnType<typeof makeProvider>) {
    return ctx.provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      ctx.progress,
      ctx.token
    );
  }
  const toolCallParts = (reported: Reported[]) =>
    reported.filter((part) => part instanceof vscode.LanguageModelToolCallPart);

  it("fails, and reports no tool call, when the arguments were cut off by the output limit", async () => {
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk('{"path":"src/a'), finishChunk("length")]));
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(CUT_OFF);
    expect(toolCallParts(ctx.reported)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails with the invalid-arguments message for garbage arguments and a normal stop", async () => {
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk("not json at all"), finishChunk("stop")]));
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(INVALID);
    expect(toolCallParts(ctx.reported)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails with the invalid-arguments message when the stream ends with no finish reason", async () => {
    const lines = `data: ${JSON.stringify(toolCallChunk('{"path":'))}\n`;
    fetchMock.mockResolvedValue(
      new Response(new TextEncoder().encode(lines), { status: 200 })
    );
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(INVALID);
    expect(toolCallParts(ctx.reported)).toHaveLength(0);
  });

  it.each(["null", "[1]", "5", '"x"', "true"])(
    "fails when the arguments are valid JSON but not an object (%s)",
    async (args) => {
      fetchMock.mockResolvedValue(sseResponse([toolCallChunk(args), finishChunk("tool_calls")]));
      const ctx = makeProvider();
      await expect(ask(ctx)).rejects.toThrow(INVALID);
      expect(toolCallParts(ctx.reported)).toHaveLength(0);
    }
  );

  it("treats whitespace-only arguments as a call without parameters", async () => {
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk("  \n "), finishChunk("tool_calls")]));
    const ctx = makeProvider();
    await ask(ctx);
    const calls = toolCallParts(ctx.reported) as vscode.LanguageModelToolCallPart[];
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({});
  });

  it("treats empty arguments as a call without parameters", async () => {
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk(""), finishChunk("tool_calls")]));
    const ctx = makeProvider();
    await ask(ctx);
    const calls = toolCallParts(ctx.reported) as vscode.LanguageModelToolCallPart[];
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({});
  });

  it("fails, and reports no tool call, when the output limit came before the first argument byte", async () => {
    // Through OmniRoute a Claude tool call opens with `arguments: ""` and its input arrives
    // one complete key/value at a time, so a call cut off early is a name and nothing else.
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk(""), finishChunk("length")]));
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(CUT_OFF);
    expect(toolCallParts(ctx.reported)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails the same way when only whitespace arrived before the output limit", async () => {
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk("  \n "), finishChunk("length")]));
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(CUT_OFF);
    expect(toolCallParts(ctx.reported)).toHaveLength(0);
  });

  it("fails when a complete call is followed by one that got no arguments before the limit", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        toolCallChunk('{"path":"a"}'),
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "write_file", arguments: "" } }] } }] },
        finishChunk("length"),
      ])
    );
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(CUT_OFF);
    // By the time the request fails VS Code has received the complete first call (and only
    // it); Copilot Chat does not run the tool calls of a response that failed.
    const calls = toolCallParts(ctx.reported) as vscode.LanguageModelToolCallPart[];
    expect(calls.map((call) => [call.name, call.input])).toEqual([["read_file", { path: "a" }]]);
  });

  const LIMIT_SPENT_ON_REASONING =
    "The model used its whole output limit before it wrote an answer. Raise omnicopilot.maxOutputTokens or lower the thinking effort.";
  const reasoningChunk = { choices: [{ delta: { reasoning_content: "thinking it over" } }] };

  it("fails, and says why, when reasoning used up the output limit before any answer", async () => {
    fetchMock.mockResolvedValue(sseResponse([reasoningChunk, finishChunk("length")]));
    const ctx = makeProvider();
    await expect(ask(ctx)).rejects.toThrow(LIMIT_SPENT_ON_REASONING);
    expect(thinkingParts(ctx.reported)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails the same way, once, on a host without thinking parts (nothing was shown)", async () => {
    setThinkingPartAvailable(false);
    try {
      fetchMock.mockResolvedValue(sseResponse([reasoningChunk, finishChunk("length")]));
      const ctx = makeProvider();
      await expect(ask(ctx)).rejects.toThrow(LIMIT_SPENT_ON_REASONING);
      expect(ctx.reported).toHaveLength(0);
      // The same request would spend the limit the same way: it is not sent again.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      setThinkingPartAvailable(true);
    }
  });

  it("reports a call whose arguments were complete even though the answer stopped at the limit", async () => {
    fetchMock.mockResolvedValue(sseResponse([toolCallChunk('{"path":"a"}'), finishChunk("length")]));
    const ctx = makeProvider();
    await ask(ctx);
    const calls = toolCallParts(ctx.reported) as vscode.LanguageModelToolCallPart[];
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ path: "a" });
  });

  it("delivers text cut by the limit as it is and only writes the fact to the log", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ choices: [{ delta: { content: "half an ans" } }] }, finishChunk("length")])
    );
    const ctx = makeProvider();
    await ask(ctx);
    expect((ctx.reported[0] as vscode.LanguageModelTextPart).value).toBe("half an ans");
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(String(ctx.log.warn.mock.calls[0][0])).toContain("length");
  });

  it("writes a content filter stop to the log as well", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ choices: [{ delta: { content: "partial" } }] }, finishChunk("content_filter")])
    );
    const ctx = makeProvider();
    await ask(ctx);
    expect((ctx.reported[0] as vscode.LanguageModelTextPart).value).toBe("partial");
    expect(String(ctx.log.warn.mock.calls[0][0])).toContain("content_filter");
  });

  it("stays quiet for an ordinary stop", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ choices: [{ delta: { content: "done" } }] }, finishChunk("stop")])
    );
    const ctx = makeProvider();
    await ask(ctx);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});

describe("provider request parameters", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function bodyFor(modelOptions: Record<string, unknown> | undefined, maxOutputTokens = 1000) {
    fetchMock.mockResolvedValue(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    const { provider, progress, token } = makeProvider();
    await provider.provideLanguageModelChatResponse(
      { ...(modelInfo(false) as object), maxOutputTokens } as never,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1, modelOptions } as never,
      progress,
      token
    );
    return requestBody(fetchMock) as Record<string, unknown>;
  }

  it("sends the standard sampling parameters a caller passes in modelOptions", async () => {
    const body = await bodyFor({
      temperature: 0.3,
      max_tokens: 200,
      topP: 0.9,
      stop: ["\n"],
      seed: 7,
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
      response_format: { type: "json_object" },
    });
    expect(body).toMatchObject({
      temperature: 0.3,
      max_tokens: 200,
      top_p: 0.9,
      stop: ["\n"],
      seed: 7,
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
      response_format: { type: "json_object" },
    });
  });

  it("sends a valid temperature, as before", async () => {
    expect((await bodyFor({ temperature: 0.7 })).temperature).toBe(0.7);
  });

  it("does not send a temperature that is not a number (NaN would go out as null)", async () => {
    expect(await bodyFor({ temperature: Number.NaN })).not.toHaveProperty("temperature");
  });

  it("caps max_tokens at the output limit the model was listed with", async () => {
    expect((await bodyFor({ max_tokens: 5000 }, 1000)).max_tokens).toBe(1000);
  });

  it("sends none of them when the caller passes none, or passes bad values", async () => {
    const plain = await bodyFor(undefined);
    const bad = await bodyFor({ max_tokens: -1, top_p: 5, stop: [], seed: 1.5, response_format: {} });
    for (const body of [plain, bad]) {
      for (const key of ["max_tokens", "top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"]) {
        expect(body).not.toHaveProperty(key);
      }
    }
  });
});

describe("provider rejected key", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `/models` answers with `status`; every other path (the combo lookup) is a 404. */
  const modelsAnswers = (status: number) =>
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/models")
        ? new Response(JSON.stringify({ error: { message: "nope" } }), { status })
        : new Response("{}", { status: 404 })
    );
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const REJECTED = (url: string, status: number) =>
    `OmniRoute at ${url} rejected the API key (HTTP ${status}).`;

  it.each([401, 403])("says the key was rejected on a %s, with an action that opens the key prompt", async (status) => {
    modelsAnswers(status);
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Set API key" as never);
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const ctx = makeProvider();
    await ctx.context.secrets.store(SECRET_API_KEY, "sk-1");
    // Already approved for this server, so no plain-HTTP warning joins the one under test.
    await ctx.context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(["http://gateway.test"]));

    const infos = await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();

    expect(infos).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(REJECTED("http://gateway.test", status));
    expect(warn.mock.calls[0][1]).toBe("Set API key");
    expect(exec).toHaveBeenCalledWith("omnicopilot.setApiKey");
    // The server answered, so the connection indicator stays online.
    expect(ctx.activity).toEqual([true]);
  });

  it.each([401, 403])("says the server needs a key, not that it rejected one, when none is stored (%s)", async (status) => {
    modelsAnswers(status);
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Set API key" as never);
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const ctx = makeProvider();

    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`OmniRoute at http://gateway.test needs an API key (HTTP ${status}).`);
    expect(warn.mock.calls[0][1]).toBe("Set API key");
    expect(exec).toHaveBeenCalledWith("omnicopilot.setApiKey");
  });

  it("does not let the address become a link in the needs-a-key message either", async () => {
    modelsAnswers(401);
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    const ctx = makeProvider({ config: { baseUrl: "[x](command:y)" } });
    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain("needs an API key (HTTP 401)");
    expect(text).not.toContain("](");
  });

  it("does not run the command when the notification is dismissed", async () => {
    modelsAnswers(401);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const ctx = makeProvider();
    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();
    expect(exec).not.toHaveBeenCalled();
  });

  it("stays quiet on a background refresh (silent)", async () => {
    modelsAnswers(401);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ctx = makeProvider();
    await ctx.provider.provideLanguageModelChatInformation({ silent: true }, ctx.token);
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it("shows nothing when the stored key is withheld from this server", async () => {
    modelsAnswers(401);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ctx = makeProvider();
    await ctx.context.secrets.store(SECRET_API_KEY, "sk-1");
    await ctx.context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(["http://elsewhere.test"]));

    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();

    expect(warn).not.toHaveBeenCalled();
    // The key was not sent either.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("keeps the could-not-reach message for a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    const ctx = makeProvider();
    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("Could not reach OmniRoute at http://gateway.test. Is it running?");
    expect(warn.mock.calls[0].slice(1)).toEqual(["Configure Connection", "Install OmniRoute"]);
    expect(ctx.activity).toEqual([false]);
  });

  it("keeps the could-not-reach message for a server error", async () => {
    modelsAnswers(500);
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    const ctx = makeProvider();
    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();
    expect(warn.mock.calls[0][0]).toBe("Could not reach OmniRoute at http://gateway.test. Is it running?");
  });

  it("never lets the configured address become a link in the message", async () => {
    modelsAnswers(401);
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    const ctx = makeProvider({ config: { baseUrl: "[x](command:y)" } });
    await ctx.context.secrets.store(SECRET_API_KEY, "sk-1");
    await ctx.context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(["http://[x](command:y)"]));
    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain("rejected the API key (HTTP 401)");
    expect(text).not.toContain("](");
  });
});

describe("provider catalog", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function catalog(data: unknown[]): Response {
    return new Response(JSON.stringify({ object: "list", data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("lists models with the name and limits OmniRoute really sends", async () => {
    fetchMock.mockImplementation(async () =>
      catalog([
        { id: "x/y", name: "Y Pro", context_length: 200_000, max_output_tokens: 8_192, max_input_tokens: 150_000 },
      ])
    );
    const { provider, token } = makeProvider();
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(info.name).toBe("Y Pro");
    expect(info.maxOutputTokens).toBe(8_192);
    expect(info.maxInputTokens).toBe(150_000);
  });

  it("keeps half of a small context window for the prompt", async () => {
    fetchMock.mockImplementation(async () => catalog([{ id: "tiny", context_length: 8_192 }]));
    const { provider, token } = makeProvider();
    const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(info.maxOutputTokens).toBe(4_096);
    expect(info.maxInputTokens).toBe(4_096);
  });

  it("sends max as its own tier and honours tiers the model advertises", async () => {
    // The catalog listing also asks for /combos, so answer by URL, not by call order.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/chat/completions")
        ? sseResponse([{ choices: [{ delta: { content: "ok" } }] }])
        : String(url).endsWith("/combos")
          ? catalog([])
          : catalog([{ id: "r", capabilities: { reasoning: true, effort_tiers: ["low", "high", "max"] } }])
    );
    const { provider, progress, token } = makeProvider({ config: { defaultReasoningEffort: "max" } });
    await provider.provideLanguageModelChatInformation({ silent: true }, token);
    await provider.provideLanguageModelChatResponse(
      { ...(modelInfo(false) as object), id: "r", omniModelId: "r" } as never,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1 } as never,
      progress,
      token
    );
    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
    const init = chatCall?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).reasoning_effort).toBe("max");
  });
});

describe("provider picker metadata", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** Answer /models and /combos separately, as the server does. */
  function serve(models: unknown[], combos: () => Response = () => json({ object: "list", data: [] })) {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/combos") ? combos() : json({ object: "list", data: models })
    );
  }

  type Picked = {
    id: string;
    detail?: string;
    tooltip?: string;
    pricing?: string;
    maxContextWindowTokens?: number;
    infoText?: Record<string, string>;
    isBYOK?: boolean;
    inputCost?: number;
    outputCost?: number;
  };
  async function list(config: Record<string, unknown> = {}) {
    const { provider, token } = makeProvider({ config });
    const infos = (await provider.provideLanguageModelChatInformation(
      { silent: true },
      token
    )) as unknown as Picked[];
    return new Map(infos.map((i) => [i.id, i]));
  }

  it("shows the price label and the total context window", async () => {
    serve([
      { id: "paid", context_length: 200_000, pricing: { input: 1.25, output: 10, prompt: "0.00000125", completion: "0.00001" } },
      { id: "free", context_length: 8_192, free: true, pricing: { input: 0, output: 0, prompt: "0", completion: "0" } },
      { id: "unknown" },
    ]);
    const byId = await list({ defaultContextLength: 64_000 });
    expect(byId.get("paid")?.pricing).toBe("$1.25 in · $10 out per 1M");
    expect(byId.get("paid")?.maxContextWindowTokens).toBe(200_000);
    expect(byId.get("free")?.pricing).toBe("Free");
    expect(byId.get("free")?.maxContextWindowTokens).toBe(8_192);
    expect(byId.get("unknown")).not.toHaveProperty("pricing");
    expect(byId.get("unknown")?.maxContextWindowTokens).toBe(64_000);
  });

  it("never sets the credit-based costs or the BYOK flag", async () => {
    serve([{ id: "paid", pricing: { input: 1, output: 2 } }]);
    const info = (await list()).get("paid") as Picked;
    expect(info).not.toHaveProperty("inputCost");
    expect(info).not.toHaveProperty("outputCost");
    expect(info).not.toHaveProperty("isBYOK");
  });

  it("describes a combo in the detail, the tooltip and the info banner", async () => {
    serve(
      [{ id: "smart", owned_by: "combo" }, { id: "x/y", owned_by: "x" }],
      () =>
        json({
          object: "list",
          data: [
            {
              name: "smart",
              strategy: "round_robin",
              models: [{ kind: "model", model: "cx/gpt_test" }, { kind: "combo-ref", comboName: "inner" }],
            },
            { name: "unrelated", strategy: "priority", models: [] },
          ],
        })
    );
    const byId = await list();
    const smart = byId.get("smart");
    expect(smart?.detail).toBe("combo · round_robin");
    expect(smart?.tooltip).toBe("OmniRoute · smart · round_robin · cx/gpt_test → inner");
    expect(smart?.infoText).toEqual({ combo: "round\\_robin · `cx/gpt_test` → `inner`" });
    expect(byId.get("x/y")?.detail).toBe("x");
    expect(byId.get("x/y")).not.toHaveProperty("infoText");
  });

  it("keeps server text in the tooltip and the detail to one plain line without links", async () => {
    serve([{ id: "smart", owned_by: "combo" }], () =>
      json({
        object: "list",
        data: [
          {
            name: "smart",
            strategy: "[x](command:y)\n\n# heading",
            models: [{ kind: "model", model: `[x](command:y)\u0000${"m".repeat(90)}` }],
          },
        ],
      })
    );
    const smart = (await list()).get("smart");
    for (const field of [smart?.detail, smart?.tooltip]) {
      expect(field).not.toContain("](");
      expect(field).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(smart?.detail).toBe("combo · [x] (command:y) # heading");
    expect(smart?.tooltip).toBe(`OmniRoute · smart · [x] (command:y) # heading · [x] (command:y)${"m".repeat(66)}…`);
  });

  it("keeps a plain combo row when /v1/combos has no entry for it", async () => {
    serve([{ id: "smart", owned_by: "combo" }]);
    const smart = (await list()).get("smart");
    expect(smart?.detail).toBe("combo");
    expect(smart?.tooltip).toBe("OmniRoute · smart");
    expect(smart).not.toHaveProperty("infoText");
  });

  it.each([
    ["a 404", () => new Response("nope", { status: 404 })],
    ["a 401", () => new Response("nope", { status: 401 })],
    ["a broken body", () => new Response("not json", { status: 200 })],
  ])("still lists the models when /v1/combos answers with %s", async (_label, answer) => {
    serve([{ id: "smart", owned_by: "combo" }, { id: "x/y" }], answer);
    const byId = await list();
    expect([...byId.keys()]).toEqual(["smart", "x/y"]);
    expect(byId.get("smart")?.detail).toBe("combo");
  });

  it("still lists the models when /v1/combos cannot be reached", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/combos")) throw new TypeError("fetch failed");
      return json({ object: "list", data: [{ id: "x/y" }] });
    });
    expect([...(await list()).keys()]).toEqual(["x/y"]);
  });

  it("asks for the models and the combos at the same time", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          started.push(String(url));
          release.push(() => resolve(json({ object: "list", data: [] })));
        })
    );
    const { provider, token } = makeProvider();
    const pending = provider.provideLanguageModelChatInformation({ silent: true }, token);
    // Neither answer has arrived, yet both requests are already out.
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started.some((u) => u.includes("/models"))).toBe(true);
    expect(started.some((u) => u.endsWith("/combos"))).toBe(true);
    release.forEach((r) => r());
    await pending;
  });

  it("gives the Agents-window clones the same price, context window and combo details", async () => {
    serve(
      [{ id: "smart", owned_by: "combo", context_length: 100_000, pricing: { input: 1, output: 2 } }],
      () =>
        json({
          object: "list",
          data: [{ name: "smart", strategy: "priority", models: [{ kind: "model", model: "a/b" }] }],
        })
    );
    const { provider, token } = makeProvider({ config: { exposeToAgentsWindow: true } });
    const infos = (await provider.provideLanguageModelChatInformation(
      { silent: true },
      token
    )) as unknown as Picked[];
    expect(infos.map((i) => i.id)).toEqual(["smart", "smart::agents"]);
    for (const info of infos) {
      expect(info.pricing).toBe("$1 in · $2 out per 1M");
      expect(info.maxContextWindowTokens).toBe(100_000);
      expect(info.infoText).toEqual({ combo: "priority · `a/b`" });
      expect(info.detail).toBe("combo · priority");
    }
  });

  it("lists the models after 3 s when /v1/combos never answers, without combo detail", async () => {
    vi.useFakeTimers();
    try {
      let combosSignal: AbortSignal | undefined;
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (!String(url).includes("/combos")) {
          return Promise.resolve(json({ object: "list", data: [{ id: "smart", owned_by: "combo" }, { id: "x/y" }] }));
        }
        combosSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError"))
          );
        });
      });
      const { provider, token } = makeProvider();
      let settled = false;
      const pending = provider.provideLanguageModelChatInformation({ silent: true }, token).then((infos) => {
        settled = true;
        return infos as unknown as Picked[];
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const infos = await pending;
      expect(infos.map((i) => i.id)).toEqual(["smart", "x/y"]);
      expect(infos[0].detail).toBe("combo");
      expect(infos[0]).not.toHaveProperty("infoText");
      expect(combosSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns no models when the model call fails even if combos answer", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/combos") ? json({ object: "list", data: [] }) : new Response("no", { status: 500 })
    );
    const { provider, token } = makeProvider();
    expect(await provider.provideLanguageModelChatInformation({ silent: true }, token)).toEqual([]);
  });
});

describe("provider effort picker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  type Schema = {
    properties: {
      reasoningEffort: {
        title: string;
        enum: string[];
        enumItemLabels: string[];
        group: string;
        default?: string;
      };
    };
  };

  async function list(config: Record<string, unknown> = {}) {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "plain" },
              { id: "thinker", capabilities: { reasoning: true } },
              { id: "tiered", capabilities: { thinking: true, effort_tiers: ["low", "high", "max"] } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const { provider, progress, token } = makeProvider({ config });
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, token);
    const byId = new Map(infos.map((i) => [i.id, i as unknown as { configurationSchema?: Schema }]));
    return { provider, progress, token, byId };
  }

  it("declares the effort picker only on reasoning models", async () => {
    const { byId } = await list();
    expect(byId.get("plain")?.configurationSchema).toBeUndefined();
    const thinker = byId.get("thinker")?.configurationSchema?.properties.reasoningEffort;
    expect(thinker?.title).toBe("Thinking effort");
    expect(thinker?.group).toBe("navigation");
    expect(thinker?.enum).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(thinker?.enumItemLabels).toEqual(["Off", "Low", "Medium", "High", "Extra high", "Max"]);
    expect("default" in (thinker as object)).toBe(false);
  });

  it("offers exactly the tiers the model advertises, labelling unknown ones by id", async () => {
    const { byId } = await list();
    const tiered = byId.get("tiered")?.configurationSchema?.properties.reasoningEffort;
    expect(tiered?.enum).toEqual(["low", "high", "max"]);
    expect(tiered?.enumItemLabels).toEqual(["Low", "High", "Max"]);
  });

  it("preselects the configured default only on models that offer it", async () => {
    const { byId } = await list({ defaultReasoningEffort: "medium" });
    expect(byId.get("thinker")?.configurationSchema?.properties.reasoningEffort.default).toBe("medium");
    expect("default" in (byId.get("tiered")?.configurationSchema?.properties.reasoningEffort as object)).toBe(false);
  });

  async function chat(
    provider: OmniRouteChatProvider,
    progress: vscode.Progress<Reported>,
    token: vscode.CancellationToken,
    options: Record<string, unknown>
  ) {
    fetchMock.mockResolvedValueOnce(sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    await provider.provideLanguageModelChatResponse(
      { ...(modelInfo(false) as object), id: "thinker", omniModelId: "thinker" } as never,
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { tools: [], toolMode: 1, ...options } as never,
      progress,
      token
    );
    const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit;
    return JSON.parse(init.body as string) as { reasoning_effort?: string };
  }

  it("forwards the effort chosen in the picker as reasoning_effort", async () => {
    const { provider, progress, token } = await list({ defaultReasoningEffort: "low" });
    const body = await chat(provider, progress, token, {
      modelConfiguration: { reasoningEffort: "high" },
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("forwards max unchanged", async () => {
    const { provider, progress, token } = await list();
    const body = await chat(provider, progress, token, {
      modelConfiguration: { reasoningEffort: "max" },
    });
    expect(body.reasoning_effort).toBe("max");
  });

  it("sends no reasoning_effort when nothing was picked and no default is set", async () => {
    const { provider, progress, token } = await list();
    const body = await chat(provider, progress, token, {});
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("provider request retries", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const userMessage = {
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart("go")],
  } as never;

  function ask(ctx: ReturnType<typeof makeProvider>): Promise<unknown> {
    // Attach the handler right away so a rejection is never left unhandled
    // while the fake clock is being advanced.
    return ctx.provider
      .provideLanguageModelChatResponse(
        modelInfo(false),
        [userMessage],
        { tools: [], toolMode: 1 } as never,
        ctx.progress,
        ctx.token
      )
      .then(
        () => ({ ok: true }),
        (error: Error) => ({ ok: false, error })
      );
  }

  const cooling = (retryAfter: string) =>
    new Response(
      JSON.stringify({
        error: { message: "All credentials for model m are cooling down", reset_seconds: 1 },
      }),
      { status: 429, headers: { "Retry-After": retryAfter } }
    );
  const status = (code: number) =>
    new Response(JSON.stringify({ error: { message: `upstream ${code}` } }), { status: code });
  const text = (value: string) => ({ choices: [{ delta: { content: value } }] });
  const dataParts = (reported: Reported[]) =>
    reported.filter((part) => part instanceof vscode.LanguageModelDataPart);

  it("retries a cooling-down model on its own and reports the answer once", async () => {
    fetchMock
      .mockResolvedValueOnce(cooling("1"))
      .mockResolvedValueOnce(
        sseResponse([
          text("hello"),
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ])
      );
    const ctx = makeProvider();
    const result = ask(ctx);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const texts = ctx.reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
    expect(texts).toHaveLength(1);
    expect(dataParts(ctx.reported)).toHaveLength(1);
    expect(ctx.reported[ctx.reported.length - 1]).toBeInstanceOf(vscode.LanguageModelDataPart);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(String(ctx.log.warn.mock.calls[0][0])).toMatch(/retry/i);
    expect(ctx.activity).toEqual([true]);
  });

  it("waits for the reset hint of an error that arrives inside the stream", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([{ error: { message: "[x/y] [503]: busy (reset after 2s)" } }])
      )
      .mockResolvedValueOnce(sseResponse([text("back")]));
    const ctx = makeProvider();
    const result = ask(ctx);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a usage chunk from a failed attempt count as streamed output", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [], usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } },
          { error: { message: "[503]: busy (reset after 1s)" } },
        ])
      )
      .mockResolvedValueOnce(sseResponse([text("ok")]));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dataParts(ctx.reported)).toHaveLength(1);
    // the usage part comes from the attempt that succeeded, not the failed one
    const payload = JSON.parse(
      new TextDecoder().decode((dataParts(ctx.reported)[0] as vscode.LanguageModelDataPart).data)
    );
    expect(payload.prompt_tokens).not.toBe(9);
  });

  it("does not retry once text has been streamed", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([text("partial"), { error: { message: "[503]: busy (reset after 1s)" } }])
    );
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("[503]: busy (reset after 1s)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.reported).toHaveLength(1);
    expect(ctx.activity).toEqual([true]);
  });

  it("does not retry after thinking has been shown", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { reasoning_content: "pondering" } }] },
        { error: { message: "[503]: busy (reset after 1s)" } },
      ])
    );
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe("[503]: busy (reset after 1s)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(thinkingParts(ctx.reported)).toHaveLength(1);
  });

  it("still retries when the reasoning was dropped because the host cannot show it", async () => {
    setThinkingPartAvailable(false);
    try {
      fetchMock
        .mockResolvedValueOnce(
          sseResponse([
            { choices: [{ delta: { reasoning_content: "pondering" } }] },
            { error: { message: "[503]: busy (reset after 1s)" } },
          ])
        )
        .mockResolvedValueOnce(sseResponse([text("hello")]));
      const ctx = makeProvider();
      const result = ask(ctx);

      await vi.advanceTimersByTimeAsync(1000);

      expect(await result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ctx.reported.filter((p) => p instanceof vscode.LanguageModelTextPart)).toHaveLength(1);
    } finally {
      setThinkingPartAvailable(true);
    }
  });

  it("does not retry once a tool call has been reported", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        { error: { message: "[503]: busy (reset after 1s)" } },
      ])
    );
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.reported[0]).toBeInstanceOf(vscode.LanguageModelToolCallPart);
  });

  it("gives up with the server's message when the wait is longer than the cap", async () => {
    fetchMock.mockResolvedValue(cooling("120"));
    const ctx = makeProvider();
    const result = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(result.ok).toBe(false);
    expect(result.error.message).toBe(
      "OmniRoute request failed (HTTP 429): All credentials for model m are cooling down"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks the message of an error it retried and gave up on", async () => {
    fetchMock.mockImplementation(async () => status(503));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);

    const outcome = (await result) as { ok: boolean; error: Error };
    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.error.message).toBe("OmniRoute request failed (HTTP 503): upstream 503 (retried 2×)");
  });

  it("never retries a client error", async () => {
    fetchMock.mockResolvedValue(status(400));
    const ctx = makeProvider();
    const outcome = (await ask(ctx)) as { ok: boolean; error: Error };

    expect(outcome.ok).toBe(false);
    expect(outcome.error.message).not.toContain("retried");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the request is cancelled", async () => {
    fetchMock.mockResolvedValue(cooling("5"));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    ctx.cancel();

    expect(await result).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.reported).toHaveLength(0);
    expect(ctx.activity).toEqual([]);
  });

  it("keeps the connection marked online after an HTTP error", async () => {
    fetchMock.mockResolvedValue(status(401));
    const ctx = makeProvider();
    await ask(ctx);
    expect(ctx.activity).toEqual([true]);
  });

  it("marks the connection offline after a network error, once retries are spent", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));
    const ctx = makeProvider();
    const result = ask(ctx);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);

    const outcome = (await result) as { ok: boolean; error: Error };
    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.error.message).toMatch(/ECONNREFUSED.*\(retried 2×\)$/);
    expect(ctx.activity).toEqual([false]);
  });

  it("does not mark the server offline when model discovery is refused with a 401", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const ctx = makeProvider();
    expect(await ctx.provider.provideLanguageModelChatInformation({ silent: true }, ctx.token)).toEqual([]);
    expect(ctx.activity).toEqual([true]);
  });

  it("marks the server offline when model discovery cannot reach it", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const ctx = makeProvider();
    expect(await ctx.provider.provideLanguageModelChatInformation({ silent: true }, ctx.token)).toEqual([]);
    expect(ctx.activity).toEqual([false]);
  });
});

describe("provider connection help", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the server URL the request went to, not the raw setting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ctx = makeProvider({ config: { baseUrl: "  Gateway.test:8080/v1/ " } });

    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);

    expect(warn).toHaveBeenCalledTimes(1);
    // The address is shown as the URL parser serialises it (lower-case host).
    expect(warn.mock.calls[0][0]).toBe("Could not reach OmniRoute at http://gateway.test:8080. Is it running?");
  });
});

describe("provider connection help with a hostile setting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not let the server URL become a link in the warning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ctx = makeProvider({
      config: {
        baseUrl:
          "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)",
      },
    });

    await ctx.provider.provideLanguageModelChatInformation({ silent: false }, ctx.token);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("](");
  });
});

describe("provider test harness", () => {
  it("offers secrets, globalState and workspaceState backed by maps", async () => {
    const { context } = makeProvider();
    await context.secrets.store("k", "v");
    expect(await context.secrets.get("k")).toBe("v");
    await context.secrets.delete("k");
    expect(await context.secrets.get("k")).toBeUndefined();
    await context.globalState.update("g", 1);
    await context.workspaceState.update("w", 2);
    expect(context.globalState.get("g")).toBe(1);
    expect(context.workspaceState.get("w")).toBe(2);
  });
});

describe("provider project header", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async () => sseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setMockWorkspace();
  });

  async function chat(config: Record<string, unknown>, inspected?: Record<string, unknown>) {
    const { provider, progress, token } = makeProvider({ config });
    if (inspected) setMockInspect("sendProjectName", inspected);
    await provider.provideLanguageModelChatResponse(
      modelInfo(false),
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          content: [new vscode.LanguageModelTextPart("go")],
        } as never,
      ],
      { toolMode: 1 } as never,
      progress,
      token
    );
    return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it("sends the workspace name only when the setting is on", async () => {
    setMockWorkspace({ name: "acme api", folders: ["file:///work/acme"] });
    expect((await chat({ sendProjectName: true }))["x-omniroute-project"]).toBe("acme api");
  });

  it("sends no header by default, nor with the setting off", async () => {
    setMockWorkspace({ name: "acme", folders: ["file:///work/acme"] });
    expect(await chat({})).not.toHaveProperty("x-omniroute-project");
    fetchMock.mockClear();
    expect(await chat({ sendProjectName: false })).not.toHaveProperty("x-omniroute-project");
  });

  it("sends no header when no workspace is open", async () => {
    expect(await chat({ sendProjectName: true })).not.toHaveProperty("x-omniroute-project");
  });

  it("takes the opt-in from the user level only: a workspace or folder value of true sends nothing", async () => {
    setMockWorkspace({ name: "acme", folders: ["file:///work/acme"] });
    expect(await chat({}, { workspaceValue: true })).not.toHaveProperty("x-omniroute-project");
    fetchMock.mockClear();
    expect(await chat({}, { workspaceFolderValue: true })).not.toHaveProperty("x-omniroute-project");
    fetchMock.mockClear();
    expect(await chat({ sendProjectName: false }, { workspaceValue: true })).not.toHaveProperty(
      "x-omniroute-project"
    );
  });

  it("sends the header for a user-level true, whatever the workspace says", async () => {
    setMockWorkspace({ name: "acme", folders: ["file:///work/acme"] });
    expect(
      (await chat({ sendProjectName: true }, { workspaceValue: false }))["x-omniroute-project"]
    ).toBe("acme");
  });

  it("reduces the name to printable ASCII", async () => {
    setMockWorkspace({ name: "São Paulo\r\nX-Evil: 1", folders: ["file:///work/x"] });
    expect((await chat({ sendProjectName: true }))["x-omniroute-project"]).toBe("S-o Paulo-X-Evil: 1");
  });

  it("leaves the model listing without it", async () => {
    setMockWorkspace({ name: "acme", folders: ["file:///work/acme"] });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const { provider, token } = makeProvider({ config: { sendProjectName: true } });
    await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).not.toHaveProperty("x-omniroute-project");
    }
  });
});

describe("provider current listing (what the panel reports)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const rows = [
    { id: "a/one" },
    { id: "a/two" },
    { id: "b/three" },
    { id: "a/embed", type: "embedding" },
  ];
  const catalogDownloads = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("/models")).length;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/combos")
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ object: "list", data: rows }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("counts the models the picker lists, after the chat-model filter and omnicopilot.modelFilter", async () => {
    const { provider } = makeProvider({ config: { modelFilter: "^a/" } });

    const listing = await provider.currentListing();

    expect(listing).toMatchObject({ ok: true, count: 2 });
    expect(listing.infos.map((info) => info.id)).toEqual(["a/one", "a/two"]);
  });

  it("lists once for callers that ask while it runs, and not again afterwards", async () => {
    const { provider } = makeProvider();

    const [first, second] = await Promise.all([provider.currentListing(), provider.currentListing()]);
    await provider.currentListing();

    expect(first).toBe(second);
    expect(catalogDownloads()).toBe(1);
  });

  it("coalesces concurrent direct model listings", async () => {
    const { provider } = makeProvider();

    const [first, second] = await Promise.all([
      provider.listModels({ silent: true }),
      provider.listModels({ silent: true }),
    ]);

    expect(first).toBe(second);
    expect(catalogDownloads()).toBe(1);
  });

  describe("a caller that joins a listing under way", () => {
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const CONNECTION_HELP = "Could not reach OmniRoute at http://gateway.test. Is it running?";
    const networkFailure = () => Promise.reject(new TypeError("fetch failed"));
    const unauthorized = () => new Response("{}", { status: 401 });
    const storeApprovedKey = async (ctx: ReturnType<typeof makeProvider>) => {
      await ctx.context.secrets.store(SECRET_API_KEY, "sk-1");
      await ctx.context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(["http://gateway.test"]));
    };
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);
    });
    afterEach(() => warn.mockRestore());

    it("is told the server is unreachable when it joined a silent listing that failed", async () => {
      const gate = holdNextCatalog(networkFailure);
      const { provider } = makeProvider();

      const starter = provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = provider.listModels({ silent: false });
      gate.release();

      expect(await starter).toMatchObject({ ok: false });
      expect(await joiner).toBe(await starter);
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(CONNECTION_HELP);
      expect(catalogDownloads()).toBe(1);
    });

    it("is told the key was rejected when it joined a silent listing the server answered with a 401", async () => {
      const gate = holdNextCatalog(unauthorized);
      const ctx = makeProvider();
      await storeApprovedKey(ctx);

      const starter = ctx.provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = ctx.provider.listModels({ silent: false });
      gate.release();

      expect(await joiner).toMatchObject({ ok: false, failure: { status: 401 } });
      await starter;
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe("OmniRoute at http://gateway.test rejected the API key (HTTP 401).");
      expect(catalogDownloads()).toBe(1);
    });

    it("is told the server needs a key when none is stored, and nothing when the key is withheld", async () => {
      const gate = holdNextCatalog(unauthorized);
      const ctx = makeProvider();
      const starter = ctx.provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = ctx.provider.listModels({ silent: false });
      gate.release();
      await Promise.all([starter, joiner]);
      await flush();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe("OmniRoute at http://gateway.test needs an API key (HTTP 401).");

      warn.mockClear();
      await ctx.context.secrets.store(SECRET_API_KEY, "sk-1");
      await ctx.context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(["http://elsewhere.test"]));
      await ctx.provider.refresh();
      const gate2 = holdNextCatalog(unauthorized);
      const starter2 = ctx.provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate2.held()).toBe(true));
      const joiner2 = ctx.provider.listModels({ silent: false });
      gate2.release();
      await Promise.all([starter2, joiner2]);
      await flush();
      expect(warn).not.toHaveBeenCalled();
    });

    it("never lets the configured address become a link in the message it is shown", async () => {
      const gate = holdNextCatalog(unauthorized);
      const ctx = makeProvider({ config: { baseUrl: "[x](command:y)" } });
      await ctx.context.secrets.store(SECRET_API_KEY, "sk-1");
      await ctx.context.secrets.store(SECRET_API_KEY_ORIGINS, JSON.stringify(["http://[x](command:y)"]));

      const starter = ctx.provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = ctx.provider.listModels({ silent: false });
      gate.release();
      await Promise.all([starter, joiner]);
      await flush();

      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0][0]);
      expect(text).toContain("rejected the API key (HTTP 401)");
      expect(text).not.toContain("](");
    });

    it("shows one notice when two callers that are told share the failed listing", async () => {
      const gate = holdNextCatalog(networkFailure);
      const { provider } = makeProvider();

      const starter = provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joined = [provider.listModels({ silent: false }), provider.listModels({ silent: false })];
      gate.release();
      await Promise.all([starter, ...joined]);
      await flush();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(catalogDownloads()).toBe(1);
    });

    it("shows one notice when the starter is told and the joiner is told as well", async () => {
      const gate = holdNextCatalog(networkFailure);
      const { provider } = makeProvider();

      const starter = provider.listModels({ silent: false });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = provider.listModels({ silent: false });
      gate.release();
      await Promise.all([starter, joiner]);
      await flush();

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("shows the starter's notice once when the caller that joined is silent", async () => {
      const gate = holdNextCatalog(networkFailure);
      const { provider } = makeProvider();

      const starter = provider.listModels({ silent: false });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = provider.listModels({ silent: true });
      gate.release();
      await Promise.all([starter, joiner]);
      await flush();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(CONNECTION_HELP);
    });

    it("says nothing when every caller is silent, the panel's included", async () => {
      const gate = holdNextCatalog(networkFailure);
      const { provider } = makeProvider();

      const starter = provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const panel = provider.currentListing();
      gate.release();
      await Promise.all([starter, panel]);
      await flush();

      expect(warn).not.toHaveBeenCalled();
    });

    it("lists for itself when the starter's request was cancelled meanwhile", async () => {
      const gate = holdNextCatalog();
      const { provider } = makeProvider();
      const { token, cancel } = hostToken();

      const starter = provider.listModels({ silent: true }, token);
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      const joiner = provider.listModels({ silent: false });
      cancel();
      gate.release();
      await starter;

      expect(await joiner).toMatchObject({ ok: true, count: 3 });
      expect(catalogDownloads()).toBe(2);
    });

    it("does not join a listing from before a refresh()", async () => {
      const gate = holdNextCatalog();
      const { provider } = makeProvider();

      const before = provider.listModels({ silent: true });
      await vi.waitFor(() => expect(gate.held()).toBe(true));
      await provider.refresh();
      const after = provider.listModels({ silent: false });
      gate.release();
      await Promise.all([before, after]);

      expect(await after).toMatchObject({ ok: true, count: 3 });
      expect(catalogDownloads()).toBe(2);
    });
  });

  it("reports the last listing the picker's own call made, without another download", async () => {
    const { provider, token } = makeProvider();
    await provider.provideLanguageModelChatInformation({ silent: true }, token);
    expect(catalogDownloads()).toBe(1);

    expect(await provider.currentListing()).toMatchObject({ ok: true, count: 3 });
    expect(catalogDownloads()).toBe(1);
  });

  it("lists again after refresh(), because the connection or the filter may have changed", async () => {
    const { provider } = makeProvider();
    await provider.currentListing();

    await provider.refresh();
    await provider.currentListing();

    expect(catalogDownloads()).toBe(2);
  });

  it("does not keep a listing that was started before a refresh()", async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      (url: string) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ object: "list", data: rows }), { status: 200 }));
          void url;
        })
    );
    const { provider } = makeProvider();
    const stale = provider.currentListing();
    await vi.waitFor(() => expect(release).toBeDefined());

    await provider.refresh();
    release?.();
    await stale;
    await provider.currentListing();

    expect(catalogDownloads()).toBe(2);
  });

  /** A host token whose request was cancelled while the answer was on its way. */
  const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) } as never;

  it("does not take a cancelled picker listing for the count: the panel lists for itself", async () => {
    const { provider } = makeProvider();

    // The client answers a cancelled request with no models at all.
    const fromHost = await provider.provideLanguageModelChatInformation({ silent: true }, cancelled);
    const listing = await provider.currentListing();

    expect(fromHost).toEqual([]);
    expect(listing).toMatchObject({ ok: true, count: 3 });
    expect(catalogDownloads()).toBe(2);
  });

  it("does not let a cancelled listing replace a good earlier one", async () => {
    const { provider } = makeProvider();
    await provider.currentListing();
    expect(catalogDownloads()).toBe(1);

    await provider.provideLanguageModelChatInformation({ silent: true }, cancelled);
    const listing = await provider.currentListing();

    expect(listing).toMatchObject({ ok: true, count: 3 });
    expect(catalogDownloads()).toBe(2); // the cancelled call's own, none for the panel
  });

  /** A host token that the test cancels while the request is out. */
  function hostToken() {
    const state = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    return { token: state as never, cancel: () => void (state.isCancellationRequested = true) };
  }

  /** Holds the next catalog download until `release()` (then it answers with `answer()`, by
   * default the usual catalog); the combos call answers at once. */
  function holdNextCatalog(answer?: () => Response | Promise<Response>) {
    let release: (() => void) | undefined;
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/combos") || release) return fallback(url);
      return new Promise<Response>((resolve) => {
        release = () => resolve(answer ? answer() : (fallback(url) as Response));
      });
    });
    return { release: () => release?.(), held: () => release !== undefined };
  }

  it("joins the picker's listing that is under way instead of downloading again", async () => {
    const { provider } = makeProvider();
    const gate = holdNextCatalog();
    const { token } = hostToken();

    const fromHost = provider.provideLanguageModelChatInformation({ silent: true }, token);
    await vi.waitFor(() => expect(gate.held()).toBe(true));
    const joined = provider.currentListing();
    gate.release();

    expect(await joined).toMatchObject({ ok: true, count: 3 });
    expect(await fromHost).toHaveLength(3);
    expect(catalogDownloads()).toBe(1);
  });

  it("does not join a listing from before a refresh()", async () => {
    const { provider } = makeProvider();
    const gate = holdNextCatalog();
    const { token } = hostToken();

    const fromHost = provider.provideLanguageModelChatInformation({ silent: true }, token);
    await vi.waitFor(() => expect(gate.held()).toBe(true));
    await provider.refresh();
    const listing = provider.currentListing();
    gate.release();
    await fromHost;

    expect(await listing).toMatchObject({ ok: true, count: 3 });
    expect(catalogDownloads()).toBe(2);
  });

  it("gives a caller that joined a listing the host then cancelled a real listing of its own", async () => {
    const { provider } = makeProvider();
    const gate = holdNextCatalog();
    const { token, cancel } = hostToken();

    const fromHost = provider.provideLanguageModelChatInformation({ silent: true }, token);
    await vi.waitFor(() => expect(gate.held()).toBe(true));
    const joined = provider.currentListing();
    cancel();
    gate.release();

    expect(await fromHost).toEqual([]);
    expect(await joined).toMatchObject({ ok: true, count: 3 });
    expect(catalogDownloads()).toBe(2);
  });

  it("tells the picker to list again when its own listing succeeds after the host's last one failed", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    const { provider } = makeProvider();
    const { token } = hostToken();
    let events = 0;
    provider.onDidChangeLanguageModelChatInformation(() => void (events += 1));

    expect(await provider.provideLanguageModelChatInformation({ silent: true }, token)).toEqual([]);
    expect(await provider.currentListing()).toMatchObject({ ok: true, count: 3 });
    expect(events).toBe(1);

    // Once: the panel asking again before the host has listed does not fire again.
    await provider.currentListing();
    expect(events).toBe(1);
  });

  it("does not tell the picker anything when the host's last listing succeeded or has not happened", async () => {
    const { provider } = makeProvider();
    let events = 0;
    provider.onDidChangeLanguageModelChatInformation(() => void (events += 1));

    // The host has not listed yet.
    await provider.currentListing();
    expect(events).toBe(0);

    // The host's listing succeeded; a failed listing of another caller (Refresh Models)
    // then leaves nothing to report, and the panel's own listing that follows says nothing.
    await provider.refresh();
    events = 0;
    await provider.provideLanguageModelChatInformation({ silent: true }, hostToken().token);
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    expect(await provider.listModels({ silent: true })).toMatchObject({ ok: false });
    await provider.currentListing();
    expect(events).toBe(0);
  });

  it("does not keep a failed listing: the next call lists again, and never prompts", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 401 }));
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { provider } = makeProvider();

    const failed = await provider.currentListing();
    const retried = await provider.currentListing();

    expect(failed).toMatchObject({ ok: false, count: 0, failure: { status: 401 } });
    expect(failed.failure?.message).toContain("401");
    expect(retried).toMatchObject({ ok: true, count: 3 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
