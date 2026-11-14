import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registeredCommands, setMockConfig, setMockWorkspace } from "./vscode.mock";
import { workspaceOriginsSecretName, workspaceSecretName } from "../src/connection";
import { activate, deactivate } from "../src/extension";

const LINK_PAYLOAD =
  "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)";

/** Activate the extension against the mock, as an install that was already welcomed. */
function activated() {
  const secrets = new Map<string, string>();
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

describe("extension notifications built from the server URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not let the URL become a link in "Connected to OmniRoute at {0}."', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
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
