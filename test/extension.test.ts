import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registeredCommands, setMockConfig, setMockInspect, setMockWorkspace } from "./vscode.mock";
import {
  SECRET_API_KEY,
  SECRET_API_KEY_ORIGINS,
  workspaceOriginsSecretName,
  workspaceSecretName,
} from "../src/connection";
import { activate, deactivate } from "../src/extension";

const LINK_PAYLOAD =
  "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)";

/** Activate the extension against the mock, as an install that was already welcomed. */
function activated(initialSecrets: Record<string, string> = {}) {
  const secrets = new Map<string, string>(Object.entries(initialSecrets));
  const state = new Map<string, unknown>([["omnicopilot.welcomed", true]]);
  const local = new Map<string, unknown>();
  const memento = (store: Map<string, unknown>) => ({
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void store.set(key, value),
  });
  const secretListeners = new Set<(event: { key: string }) => void>();
  /** Set by `failReadsAfterNextWrite`: the error every read throws once a write has happened. */
  let readFailure: { message: string; armed: boolean } | undefined;
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extension: { packageJSON: { version: "test" } },
    secrets: {
      get: async (key: string) => {
        if (readFailure?.armed) throw new Error(readFailure.message);
        return secrets.get(key);
      },
      store: async (key: string, value: string) => {
        secrets.set(key, value);
        if (readFailure) readFailure.armed = true;
      },
      delete: async (key: string) => void secrets.delete(key),
      onDidChange: (listener: (event: { key: string }) => void) => {
        secretListeners.add(listener);
        return { dispose: () => void secretListeners.delete(listener) };
      },
    },
    globalState: memento(state),
    workspaceState: memento(local),
  };
  activate(context as unknown as vscode.ExtensionContext);
  return {
    secrets,
    local,
    run: (id: string) => registeredCommands.get(id)?.(),
    /** SecretStorage as another window leaves it: the value is set and every window is told. */
    changedElsewhere: (key: string, value: string | undefined) => {
      if (value === undefined) secrets.delete(key);
      else secrets.set(key, value);
      for (const listener of [...secretListeners]) listener({ key });
    },
    secretListenerCount: () => secretListeners.size,
    /** SecretStorage starts failing every read once the next write has been made. */
    failReadsAfterNextWrite: (message: string) => void (readFailure = { message, armed: false }),
    dispose: () => {
      for (const item of context.subscriptions) item.dispose();
      deactivate();
    },
  };
}

/** A model row as `GET /v1/models` lists it; `type` makes it a specialty (non-chat) model. */
const chat = (id: string, type?: string) => ({ id, owned_by: "x", ...(type ? { type } : {}) });

/** The server behind the stubbed `fetch`: the probe (HEAD) is accepted, the model
 * listing answers `listing` (a status, or the rows with 200) and `/combos` is absent. */
function stubServer(options: { models?: unknown[]; listingStatus?: number }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      if (String(url).includes("/combos")) return new Response("{}", { status: 404 });
      if (options.listingStatus !== undefined && options.listingStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: "no" } }), {
          status: options.listingStatus,
        });
      }
      return new Response(JSON.stringify({ object: "list", data: options.models ?? [] }), {
        status: 200,
      });
    })
  );
}

function stubUnreachable(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      });
    })
  );
}

const texts = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]));

describe("extension notifications built from the server URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not let the URL become a link in "Connected to OmniRoute at {0}."', async () => {
    stubServer({ models: [chat("a/one")] });
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    const connected = info.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith("Connected"));
    expect(connected).toBeDefined();
    expect(connected).not.toContain("](");
    ext.dispose();
  });

  it("does not let the URL become a link in the could-not-connect warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      })
    );
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain("](");
    ext.dispose();
  });
});

describe("Set API Key", () => {
  const WS = "file:///work/acme";
  const WS_KEY = workspaceSecretName(WS);
  const WS_LIST = workspaceOriginsSecretName(WS);
  const SWITCH = "omnicopilot.useWorkspaceKey";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  /** An activated extension with a global key and, optionally, a workspace key, both for A. */
  function setUp(opts: { workspace?: boolean; switchOn?: boolean; workspaceKey?: boolean } = {}) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    setMockConfig({ baseUrl: "https://a.example" });
    if (opts.workspace !== false) setMockWorkspace({ folders: [WS] });
    const ext = activated();
    ext.secrets.set("omnicopilot.apiKey", "sk-global");
    ext.secrets.set("omnicopilot.apiKeyOrigins", JSON.stringify(["https://a.example"]));
    if (opts.workspaceKey) {
      ext.secrets.set(WS_KEY, "sk-ws");
      ext.secrets.set(WS_LIST, JSON.stringify(["https://a.example"]));
    }
    if (opts.switchOn) ext.local.set(SWITCH, true);
    return ext;
  }

  /** Run the command with `typed` in the input box; returns the box's options. */
  async function typing(ext: ReturnType<typeof activated>, typed: string) {
    const box = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(typed);
    await ext.run("omnicopilot.setApiKey");
    return box.mock.calls[0][0] as { title: string; value: string };
  }

  it("writes the global pair and leaves the workspace pair alone when the switch is off", async () => {
    const ext = setUp({ workspaceKey: true });
    const box = await typing(ext, "sk-new");
    expect(ext.secrets.get("omnicopilot.apiKey")).toBe("sk-new");
    expect(ext.secrets.get(WS_KEY)).toBe("sk-ws");
    expect(ext.secrets.get(WS_LIST)).toBe(JSON.stringify(["https://a.example"]));
    expect(box.title).toBe("OmniRoute API key");
    expect(box.value).toBe("sk-global");
    ext.dispose();
  });

  it("makes the status bar read the usage again with the new key, without waiting for the 5-minute floor", async () => {
    const usageKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/usage/om-usage")) {
          usageKeys.push(String((init?.headers as Record<string, string> | undefined)?.Authorization));
          return new Response(JSON.stringify({ allowed: true, personal: null, provider: null }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      })
    );
    setMockConfig({ baseUrl: "https://a.example" });
    const ext = activated();
    ext.secrets.set("omnicopilot.apiKey", "sk-global");
    ext.secrets.set("omnicopilot.apiKeyOrigins", JSON.stringify(["https://a.example"]));
    await vi.waitFor(() => expect(usageKeys).toContain("Bearer sk-global"));

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("sk-new");
    await ext.run("omnicopilot.setApiKey");

    await vi.waitFor(() => expect(usageKeys).toContain("Bearer sk-new"));
    ext.dispose();
  });

  it("writes the workspace pair and leaves the global pair alone when the switch is on and a workspace key is stored", async () => {
    const ext = setUp({ workspaceKey: true, switchOn: true });
    const box = await typing(ext, "sk-new");
    expect(ext.secrets.get(WS_KEY)).toBe("sk-new");
    expect(ext.secrets.get("omnicopilot.apiKey")).toBe("sk-global");
    expect(box.title).toBe("API key for this workspace");
    expect(box.value).toBe("sk-ws");
    ext.dispose();
  });

  it("makes the typed key the workspace key when the switch is on and none is stored yet", async () => {
    const ext = setUp({ switchOn: true });
    const box = await typing(ext, "sk-new");
    expect(ext.secrets.get(WS_KEY)).toBe("sk-new");
    expect(ext.secrets.get(WS_LIST)).toBe(JSON.stringify(["https://a.example"]));
    expect(ext.secrets.get("omnicopilot.apiKey")).toBe("sk-global");
    expect(box.title).toBe("API key for this workspace");
    expect(box.value).toBe("");
    ext.dispose();
  });

  it("asks for the key with the prompt that says where it is stored and how to clear it", async () => {
    const ext = setUp();
    const box = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
    await ext.run("omnicopilot.setApiKey");
    expect((box.mock.calls[0][0] as { prompt: string }).prompt).toBe(
      "Stored securely in the OS keychain (SecretStorage). Leave empty to clear."
    );
    ext.dispose();
  });

  it("writes the global key when no workspace is open, even with the switch on", async () => {
    const ext = setUp({ workspace: false, switchOn: true });
    const box = await typing(ext, "sk-new");
    expect(ext.secrets.get("omnicopilot.apiKey")).toBe("sk-new");
    expect([...ext.secrets.keys()].some((name) => name.includes(".ws."))).toBe(false);
    expect(box.title).toBe("OmniRoute API key");
    ext.dispose();
  });

  it("clears only the workspace key on an empty entry, and turns the switch off", async () => {
    const ext = setUp({ workspaceKey: true, switchOn: true });
    await typing(ext, "");
    expect(ext.secrets.has(WS_KEY)).toBe(false);
    expect(ext.secrets.has(WS_LIST)).toBe(false);
    expect(ext.local.get(SWITCH)).toBe(false);
    expect(ext.secrets.get("omnicopilot.apiKey")).toBe("sk-global");
    ext.dispose();
  });

  it("clears only the global key on an empty entry when the switch is off", async () => {
    const ext = setUp({ workspaceKey: true });
    await typing(ext, "");
    expect(ext.secrets.has("omnicopilot.apiKey")).toBe(false);
    expect(ext.secrets.has("omnicopilot.apiKeyOrigins")).toBe(false);
    expect(ext.secrets.get(WS_KEY)).toBe("sk-ws");
    ext.dispose();
  });

  it("still refreshes the status bar, the picker and the panel when the connection cannot be read afterwards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    setMockConfig({ baseUrl: "https://a.example" });
    const warnings: string[] = [];
    vi.spyOn(vscode.window, "createOutputChannel").mockImplementation((() => ({
      info() {},
      warn: (message: string) => void warnings.push(message),
      error: (message: string) => void warnings.push(message),
      debug() {},
      trace() {},
      dispose() {},
    })) as never);
    let shows = 0;
    const createItem = vscode.window.createStatusBarItem as (...args: unknown[]) => { show(): void };
    vi.spyOn(vscode.window, "createStatusBarItem").mockImplementation(((...args: unknown[]) => {
      const item = createItem(...args);
      const show = item.show.bind(item);
      item.show = () => {
        shows += 1;
        show();
      };
      return item;
    }) as never);
    let pickerEvents = 0;
    vi.spyOn(vscode.lm, "registerLanguageModelChatProvider").mockImplementation(((_vendor: string, p: unknown) => {
      (p as { onDidChangeLanguageModelChatInformation(listener: () => void): void }).onDidChangeLanguageModelChatInformation(
        () => void (pickerEvents += 1)
      );
      return { dispose() {} };
    }) as never);
    let panelProvider: { resolveWebviewView(view: unknown): void } | undefined;
    vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(((_id: string, p: unknown) => {
      panelProvider = p as typeof panelProvider;
      return { dispose() {} };
    }) as never);
    const notifications = [
      vi.spyOn(vscode.window, "showErrorMessage"),
      vi.spyOn(vscode.window, "showWarningMessage"),
      vi.spyOn(vscode.window, "showInformationMessage"),
    ];
    const ext = activated({ "omnicopilot.apiKey": "sk-global", "omnicopilot.apiKeyOrigins": JSON.stringify(["https://a.example"]) });
    const posted: Array<Record<string, unknown>> = [];
    panelProvider?.resolveWebviewView({
      visible: true,
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (message: Record<string, unknown>) => void posted.push(message),
      },
      onDidChangeVisibility: () => ({ dispose() {} }),
    });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const before = { shows, pickerEvents, posted: posted.length };

    // SecretStorage fails from the moment the new key has been written.
    ext.failReadsAfterNextWrite("SecretStorage unavailable [x](command:y)");
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("sk-new");
    await ext.run("omnicopilot.setApiKey");
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(before.posted));

    expect(shows).toBeGreaterThan(before.shows); // the status bar restarted
    expect(pickerEvents).toBe(before.pickerEvents + 1);
    expect(posted.at(-1)).toMatchObject({ type: "statusError" });
    expect(warnings.some((line) => line.includes("SecretStorage unavailable"))).toBe(true);
    for (const spy of notifications) {
      for (const call of spy.mock.calls) expect(String(call[0])).not.toContain("](");
    }
    ext.dispose();
  });

  it("does not delete the global key on an empty entry for a workspace that has no key yet", async () => {
    const ext = setUp({ switchOn: true });
    await typing(ext, "");
    expect(ext.secrets.get("omnicopilot.apiKey")).toBe("sk-global");
    ext.dispose();
  });
});

describe("OmniRoute: Refresh models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports how many chat models the server listed, after the chat-model filter", async () => {
    stubServer({ models: [chat("a/one"), chat("a/two"), chat("a/embed", "embedding")] });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.refreshModels");

    expect(texts(info)).toEqual(["Models listed from http://localhost:20128: 2."]);
    expect(warn).not.toHaveBeenCalled();
    ext.dispose();
  });

  it("does not let the address become a link in the result", async () => {
    stubServer({ models: [chat("a/one")] });
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const ext = activated();

    await ext.run("omnicopilot.refreshModels");

    const listed = texts(info).find((text) => text.startsWith("Models listed from"));
    expect(listed).toBeDefined();
    expect(listed).not.toContain("](");
    ext.dispose();
  });

  it("says the key was rejected, and not that the list was refreshed", async () => {
    stubServer({ listingStatus: 401 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated({ [SECRET_API_KEY]: "sk-1" });

    await ext.run("omnicopilot.refreshModels");

    expect(texts(warn)).toEqual(["OmniRoute at http://localhost:20128 rejected the API key (HTTP 401)."]);
    expect(info).not.toHaveBeenCalled();
    ext.dispose();
  });

  it("says the server needs a key when none is stored", async () => {
    stubServer({ listingStatus: 401 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.refreshModels");

    expect(texts(warn)).toEqual(["OmniRoute at http://localhost:20128 needs an API key (HTTP 401)."]);
    expect(info).not.toHaveBeenCalled();
    ext.dispose();
  });

  it("explains a withheld key instead of claiming the key was rejected", async () => {
    stubServer({ listingStatus: 401 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated({
      [SECRET_API_KEY]: "sk-1",
      [SECRET_API_KEY_ORIGINS]: JSON.stringify(["http://elsewhere.test"]),
    });

    await ext.run("omnicopilot.refreshModels");

    const shown = texts(warn);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("is not being sent to");
    expect(shown[0]).not.toContain("rejected the API key");
    expect(info).not.toHaveBeenCalled();
    ext.dispose();
  });

  const WITHHELD = {
    [SECRET_API_KEY]: "sk-1",
    [SECRET_API_KEY_ORIGINS]: JSON.stringify(["http://elsewhere.test"]),
  };
  const COULD_NOT_REACH = "Could not reach OmniRoute at http://localhost:20128. Is it running?";

  it("shows only the could-not-reach message when the key is withheld and the server fails with a 500", async () => {
    stubServer({ listingStatus: 500 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated(WITHHELD);

    await ext.run("omnicopilot.refreshModels");

    expect(texts(warn)).toEqual([COULD_NOT_REACH]);
    ext.dispose();
  });

  it("shows only the could-not-reach message when the key is withheld and the server is unreachable", async () => {
    stubUnreachable();
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated(WITHHELD);

    await ext.run("omnicopilot.refreshModels");

    expect(texts(warn)).toEqual([COULD_NOT_REACH]);
    ext.dispose();
  });

  it("shows the could-not-reach message for an unreachable server, not a success", async () => {
    stubUnreachable();
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.refreshModels");

    expect(texts(warn)).toEqual(["Could not reach OmniRoute at http://localhost:20128. Is it running?"]);
    expect(info).not.toHaveBeenCalled();
    ext.dispose();
  });
});

describe("OmniRoute: Check connection after a real listing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("says connected once the listing was accepted", async () => {
    stubServer({ models: [chat("a/one")] });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    expect(texts(info)).toEqual(["Connected to OmniRoute at http://localhost:20128."]);
    expect(warn).not.toHaveBeenCalled();
    ext.dispose();
  });

  it("does not say connected when the server answers the probe but rejects the listing", async () => {
    stubServer({ listingStatus: 403 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated({ [SECRET_API_KEY]: "sk-1" });

    await ext.run("omnicopilot.checkConnection");

    expect(texts(warn)).toEqual(["OmniRoute at http://localhost:20128 rejected the API key (HTTP 403)."]);
    expect(texts(info).filter((text) => text.startsWith("Connected"))).toEqual([]);
    ext.dispose();
  });

  it("says the server needs a key when it rejects the listing and none is stored", async () => {
    stubServer({ listingStatus: 401 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    expect(texts(warn)).toEqual(["OmniRoute at http://localhost:20128 needs an API key (HTTP 401)."]);
    expect(texts(info).filter((text) => text.startsWith("Connected"))).toEqual([]);
    ext.dispose();
  });

  it("shows only the could-not-reach message when the key is withheld and the listing fails with a 500", async () => {
    stubServer({ listingStatus: 500 });
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated({
      [SECRET_API_KEY]: "sk-1",
      [SECRET_API_KEY_ORIGINS]: JSON.stringify(["http://elsewhere.test"]),
    });

    await ext.run("omnicopilot.checkConnection");

    expect(texts(warn)).toEqual(["Could not reach OmniRoute at http://localhost:20128. Is it running?"]);
    expect(texts(info).filter((text) => text.startsWith("Connected"))).toEqual([]);
    ext.dispose();
  });

  it("reports a check of the connection in effect when the connection changed while the probe ran", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let holdNext = false;
    let failHeld: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          if (!holdNext) return new Response(null, { status: 200 });
          holdNext = false;
          return new Promise<Response>((_resolve, reject) => {
            failHeld = () => reject(new TypeError("fetch failed"));
          });
        }
        if (String(url).includes("/combos")) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ object: "list", data: [chat("a/one")] }), { status: 200 });
      })
    );
    setMockConfig({ baseUrl: "http://localhost:20128" });
    let onConfigChange: ((e: { affectsConfiguration(section: string): boolean }) => void) | undefined;
    vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation(((cb: typeof onConfigChange) => {
      onConfigChange = cb;
      return { dispose() {} };
    }) as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();
    await vi.advanceTimersByTimeAsync(300);

    holdNext = true;
    const check = ext.run("omnicopilot.checkConnection") as Promise<void>;
    await vi.waitFor(() => expect(failHeld).toBeDefined());
    // The connection changes while the command's probe is out; the probe of the old one then fails.
    onConfigChange?.({ affectsConfiguration: (section) => section === "omnicopilot" || section === "omnicopilot.modelFilter" });
    failHeld?.();
    await vi.advanceTimersByTimeAsync(300);
    await check;

    expect(texts(info)).toEqual(["Connected to OmniRoute at http://localhost:20128."]);
    expect(warn).not.toHaveBeenCalled();
    ext.dispose();
    vi.useRealTimers();
  });

  it("keeps the diagnosis for an unreachable server", async () => {
    stubUnreachable();
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const ext = activated();

    await ext.run("omnicopilot.checkConnection");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("rejected the API key");
    expect(info).not.toHaveBeenCalled();
    ext.dispose();
  });
});

describe("a key changed in another window", () => {
  const WS = "file:///work/acme";
  // Fake timers: the 150 ms debounce and the start-up poll run on advanced time, not on waits.
  // Only the timer functions are faked, so promises and the stubbed fetch run as usual.
  const settle = () => vi.advanceTimersByTimeAsync(450);

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  /** An activated extension with a global key for A, its panel open, and a server that records every request. */
  function open() {
    const requests: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization);
        requests.push({ url: `${init?.method ?? "GET"} ${String(url)}`, auth });
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        if (String(url).includes("/api/usage/om-usage")) {
          return new Response(JSON.stringify({ allowed: true, personal: null, provider: null }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (String(url).includes("/combos")) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ object: "list", data: [chat("a/one")] }), { status: 200 });
      })
    );
    setMockConfig({ baseUrl: "https://a.example" });
    setMockWorkspace({ folders: [WS] });
    let panelProvider: { resolveWebviewView(view: unknown): void } | undefined;
    vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(((_id: string, p: unknown) => {
      panelProvider = p as typeof panelProvider;
      return { dispose() {} };
    }) as never);
    let pickerRefreshes = 0;
    vi.spyOn(vscode.lm, "registerLanguageModelChatProvider").mockImplementation(((_vendor: string, p: unknown) => {
      (p as { onDidChangeLanguageModelChatInformation(listener: () => void): void }).onDidChangeLanguageModelChatInformation(
        () => void (pickerRefreshes += 1)
      );
      return { dispose() {} };
    }) as never);
    const ext = activated({
      [SECRET_API_KEY]: "sk-old",
      [SECRET_API_KEY_ORIGINS]: JSON.stringify(["https://a.example"]),
    });
    const statuses: Array<Record<string, unknown>> = [];
    let onVisible: (() => void) | undefined;
    const view = {
      visible: true,
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (message: Record<string, unknown>) => void statuses.push(message),
      },
      onDidChangeVisibility: (cb: () => void) => {
        onVisible = cb;
        return { dispose() {} };
      },
    };
    panelProvider?.resolveWebviewView(view);
    /** How many times the model picker was told to list again. */
    const listings = () => pickerRefreshes;
    const becameVisible = () => {
      view.visible = true;
      onVisible?.();
    };
    return { ext, view, requests, statuses, listings, becameVisible };
  }

  it("refreshes the model list, the status bar's usage and the panel", async () => {
    const { ext, requests, statuses, listings } = open();
    await settle();
    expect(requests.some((r) => r.url.includes("/api/usage/om-usage"))).toBe(true);
    const listingsBefore = listings();
    const statusesBefore = statuses.length;

    ext.changedElsewhere(SECRET_API_KEY, "sk-new");
    await settle();

    expect(listings()).toBeGreaterThan(listingsBefore);
    expect(requests.some((r) => r.url.includes("/api/usage/om-usage") && r.auth === "Bearer sk-new")).toBe(true);
    expect(statuses.length).toBeGreaterThan(statusesBefore);
    ext.dispose();
  });

  it("refreshes once for the three writes of one stored key", async () => {
    const { ext, listings, statuses } = open();
    await settle();
    ext.changedElsewhere(SECRET_API_KEY, "sk-single");
    await settle();
    const oneChange = { listings: listings(), statuses: statuses.length };
    const base = { listings: oneChange.listings, statuses: oneChange.statuses };

    ext.changedElsewhere(SECRET_API_KEY_ORIGINS, JSON.stringify([]));
    ext.changedElsewhere(SECRET_API_KEY, "sk-burst");
    ext.changedElsewhere(SECRET_API_KEY_ORIGINS, JSON.stringify(["https://a.example"]));
    await settle();

    // One more refresh, the same size as the one a single change caused.
    const afterBurst = { listings: listings(), statuses: statuses.length };
    expect(afterBurst.listings - base.listings).toBe(1);
    expect(afterBurst.statuses - base.statuses).toBe(1);
    ext.dispose();
  });

  it("follows the key of this workspace, and ignores a secret that is not a key", async () => {
    const { ext, listings } = open();
    await settle();
    const before = listings();

    ext.changedElsewhere("some.other.extension.token", "x");
    ext.changedElsewhere(workspaceSecretName("file:///work/another"), "sk-elsewhere");
    await settle();
    expect(listings()).toBe(before);

    // This workspace follows its own key, so its pair changing changes the key in effect.
    ext.local.set("omnicopilot.useWorkspaceKey", true);
    ext.changedElsewhere(workspaceSecretName(WS), "sk-ws");
    await settle();
    expect(listings()).toBeGreaterThan(before);
    ext.dispose();
  });

  it("costs nothing when the pair of this workspace changes while this workspace uses the global key", async () => {
    const { ext, requests, statuses, listings } = open();
    await settle();
    const before = { requests: requests.length, statuses: statuses.length, listings: listings() };

    // The switch is off: the global key stays in effect and nothing this window shows changes.
    ext.changedElsewhere(workspaceOriginsSecretName(WS), JSON.stringify([]));
    ext.changedElsewhere(workspaceSecretName(WS), "sk-ws");
    ext.changedElsewhere(workspaceOriginsSecretName(WS), JSON.stringify(["https://a.example"]));
    await settle();

    expect({ requests: requests.length, statuses: statuses.length, listings: listings() }).toEqual(before);
    ext.dispose();
  });

  it("builds no status while the panel is hidden, and a fresh one when it is shown again", async () => {
    const { ext, view, statuses, listings, becameVisible } = open();
    await settle();
    const statusesBefore = statuses.length;
    const listingsBefore = listings();

    view.visible = false;
    ext.changedElsewhere(SECRET_API_KEY, "sk-while-hidden");
    await settle();
    // The model list and the status bar still follow the key; only the hidden panel is left alone.
    expect(listings()).toBeGreaterThan(listingsBefore);
    expect(statuses.length).toBe(statusesBefore);

    becameVisible();
    await settle();
    expect(statuses.length).toBe(statusesBefore + 1);
    expect(statuses.at(-1)).toMatchObject({ type: "status", hasKey: true });
    ext.dispose();
  });

  it("stops listening when the extension is disposed", async () => {
    const { ext, listings } = open();
    await settle();
    expect(ext.secretListenerCount()).toBe(1);
    const before = listings();

    ext.changedElsewhere(SECRET_API_KEY, "sk-late");
    ext.dispose();
    await settle();

    expect(ext.secretListenerCount()).toBe(0);
    expect(listings()).toBe(before);
  });
});

describe("the panel's model count and its refreshes", () => {
  // Fake timer functions only: the start-up poll and the waits below run on advanced time.
  const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type View = {
    visible: boolean;
    webview: {
      options: object;
      html: string;
      onDidReceiveMessage(cb: (msg: Record<string, unknown>) => unknown): { dispose(): void };
      postMessage(message: Record<string, unknown>): Promise<void>;
    };
    onDidChangeVisibility(cb: () => void): { dispose(): void };
  };

  /** An activated extension on a server listing four rows (three chat, one embedding),
   * with the panel open and its webview recorded, and the model picker reachable. */
  function open(config: Record<string, unknown> = {}) {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        if (String(url).includes("/api/usage/")) return new Response("{}", { status: 404 });
        if (String(url).includes("/combos")) return new Response("{}", { status: 404 });
        return new Response(
          JSON.stringify({
            object: "list",
            data: [chat("a/one"), chat("a/two"), chat("b/three"), chat("a/embed", "embedding")],
          }),
          { status: 200 }
        );
      })
    );
    setMockConfig({ baseUrl: "http://localhost:20128", ...config });
    let panelProvider: { resolveWebviewView(view: unknown): void } | undefined;
    vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(((_id: string, p: unknown) => {
      panelProvider = p as typeof panelProvider;
      return { dispose() {} };
    }) as never);
    let picker:
      | { provideLanguageModelChatInformation(o: { silent: boolean }, t: unknown): Promise<unknown[]> }
      | undefined;
    vi.spyOn(vscode.lm, "registerLanguageModelChatProvider").mockImplementation(((_vendor: string, p: unknown) => {
      picker = p as typeof picker;
      // The host lists again whenever the provider says its models changed.
      (p as { onDidChangeLanguageModelChatInformation(listener: () => void): void }).onDidChangeLanguageModelChatInformation(
        () => void picker?.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false })
      );
      return { dispose() {} };
    }) as never);
    let onConfigChange: ((e: { affectsConfiguration(section: string): boolean }) => void) | undefined;
    vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation(((cb: typeof onConfigChange) => {
      onConfigChange = cb;
      return { dispose() {} };
    }) as never);
    const ext = activated();
    const statuses: Array<Record<string, unknown>> = [];
    let onMessage: ((msg: Record<string, unknown>) => unknown) | undefined;
    let onVisible: (() => void) | undefined;
    const view: View = {
      visible: true,
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: (cb) => {
          onMessage = cb;
          return { dispose() {} };
        },
        postMessage: async (message) => void statuses.push(message),
      },
      onDidChangeVisibility: (cb) => {
        onVisible = cb;
        return { dispose() {} };
      },
    };
    panelProvider?.resolveWebviewView(view);
    return {
      ext,
      view,
      statuses,
      catalogDownloads: () => requests.filter((r) => /^GET .*\/v1\/models/.test(r)).length,
      /** What the webview script sends once it has loaded. */
      ready: () => onMessage?.({ type: "ready" }),
      pickerListing: () => picker?.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false }),
      configurationChanged: () => onConfigChange?.({ affectsConfiguration: () => true }),
      becameVisible: () => {
        view.visible = true;
        onVisible?.();
      },
    };
  }

  const lastStatus = (statuses: Array<Record<string, unknown>>) => statuses.filter((s) => s.type === "status").at(-1);

  it("shows the number of models the picker lists, after the chat-model filter and omnicopilot.modelFilter", async () => {
    const { ext, statuses } = open({ modelFilter: "^a/" });

    await settle();

    // Four rows in the catalog; the embedding row and b/three are not in the picker.
    expect(lastStatus(statuses)).toMatchObject({ online: true, modelCount: 2 });
    ext.dispose();
  });

  it("adds no catalog download of its own when the panel opens, sends ready or becomes visible", async () => {
    const { ext, statuses, catalogDownloads, ready, pickerListing, becameVisible } = open();
    // Start-up settles: the first poll finds the server and the host lists again.
    await settle();
    expect(lastStatus(statuses)).toBeDefined();
    const providersOwn = catalogDownloads();

    void ready();
    becameVisible();
    await settle(100);
    expect(catalogDownloads()).toBe(providersOwn);

    // The picker listing again is the provider's own, and the panel then reads its count.
    await pickerListing();
    expect(catalogDownloads()).toBe(providersOwn + 1);
    becameVisible();
    await settle(100);
    expect(catalogDownloads()).toBe(providersOwn + 1);
    expect(lastStatus(statuses)).toMatchObject({ modelCount: 3 });
    ext.dispose();
  });

  it("does not refresh while hidden, and does once it is visible again", async () => {
    const { ext, view, statuses, configurationChanged, becameVisible } = open();
    await settle();
    const before = statuses.length;

    view.visible = false;
    configurationChanged();
    await settle(100);
    expect(statuses.length).toBe(before);

    becameVisible();
    await settle(100);
    expect(statuses.length).toBe(before + 1);
    ext.dispose();
  });
});

describe("the status bar without a key in effect", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const usageRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/api/usage/") || url.includes("/v1/me/status"));

  function serverThatAnswersEverything() {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      if (String(url).includes("/api/usage/")) {
        return new Response(JSON.stringify({ allowed: true, personal: null, provider: null }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it.each([
    ["no key is stored", {}],
    [
      "the stored key is withheld from this server",
      { [SECRET_API_KEY]: "sk-1", [SECRET_API_KEY_ORIGINS]: JSON.stringify(["https://elsewhere.example"]) },
    ],
  ])("makes no usage request when %s", async (_name, secrets) => {
    const fetchMock = serverThatAnswersEverything();
    setMockConfig({ baseUrl: "https://a.example" });
    const ext = activated(secrets);

    await vi.advanceTimersByTimeAsync(500);

    // The poll did run (a HEAD probe), and still asked nothing about usage.
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "HEAD")).toBe(true);
    expect(usageRequests(fetchMock)).toEqual([]);
    ext.dispose();
  });

  it("does ask for usage once a key is in effect (the control for the two cases above)", async () => {
    const fetchMock = serverThatAnswersEverything();
    setMockConfig({ baseUrl: "https://a.example" });
    const ext = activated({ [SECRET_API_KEY]: "sk-1", [SECRET_API_KEY_ORIGINS]: JSON.stringify(["https://a.example"]) });

    await vi.advanceTimersByTimeAsync(500);

    expect(usageRequests(fetchMock).length).toBeGreaterThan(0);
    ext.dispose();
  });
});

describe("the context key the walkthrough's first step waits for", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The values given to `omnicopilot.serverOnline`, in order. */
  function contextValues(spy: ReturnType<typeof vi.spyOn>): unknown[] {
    return spy.mock.calls
      .filter((call: unknown[]) => call[0] === "setContext" && call[1] === "omnicopilot.serverOnline")
      .map((call: unknown[]) => call[2]);
  }

  it("is false at activation, true once the server answers, and false again when it stops", async () => {
    let up = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!up) throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
        if (init?.method === "HEAD") return new Response(null, { status: 200 });
        if (String(url).includes("/combos")) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ object: "list", data: [chat("a/one")] }), { status: 200 });
      })
    );
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const execute = vi.spyOn(vscode.commands, "executeCommand");
    const ext = activated();
    expect(contextValues(execute)).toEqual([false]);

    await vi.advanceTimersByTimeAsync(300);
    expect(contextValues(execute)).toEqual([false, true]);

    up = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(contextValues(execute)).toEqual([false, true, false]);
    ext.dispose();
  });

  it("stays false while the server cannot be reached", async () => {
    stubUnreachable();
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const execute = vi.spyOn(vscode.commands, "executeCommand");
    const ext = activated();

    await vi.advanceTimersByTimeAsync(300);

    // Set at activation, and again (still false) when the first poll finds the server offline.
    expect(contextValues(execute)[0]).toBe(false);
    expect(contextValues(execute)).not.toContain(true);
    ext.dispose();
  });

  it("does not follow a server URL set by the workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      // Only the workspace's address answers; the user-level one is down.
      if (String(url).startsWith("http://workspace.example")) return new Response(null, { status: 200 });
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    }));
    setMockConfig({ baseUrl: "http://localhost:20128" });
    setMockInspect("baseUrl", { workspaceValue: "http://workspace.example" });
    const execute = vi.spyOn(vscode.commands, "executeCommand");
    const ext = activated();

    await vi.advanceTimersByTimeAsync(300);

    // Set at activation, and again (still false) when the first poll finds the server offline.
    expect(contextValues(execute)[0]).toBe(false);
    expect(contextValues(execute)).not.toContain(true);
    ext.dispose();
  });
});
