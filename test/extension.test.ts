import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registeredCommands, setMockConfig, setMockWorkspace } from "./vscode.mock";
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
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extension: { packageJSON: { version: "test" } },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: memento(state),
    workspaceState: memento(local),
  };
  activate(context as unknown as vscode.ExtensionContext);
  return {
    secrets,
    local,
    run: (id: string) => registeredCommands.get(id)?.(),
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

    expect(texts(info)).toEqual(["2 models listed from http://localhost:20128."]);
    expect(warn).not.toHaveBeenCalled();
    ext.dispose();
  });

  it("does not let the address become a link in the result", async () => {
    stubServer({ models: [chat("a/one")] });
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const ext = activated();

    await ext.run("omnicopilot.refreshModels");

    const listed = texts(info).find((text) => text.includes("models listed"));
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

    expect(texts(info)).toEqual(["Connected to OmniRoute at http://localhost:20128/v1."]);
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
