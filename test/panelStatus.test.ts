import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConfigurationTarget, configUpdates, setMockConfig, setMockInspect, setMockWorkspace } from "./vscode.mock";
import { OmniRouteClient } from "../src/client";
import type { ProbeResult } from "../src/diagnostics";
import { resolveConnection, storeApiKey } from "../src/connection";
import { OmniPanelProvider } from "../src/panel";
import { listedModels } from "./panelHelpers";

function fakeContext() {
  const secrets = new Map<string, string>();
  return {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext;
}

/** A panel whose webview only records the messages it is sent. */
function openPanel(context: vscode.ExtensionContext = fakeContext()) {
  const posted: Array<Record<string, unknown>> = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const panel = new OmniPanelProvider(
    context,
    log as unknown as vscode.LogOutputChannel,
    async () => undefined,
    listedModels()
  );
  (panel as unknown as { view: unknown }).view = {
    webview: { postMessage: async (message: Record<string, unknown>) => void posted.push(message) },
  };
  return { panel, posted };
}

const offline: ProbeResult = { ok: false, failure: "refused" };

describe("panel status", () => {
  afterEach(() => vi.restoreAllMocks());

  it("notes a server URL set in the workspace's settings, which is ignored", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: "https://ws.example" });
    const { panel, posted } = openPanel();

    await panel.refreshStatus();

    expect(posted[0]).toMatchObject({
      url: "https://user.example",
      urlNote: "This workspace's settings set another server URL (https://ws.example). It is ignored.",
    });
  });

  it("has no note when the workspace sets nothing", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: "https://user.example" });
    const { panel, posted } = openPanel();

    await panel.refreshStatus();

    expect(posted[0]?.urlNote).toBeUndefined();
  });
});

describe("panel status ordering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops a status that finishes after a newer one", async () => {
    const pending: Array<(result: ProbeResult) => void> = [];
    vi.spyOn(OmniRouteClient.prototype, "probe").mockImplementation(
      () => new Promise<ProbeResult>((resolve) => void pending.push(resolve))
    );
    const { panel, posted } = openPanel();

    setMockConfig({ baseUrl: "http://192.168.0.1" }); // half-typed URL, slow probe
    const first = panel.refreshStatus();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    setMockConfig({ baseUrl: "http://192.168.0.15:20128" }); // the URL the user ended on
    const second = panel.refreshStatus();
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    pending[1](offline);
    await second;
    pending[0](offline);
    await first;

    expect(posted.map((status) => status.url)).toEqual(["http://192.168.0.15:20128"]);
  });
});

describe("panel Save", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A panel whose SecretStorage writes note how many settings writes came before them. */
  function savingPanel() {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    const secrets = new Map<string, string>();
    const writes: Array<{ name: string; value: string; settingsWritesBefore: number }> = [];
    const context = {
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => {
          secrets.set(key, value);
          writes.push({ name: key, value, settingsWritesBefore: configUpdates.length });
        },
        delete: async (key: string) => void secrets.delete(key),
      },
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined, listedModels());
    const save = (url: string, apiKey: string) =>
      (panel as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage({
        type: "save",
        url,
        apiKey,
      });
    return { secrets, writes, save };
  }

  it("approves the typed URL for a new key before writing the setting", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const { writes, save } = savingPanel();

    await save("https://b.example/", "sk-1");

    const approval = writes.find(
      (w) => w.name === "omnicopilot.apiKeyOrigins" && w.value === JSON.stringify(["https://b.example"])
    );
    expect(approval?.settingsWritesBefore).toBe(0);
    expect(configUpdates).toEqual([
      { key: "baseUrl", value: "https://b.example", target: ConfigurationTarget.Global },
    ]);
  });

  it("approves the typed URL for the stored key before writing the setting", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const { secrets, writes, save } = savingPanel();
    secrets.set("omnicopilot.apiKey", "sk-1");
    secrets.set("omnicopilot.apiKeyOrigins", JSON.stringify(["https://a.example"]));

    await save("https://b.example", "");

    const approval = writes.find((w) => w.name === "omnicopilot.apiKeyOrigins");
    expect(approval?.value).toBe(JSON.stringify(["https://a.example", "https://b.example"]));
    expect(approval?.settingsWritesBefore).toBe(0);
    expect(configUpdates).toHaveLength(1);
  });

  it("leaves the URL setting alone when only a key is saved", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const { secrets, save } = savingPanel();

    await save("https://a.example", "sk-1");

    expect(configUpdates).toEqual([]);
    expect(secrets.get("omnicopilot.apiKey")).toBe("sk-1");
    expect(secrets.get("omnicopilot.apiKeyOrigins")).toBe(JSON.stringify(["https://a.example"]));
  });
});

/** A webview view that records what the panel sets and lets the test post messages to it. */
function fakeView() {
  let onMessage: ((msg: Record<string, unknown>) => Promise<void>) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<void>) => {
        onMessage = cb;
        return { dispose() {} };
      },
      postMessage: async (message: Record<string, unknown>) => void posted.push(message),
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
  };
  return {
    view: view as unknown as vscode.WebviewView,
    posted,
    send: (msg: Record<string, unknown>) => onMessage?.(msg),
  };
}

describe("panel errors in notifications", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not let an error message become a link", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    const shown = vi.spyOn(vscode.window, "showErrorMessage");
    setMockConfig({ baseUrl: "https://user.example" });
    const context = {
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => {
          throw new Error(
            "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)"
          );
        },
      },
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined, listedModels());
    const { view, send } = fakeView();
    panel.resolveWebviewView(view);

    await send({ type: "clearKey" });

    expect(shown).toHaveBeenCalledTimes(1);
    expect(String(shown.mock.calls[0][0])).toMatch(/^OmniRoute: /);
    expect(String(shown.mock.calls[0][0])).not.toContain("](");
  });
});

describe("panel document", () => {
  it("builds no markup from strings at run time", () => {
    const { view } = fakeView();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    new OmniPanelProvider(fakeContext(), log as unknown as vscode.LogOutputChannel, async () => undefined, listedModels())
      .resolveWebviewView(view);
    const html = (view.webview as unknown as { html: string }).html;
    expect(html.length).toBeGreaterThan(1000);
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(html, sink).not.toContain(sink);
    }
    vi.restoreAllMocks();
  });
});

describe("panel status refresh that fails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the failure and tells the panel instead of leaving it on Checking…", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: "https://user.example" });
    const context = {
      secrets: {
        get: async () => {
          throw new Error("keychain locked");
        },
        store: async () => undefined,
        delete: async () => undefined,
      },
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
    } as unknown as vscode.ExtensionContext;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => undefined, listedModels());
    const posted: Array<Record<string, unknown>> = [];
    (panel as unknown as { view: unknown }).view = {
      webview: { postMessage: async (message: Record<string, unknown>) => void posted.push(message) },
    };

    await expect(panel.refreshStatus()).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("keychain locked"));
    expect(posted).toEqual([{ type: "statusError", detail: "OmniRoute: Error: keychain locked" }]);
  });

  it("renders the failure in the panel script", () => {
    const { view } = fakeView();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    new OmniPanelProvider(fakeContext(), log as unknown as vscode.LogOutputChannel, async () => undefined, listedModels())
      .resolveWebviewView(view);
    const html = (view.webview as unknown as { html: string }).html;
    expect(html).toContain('msg.type === "statusError"');
    expect(html).toContain("Could not read the connection status.");
  });
});

describe("panel usage without the usage command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts the key's own usage when om-usage refuses and /v1/me/status answers", async () => {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue({ ok: true, status: 200 });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ allowed: false }))
        .mockResolvedValueOnce(
          json({
            usage: { daily: { costUsd: 1.2, resetAt: "2999-01-01T00:00:00.000Z" } },
            limits: [
              {
                id: "usage_limit:daily",
                limit: 5,
                used: 1.2,
                exceeded: false,
                resetAt: "2999-01-01T00:00:00.000Z",
              },
            ],
          })
        )
    );
    setMockConfig({ baseUrl: "https://gateway.test" });
    const context = fakeContext();
    await storeApiKey(context, "sk-test", "https://gateway.test");
    const { panel, posted } = openPanel(context);

    await panel.refreshStatus();

    expect(posted[0]?.usage).toMatchObject({
      kind: "ready",
      providers: [],
      personal: { dailyLimitUsd: 5, dailyText: "$1.20 / $5.00 (76% left)", weeklyText: "" },
    });
  });
});

describe("panel usage section: which state it shows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** An online server whose usage endpoints answer with `answers`, in order. */
  function onlineServer(...answers: Array<() => Response>) {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue({ ok: true, status: 200 });
    const fetchMock = vi.fn();
    for (const answer of answers) fetchMock.mockImplementationOnce(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("calls no usage endpoint and shows no section when no key is stored", async () => {
    const fetchMock = onlineServer(() => json({ allowed: false, error: { message: "auth required" } }, 401));
    setMockConfig({ baseUrl: "http://localhost:20128" });
    const { panel, posted } = openPanel();

    await panel.refreshStatus();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ type: "status", online: true });
    expect(posted[0]?.usage).toBeUndefined();
  });

  it("calls no usage endpoint and shows no section when the stored key is withheld from this server", async () => {
    const fetchMock = onlineServer(() => json({ allowed: true, personal: null, provider: null }));
    setMockConfig({ baseUrl: "https://a.example" });
    const context = fakeContext();
    await storeApiKey(context, "sk-test", "https://a.example");
    setMockConfig({ baseUrl: "https://b.example" });
    const { panel, posted } = openPanel(context);

    await panel.refreshStatus();

    expect(posted[0]).toMatchObject({ type: "status", hasKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted[0]?.usage).toBeUndefined();
  });

  it.each([
    ["a 500 with an error body", () => json({ error: { message: "boom" } }, 500)],
    ["a 400 JSON body without allowed", () => json({ error: { message: "bad request" } }, 400)],
    ["a 404 JSON body without allowed", () => json({ message: "not found" }, 404)],
    ["a 200 JSON body without allowed", () => json({ hello: "world" })],
    [
      "a gateway's HTML error page",
      () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
    ],
  ])("hides the section for %s, never 'nothing is cached yet'", async (_name, answer) => {
    onlineServer(answer);
    setMockConfig({ baseUrl: "https://gateway.test" });
    const context = fakeContext();
    await storeApiKey(context, "sk-test", "https://gateway.test");
    const { panel, posted } = openPanel(context);

    await panel.refreshStatus();

    expect(posted[0]).toMatchObject({ type: "status", online: true });
    expect(posted[0]?.usage).toBeUndefined();
  });

  it("still shows the section for a real refusal (allowed: false) with a key", async () => {
    onlineServer(
      () => json({ allowed: false, error: { message: "off" } }, 403),
      () => json({}, 404)
    );
    setMockConfig({ baseUrl: "https://gateway.test" });
    const context = fakeContext();
    await storeApiKey(context, "sk-test", "https://gateway.test");
    const { panel, posted } = openPanel(context);

    await panel.refreshStatus();

    expect(posted[0]?.usage).toMatchObject({ kind: "disabled" });
  });

  it("calls the usage endpoints on the same server root as the models, for a URL set without a scheme", async () => {
    const fetchMock = onlineServer(
      () => json({ allowed: false }, 403),
      () => json({}, 404)
    );
    setMockConfig({ baseUrl: "192.168.0.17:20128" });
    const context = fakeContext();
    await context.secrets.store("omnicopilot.apiKey", "sk-test");
    await context.secrets.store("omnicopilot.apiKeyOrigins", JSON.stringify(["http://192.168.0.17:20128"]));
    const { panel, posted } = openPanel(context);

    await panel.refreshStatus();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://192.168.0.17:20128/api/usage/om-usage?format=json",
      "http://192.168.0.17:20128/v1/me/status",
    ]);
    expect(posted[0]?.usage).toMatchObject({ kind: "disabled" });
  });
});

describe("panel Save of a new key together with a new server URL", () => {
  afterEach(() => vi.restoreAllMocks());

  const OLD = "https://old.example";
  const NEW = "https://new.example";

  /** Every observable step of the save, each followed by what `resolveConnection`
   * would hand a request made at that very moment. */
  async function recordedSave(opts: {
    /** Which key is stored before the save (approved for the old server only). */
    oldKey: "global" | "workspace";
    /** The "only in this workspace" switch before the save. */
    switchOn: boolean;
    /** The box ticked in the panel when Save is pressed. */
    ticked: boolean;
  }) {
    vi.spyOn(OmniRouteClient.prototype, "probe").mockResolvedValue(offline);
    setMockConfig({ baseUrl: OLD });
    setMockWorkspace({ folders: ["file:///work/acme"] });
    const secrets = new Map<string, string>();
    const local = new Map<string, unknown>();
    const steps: Array<{ step: string; origin: string; apiKey: string | undefined; approved: string[] }> = [];
    const context = {
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => {
          secrets.set(key, value);
          await snapshot(`store ${key.replace(/\.ws\.[0-9a-f]+$/, ".ws")}`);
        },
        delete: async (key: string) => {
          secrets.delete(key);
          await snapshot(`delete ${key}`);
        },
      },
      globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
      workspaceState: {
        get: <T>(key: string, fallback?: T) => (local.has(key) ? (local.get(key) as T) : fallback),
        update: async (key: string, value: unknown) => {
          local.set(key, value);
          // The switch decides which key is in effect, so its flip is a step of its own.
          await snapshot(`switch ${String(value)}`);
        },
      },
    } as unknown as vscode.ExtensionContext;
    async function snapshot(step: string) {
      const connection = await resolveConnection(context);
      steps.push({
        step,
        origin: connection.origin,
        apiKey: connection.apiKey,
        approved: connection.approvedOrigins,
      });
    }
    const realGetConfiguration = vscode.workspace.getConfiguration.bind(vscode.workspace);
    vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation((section?: string) => {
      const configuration = realGetConfiguration(section);
      return {
        ...configuration,
        inspect: configuration.inspect,
        update: async (key: string, value: unknown, target?: unknown) => {
          await configuration.update(key, value, target as never);
          await snapshot(`setting ${key}`);
        },
      } as never;
    });

    // The state before the save: an old key, approved for the old server only.
    await storeApiKey(context, "sk-old", OLD, opts.oldKey);
    local.set("omnicopilot.useWorkspaceKey", opts.switchOn);
    steps.length = 0;

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const panel = new OmniPanelProvider(context, log as unknown as vscode.LogOutputChannel, async () => {
      await snapshot("refresh requested");
    });
    await (panel as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage({
      type: "save",
      url: NEW,
      apiKey: "sk-new",
      useWorkspaceKey: opts.ticked,
    });
    return steps;
  }

  it.each([
    ["a global key, box unticked", { oldKey: "global", switchOn: false, ticked: false }],
    ["a workspace key replaced, box ticked", { oldKey: "workspace", switchOn: true, ticked: true }],
    ["a global key, switch off, box ticked (the save flips the switch)", { oldKey: "global", switchOn: false, ticked: true }],
  ] as const)("never lets a key reach the wrong server at any step: %s", async (_name, opts) => {
    const steps = await recordedSave(opts);

    // The recording has the writes of the save in it (a failing test names the missing one).
    expect(steps.map((entry) => entry.step.split(" ")[0])).toEqual(
      expect.arrayContaining(["store", "setting", "refresh"])
    );
    for (const entry of steps) {
      // (a) the new key is never sent to, or approved for, the old server
      if (entry.apiKey === "sk-new") expect(entry.origin, entry.step).toBe(NEW);
      // (b) the old key is never sent to the new server
      if (entry.apiKey === "sk-old") expect(entry.origin, entry.step).toBe(OLD);
      // (c) a refresh that happens against the new server carries the new key
      if (entry.origin === NEW) expect(entry.apiKey, entry.step).toBe("sk-new");
      if (entry.step === "refresh requested") expect(entry.apiKey).toBe("sk-new");
      // no step lists the new server as approved next to the old one
      expect(entry.approved.includes(OLD) && entry.approved.includes(NEW), entry.step).toBe(false);
    }
    const last = steps.at(-1)!;
    expect(last).toMatchObject({ origin: NEW, apiKey: "sk-new", approved: [NEW] });
  });

  it("records the flip of the switch as a step, with the old global key out of effect after it", async () => {
    const steps = await recordedSave({ oldKey: "global", switchOn: false, ticked: true });

    const flip = steps.find((entry) => entry.step === "switch true");
    expect(flip).toBeDefined();
    // At the flip the workspace key is in effect: approved for the new server only, so
    // it is withheld from the old one still configured, and the old global key is not sent.
    expect(flip).toMatchObject({ origin: OLD, apiKey: undefined });
  });
});
