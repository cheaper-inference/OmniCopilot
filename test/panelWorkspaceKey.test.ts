import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConfigurationTarget, configUpdates, setMockConfig, setMockWorkspace } from "./vscode.mock";
import { OmniRouteClient } from "../src/client";
import { workspaceOriginsSecretName, workspaceSecretName } from "../src/connection";
import type { ProbeResult } from "../src/diagnostics";
import { OmniPanelProvider, embeddedNextCheckboxValue, nextCheckboxValue } from "../src/panel";
import { listedModels } from "./panelHelpers";

const WS = "file:///work/acme";
const offline: ProbeResult = { ok: false, failure: "refused" };

/** A panel over a context whose SecretStorage and workspaceState are plain maps. */
function openPanel() {
  vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
  setMockConfig({ baseUrl: "https://a.example" });
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  const context = {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
    workspaceState: {
      get: <T>(key: string, fallback?: T) => (state.has(key) ? (state.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => void state.set(key, value),
    },
  } as unknown as vscode.ExtensionContext;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined, listedModels());
  const posted: Array<Record<string, unknown>> = [];
  (panel as unknown as { view: unknown }).view = {
    webview: { postMessage: async (message: Record<string, unknown>) => void posted.push(message) },
  };
  const send = (msg: Record<string, unknown>) =>
    (panel as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage(msg);
  return { panel, posted, secrets, state, send };
}

const workspaceKeyName = (secrets: Map<string, string>) =>
  [...secrets.keys()].find((name) => name.startsWith("omnicopilot.apiKey.ws."));

describe("panel workspace key", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  it("saves a typed key as the workspace key when the box is ticked", async () => {
    setMockWorkspace({ folders: [WS] });
    const { send, secrets, state } = openPanel();

    await send({ type: "save", url: "https://a.example", apiKey: "sk-ws", useWorkspaceKey: true });

    expect(secrets.get("omnicopilot.apiKey")).toBeUndefined();
    expect(secrets.get(workspaceKeyName(secrets) ?? "")).toBe("sk-ws");
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(true);
  });

  it("saves a typed key as the global key, and the switch off, when the box is unticked", async () => {
    setMockWorkspace({ folders: [WS] });
    const { send, secrets, state } = openPanel();
    state.set("omnicopilot.useWorkspaceKey", true);

    await send({ type: "save", url: "https://a.example", apiKey: "sk-g", useWorkspaceKey: false });

    expect(secrets.get("omnicopilot.apiKey")).toBe("sk-g");
    expect(workspaceKeyName(secrets)).toBeUndefined();
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(false);
  });

  it("turns the switch on with no key typed, keeping the stored key", async () => {
    setMockWorkspace({ folders: [WS] });
    const { send, secrets, state } = openPanel();
    secrets.set("omnicopilot.apiKey", "sk-g");
    secrets.set("omnicopilot.apiKeyOrigins", JSON.stringify(["https://a.example"]));

    await send({ type: "save", url: "https://a.example", apiKey: "", useWorkspaceKey: true });

    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(true);
    expect(secrets.get("omnicopilot.apiKey")).toBe("sk-g");
    expect(workspaceKeyName(secrets)).toBeUndefined();
  });

  it("reports the key in effect, whether a workspace is open and the switch", async () => {
    setMockWorkspace({ folders: [WS] });
    const { send, posted, panel } = openPanel();
    await send({ type: "save", url: "https://a.example", apiKey: "sk-ws", useWorkspaceKey: true });

    await panel.refreshStatus();

    expect(posted.at(-1)).toMatchObject({
      hasKey: true,
      keyScope: "workspace",
      workspaceKeyAvailable: true,
      useWorkspaceKey: true,
    });
    expect(JSON.stringify(posted)).not.toContain("sk-ws");
  });

  it("offers no box and reports the global key when no workspace is open", async () => {
    const { send, posted, panel } = openPanel();
    await send({ type: "save", url: "https://a.example", apiKey: "sk-g", useWorkspaceKey: true });

    await panel.refreshStatus();

    expect(posted.at(-1)).toMatchObject({ keyScope: "global", workspaceKeyAvailable: false });
  });

  it("clears only the key in effect", async () => {
    setMockWorkspace({ folders: [WS] });
    const { send, secrets, state } = openPanel();
    await send({ type: "save", url: "https://a.example", apiKey: "sk-g", useWorkspaceKey: false });
    await send({ type: "save", url: "https://a.example", apiKey: "sk-ws", useWorkspaceKey: true });

    await send({ type: "clearKey" });

    expect(workspaceKeyName(secrets)).toBeUndefined();
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(false);
    expect(secrets.get("omnicopilot.apiKey")).toBe("sk-g");

    await send({ type: "clearKey" });

    expect(secrets.has("omnicopilot.apiKey")).toBe(false);
  });

  it("treats anything but a true box as unticked", async () => {
    setMockWorkspace({ folders: [WS] });
    const { send, secrets } = openPanel();

    await send({ type: "save", url: "https://a.example", apiKey: "sk-g", useWorkspaceKey: "yes" });

    expect(secrets.get("omnicopilot.apiKey")).toBe("sk-g");
    expect(workspaceKeyName(secrets)).toBeUndefined();
  });
});

describe("nextCheckboxValue", () => {
  const cases = [
    { name: "first status", args: { current: false, lastReported: undefined, reported: true }, expected: true },
    { name: "untouched box", args: { current: false, lastReported: false, reported: true }, expected: true },
    { name: "box the user changed", args: { current: true, lastReported: false, reported: false }, expected: true },
  ];

  it.each(cases)("$name", ({ args, expected }) => {
    expect(nextCheckboxValue(args)).toBe(expected);
  });

  it("is embedded in the panel script and stands alone", () => {
    const { panel } = openPanel();
    const html = (panel as unknown as { html(): string }).html();
    expect(html).toContain(`const nextCheckboxValue = ${embeddedNextCheckboxValue()};`);
    const embedded = runInNewContext(`(${embeddedNextCheckboxValue()})`, {}) as typeof nextCheckboxValue;
    for (const { args, expected } of cases) expect(embedded(args)).toBe(expected);
    vi.restoreAllMocks();
  });
});

describe("panel document, workspace key", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has the box, hidden until a workspace is open, and the three texts, set through textContent", () => {
    const { panel } = openPanel();
    const html = (panel as unknown as { html(): string }).html();
    expect(html).toContain('id="useWs" type="checkbox"');
    expect(html).toMatch(/id="wsRow"[^>]*display:none/);
    expect(html).toContain('"useWorkspaceKey":"Use this key only in this workspace"');
    expect(html).toContain("Using this workspace's key");
    expect(html).toContain("Using your global key");
    expect(html).toContain('$("useWsText").textContent = S.useWorkspaceKey');
    expect(html).toContain('$("keyScope").textContent');
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(html, sink).not.toContain(sink);
    }
  });

  it("sends the box state in the save message", () => {
    const { panel } = openPanel();
    const html = (panel as unknown as { html(): string }).html();
    expect(html).toContain('useWorkspaceKey: $("useWs").checked');
  });
});

describe("a Save pressed before the panel's first status", () => {
  const TEAM = "https://team.example";
  const GLOBAL_KEY = "omnicopilot.apiKey";
  const GLOBAL_LIST = "omnicopilot.apiKeyOrigins";

  afterEach(() => {
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  type FakeElement = {
    id: string;
    value: string;
    checked: boolean;
    textContent: string;
    style: Record<string, string>;
    className: string;
    dataset: Record<string, string>;
    listeners: Record<string, () => void>;
    addEventListener(type: string, listener: () => void): void;
    append(...nodes: unknown[]): void;
    setAttribute(): void;
  };

  /** Runs the panel's real webview script against a minimal DOM. Nothing is delivered
   * to it until the test calls `deliver`; what it posts lands in `messages`. */
  function runScript(panel: OmniPanelProvider) {
    const html = (panel as unknown as { html(): string }).html();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    const elements = new Map<string, FakeElement>();
    let created = 0;
    const el = (id: string): FakeElement => {
      let found = elements.get(id);
      if (!found) {
        found = {
          id,
          value: "",
          checked: false,
          textContent: "",
          style: {},
          className: "",
          dataset: {},
          listeners: {},
          addEventListener(type, listener) {
            this.listeners[type] = listener;
          },
          append() {},
          setAttribute() {},
        };
        elements.set(id, found);
      }
      return found;
    };
    const messages: Array<Record<string, unknown>> = [];
    let onMessage: ((event: { data: unknown }) => void) | undefined;
    runInNewContext(script, {
      document: {
        getElementById: el,
        querySelectorAll: () => [],
        createElement: () => el(`created-${++created}`),
      },
      acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => void messages.push(message) }),
      window: {
        addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
          if (type === "message") onMessage = listener;
        },
      },
    });
    return {
      el,
      messages,
      deliver: (data: Record<string, unknown>) => onMessage?.({ data }),
      /** The user types into the URL field. */
      typeUrl: (value: string) => {
        el("url").value = value;
        el("url").listeners.input?.();
      },
      /** The user clicks the "only in this workspace" box. */
      clickBox: () => {
        el("useWs").checked = !el("useWs").checked;
        el("useWs").listeners.change?.();
      },
      /** The user pastes a key and presses Save & Test; returns the message posted. */
      save: (key: string) => {
        el("key").value = key;
        el("save").listeners.click();
        return messages.filter((message) => message.type === "save").at(-1)!;
      },
    };
  }

  /** A panel on TEAM with a global key, and, in a workspace, its own key in use. */
  function setUp(opts: { workspace: boolean }) {
    const ctx = openPanel();
    setMockConfig({ baseUrl: TEAM });
    ctx.secrets.set(GLOBAL_KEY, "sk-global-own");
    ctx.secrets.set(GLOBAL_LIST, JSON.stringify([TEAM]));
    if (opts.workspace) {
      setMockWorkspace({ folders: [WS] });
      ctx.secrets.set(workspaceSecretName(WS), "sk-ws-old");
      ctx.secrets.set(workspaceOriginsSecretName(WS), JSON.stringify([TEAM]));
      ctx.state.set("omnicopilot.useWorkspaceKey", true);
    }
    return { ...ctx, script: runScript(ctx.panel) };
  }

  const firstStatus = (fields: Record<string, unknown> = {}) => ({
    type: "status",
    online: false,
    url: TEAM,
    modelCount: null,
    hasKey: true,
    keyScope: "workspace",
    workspaceKeyAvailable: true,
    useWorkspaceKey: true,
    ...fields,
  });

  it("stores the key in the workspace that uses its own, and touches neither the global key, the switch nor the address", async () => {
    const { script, send, secrets, state } = setUp({ workspace: true });

    const message = script.save("sk-ws-new");
    expect(message).toEqual({ type: "save", apiKey: "sk-ws-new" });
    await send(message);

    expect(secrets.get(workspaceSecretName(WS))).toBe("sk-ws-new");
    expect(secrets.get(workspaceOriginsSecretName(WS))).toBe(JSON.stringify([TEAM]));
    expect(secrets.get(GLOBAL_KEY)).toBe("sk-global-own");
    expect(secrets.get(GLOBAL_LIST)).toBe(JSON.stringify([TEAM]));
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(true);
    expect(configUpdates).toEqual([]);
  });

  it("replaces the global key without a workspace, and leaves the address alone", async () => {
    const { script, send, secrets } = setUp({ workspace: false });

    const message = script.save("sk-global-new");
    expect(message).toEqual({ type: "save", apiKey: "sk-global-new" });
    await send(message);

    expect(secrets.get(GLOBAL_KEY)).toBe("sk-global-new");
    expect(secrets.get(GLOBAL_LIST)).toBe(JSON.stringify([TEAM]));
    expect(configUpdates).toEqual([]);
  });

  it("sends what the first status filled in, and the host acts on it as before", async () => {
    const { script, send, secrets, state } = setUp({ workspace: true });
    script.deliver(firstStatus());
    expect(script.el("url").value).toBe(TEAM);
    expect(script.el("useWs").checked).toBe(true);

    // The user unticks the box and saves a key: it becomes the global key, the switch goes off.
    script.clickBox();
    const message = script.save("sk-global-new");
    expect(message).toEqual({ type: "save", url: TEAM, apiKey: "sk-global-new", useWorkspaceKey: false });
    await send(message);

    expect(secrets.get(GLOBAL_KEY)).toBe("sk-global-new");
    expect(secrets.get(workspaceSecretName(WS))).toBe("sk-ws-old");
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(false);
    expect(configUpdates).toEqual([]);
  });

  it("still saves the default address when the user cleared the field after the first status", async () => {
    const { script, send } = setUp({ workspace: false });
    script.deliver(firstStatus({ workspaceKeyAvailable: false, useWorkspaceKey: false, keyScope: "global" }));

    script.typeUrl("");
    const message = script.save("");
    expect(message).toMatchObject({ url: "" });
    await send(message);

    expect(configUpdates).toEqual([
      { key: "baseUrl", value: "http://localhost:20128", target: ConfigurationTarget.Global },
    ]);
  });

  it("saves a URL the user typed before the first status, and keeps the key scope", async () => {
    const { script, send, secrets, state } = setUp({ workspace: true });

    script.typeUrl("https://new.example");
    const message = script.save("sk-ws-new");
    expect(message).toEqual({ type: "save", url: "https://new.example", apiKey: "sk-ws-new" });
    await send(message);

    expect(configUpdates).toEqual([
      { key: "baseUrl", value: "https://new.example", target: ConfigurationTarget.Global },
    ]);
    expect(secrets.get(workspaceSecretName(WS))).toBe("sk-ws-new");
    expect(secrets.get(workspaceOriginsSecretName(WS))).toBe(JSON.stringify(["https://new.example"]));
    expect(secrets.get(GLOBAL_KEY)).toBe("sk-global-own");
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(true);
  });

  it("keeps the configured address and the switch for a save message without url and useWorkspaceKey (host side)", async () => {
    const { send, secrets, state } = setUp({ workspace: true });

    await send({ type: "save", apiKey: "sk-ws-new" });

    expect(secrets.get(workspaceSecretName(WS))).toBe("sk-ws-new");
    expect(secrets.get(GLOBAL_KEY)).toBe("sk-global-own");
    expect(secrets.get(GLOBAL_LIST)).toBe(JSON.stringify([TEAM]));
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(true);
    expect(configUpdates).toEqual([]);
  });

  it("approves nothing new for a save message without url and without a key (host side)", async () => {
    const { send, secrets, state } = setUp({ workspace: true });

    await send({ type: "save", apiKey: "" });

    expect(secrets.get(workspaceOriginsSecretName(WS))).toBe(JSON.stringify([TEAM]));
    expect(secrets.get(GLOBAL_LIST)).toBe(JSON.stringify([TEAM]));
    expect(state.get("omnicopilot.useWorkspaceKey")).toBe(true);
    expect(configUpdates).toEqual([]);
  });

  it("sends the box once the user clicked it, even before the first status", () => {
    const { script } = setUp({ workspace: true });

    script.clickBox();

    expect(script.save("sk-x")).toEqual({ type: "save", apiKey: "sk-x", useWorkspaceKey: true });
  });
});
