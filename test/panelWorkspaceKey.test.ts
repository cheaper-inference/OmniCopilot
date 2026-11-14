import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig, setMockWorkspace } from "./vscode.mock";
import { OmniRouteClient } from "../src/client";
import type { ProbeResult } from "../src/diagnostics";
import { OmniPanelProvider, embeddedNextCheckboxValue, nextCheckboxValue } from "../src/panel";

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
  const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined);
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
