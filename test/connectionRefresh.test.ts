import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registeredCommands, setMockConfig, setMockWorkspace, workspace as mockWorkspace } from "./vscode.mock";
import { workspaceOriginsSecretName, workspaceSecretName } from "../src/connection";
import { activate, deactivate } from "../src/extension";

/**
 * What one user action costs on the wire, through the real `activate()`. The host
 * model lists the way VS Code does: silently on every change event, one listing
 * running and one queued. The server refuses `om-usage` and answers
 * `/v1/me/status`, so one usage read is two requests.
 */

const WS = "file:///work/acme";
const A = "https://a.example";
/** The share of its daily limit each key has left. */
const LEFT: Record<string, number> = { "sk-global": 50, "sk-ws": 80, "sk-global2": 20, "sk-new": 65 };

type Kind = "probe" | "models" | "combos" | "om-usage" | "me/status";

function kindOf(method: string, path: string): Kind {
  if (method === "HEAD") return "probe";
  if (path.endsWith("/combos")) return "combos";
  if (path.endsWith("/om-usage")) return "om-usage";
  if (path.endsWith("/me/status")) return "me/status";
  return "models";
}

function harness(opts: { secrets?: Record<string, string>; switchOn?: boolean }) {
  const requests: Array<{ kind: Kind; auth: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "-").replace(
        "Bearer ",
        ""
      );
      const method = init?.method ?? "GET";
      requests.push({ kind: kindOf(method, u.pathname), auth });
      const valid = auth in LEFT;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (method === "HEAD") return new Response(null, { status: valid ? 200 : 401 });
      if (u.pathname.endsWith("/combos")) return valid ? json({ object: "list", data: [] }) : json({}, 401);
      if (u.pathname.endsWith("/models")) {
        return valid
          ? json({ object: "list", data: [{ id: "a/1" }, { id: "a/2" }, { id: "a/3" }] })
          : json({ error: { message: "no" } }, 401);
      }
      if (u.pathname.endsWith("/om-usage")) return json({ allowed: false }, valid ? 403 : 401);
      if (u.pathname.endsWith("/me/status")) {
        if (!valid) return json({ error: "Unauthorized" }, 401);
        return json({
          usage: {},
          limits: [{ id: "usage_limit:daily", limit: 100, used: 100 - LEFT[auth], exceeded: false, resetAt: null }],
        });
      }
      return json({}, 404);
    })
  );
  setMockConfig({ baseUrl: A });
  setMockWorkspace({ name: "acme", folders: [WS] });

  const secrets = new Map<string, string>(Object.entries(opts.secrets ?? {}));
  const secretListeners = new Set<(e: { key: string }) => void>();
  const fire = (key: string) => {
    for (const listener of [...secretListeners]) listener({ key });
  };
  const state = new Map<string, unknown>([["omnicopilot.welcomed", true]]);
  const local = new Map<string, unknown>(opts.switchOn ? [["omnicopilot.useWorkspaceKey", true]] : []);
  const memento = (store: Map<string, unknown>) => ({
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void store.set(key, value),
  });
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extension: { packageJSON: { version: "test" } },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
        fire(key);
      },
      delete: async (key: string) => {
        secrets.delete(key);
        fire(key);
      },
      onDidChange: (listener: (e: { key: string }) => void) => {
        secretListeners.add(listener);
        return { dispose: () => void secretListeners.delete(listener) };
      },
    },
    globalState: memento(state),
    workspaceState: memento(local),
  };

  // The host: lists again on every change event, silently, one running and one queued.
  let provider:
    | {
        provideLanguageModelChatInformation(o: { silent: boolean }, t: unknown): Promise<unknown[]>;
        onDidChangeLanguageModelChatInformation(listener: () => void): unknown;
      }
    | undefined;
  let running = false;
  let queued = false;
  let changeEvents = 0;
  const hostList = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await provider?.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false });
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void hostList();
      }
    }
  };
  vi.spyOn(vscode.lm, "registerLanguageModelChatProvider").mockImplementation(((_vendor: string, p: unknown) => {
    provider = p as typeof provider;
    provider!.onDidChangeLanguageModelChatInformation(() => {
      changeEvents += 1;
      void hostList();
    });
    return { dispose() {} };
  }) as never);

  let panelProvider: { resolveWebviewView(view: unknown): void } | undefined;
  vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(((_id: string, p: unknown) => {
    panelProvider = p as typeof panelProvider;
    return { dispose() {} };
  }) as never);
  // A settings write fires the configuration change, as in VS Code.
  const configHandlers: Array<(e: unknown) => void> = [];
  vi.spyOn(mockWorkspace, "onDidChangeConfiguration").mockImplementation(((handler: (e: unknown) => void) => {
    configHandlers.push(handler);
    return { dispose() {} };
  }) as never);
  const realGetConfiguration = mockWorkspace.getConfiguration.bind(mockWorkspace);
  vi.spyOn(mockWorkspace, "getConfiguration").mockImplementation(((section?: string) => {
    const configuration = realGetConfiguration(section);
    const update = configuration.update;
    configuration.update = async (...args: [string, unknown, unknown?]) => {
      await update(...args);
      for (const handler of configHandlers) handler({ affectsConfiguration: () => true });
    };
    return configuration;
  }) as never);

  activate(context as never);
  void hostList(); // the host's first listing

  let onMessage: (message: unknown) => Promise<void> = async () => undefined;
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      postMessage: async () => true,
      onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
        onMessage = handler;
        return { dispose() {} };
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
  };
  return {
    secrets,
    /** Another window wrote this secret: the value changes and every window is told. */
    changedElsewhere: (key: string, value: string | undefined) => {
      if (value === undefined) secrets.delete(key);
      else secrets.set(key, value);
      fire(key);
    },
    openPanel: () => panelProvider?.resolveWebviewView(view),
    send: (message: unknown) => onMessage(message),
    settle: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    /** The requests since the last call, counted by kind, and the keys they carried. */
    take: () => {
      const taken = requests.splice(0);
      const counts: Partial<Record<Kind, number>> = {};
      for (const request of taken) counts[request.kind] = (counts[request.kind] ?? 0) + 1;
      return { counts, keys: [...new Set(taken.map((request) => request.auth))] };
    },
    changeEvents: () => changeEvents,
    dispose: () => {
      for (const subscription of context.subscriptions) subscription.dispose();
      deactivate();
    },
  };
}

const GLOBAL = { "omnicopilot.apiKey": "sk-global", "omnicopilot.apiKeyOrigins": JSON.stringify([A]) };
const WORKSPACE = {
  [workspaceSecretName(WS)]: "sk-ws",
  [workspaceOriginsSecretName(WS)]: JSON.stringify([A]),
};

/** One status-bar restart, one picker listing and one panel status. */
const ONE_REFRESH_WITH_PANEL = { probe: 2, models: 1, combos: 1, "om-usage": 2, "me/status": 2 };

describe("what a change of the connection costs on the wire", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  it("panel open: a Save with a new key and the address unchanged is one refresh", async () => {
    vi.useFakeTimers();
    const h = harness({ secrets: GLOBAL });
    h.openPanel();
    await h.settle(50);
    h.take();

    await h.send({ type: "save", url: A, apiKey: "sk-ws", useWorkspaceKey: true });
    await h.settle(1000);

    expect(h.take()).toEqual({ counts: ONE_REFRESH_WITH_PANEL, keys: ["sk-ws"] });
    h.dispose();
  });

  it("panel open: clearing the key in effect, with another stored key taking over, is one refresh", async () => {
    vi.useFakeTimers();
    const h = harness({ secrets: { ...GLOBAL, ...WORKSPACE }, switchOn: true });
    h.openPanel();
    await h.settle(50);
    h.take();

    await h.send({ type: "clearKey" });
    await h.settle(1000);

    expect(h.take()).toEqual({ counts: ONE_REFRESH_WITH_PANEL, keys: ["sk-global"] });
    h.dispose();
  });

  it("panel open: the global key replaced in another window costs nothing while this window uses its workspace key", async () => {
    vi.useFakeTimers();
    const h = harness({ secrets: { ...GLOBAL, ...WORKSPACE }, switchOn: true });
    h.openPanel();
    await h.settle(50);
    h.take();
    const events = h.changeEvents();

    // The three writes of storeApiKey in the other window.
    h.changedElsewhere("omnicopilot.apiKeyOrigins", "[]");
    h.changedElsewhere("omnicopilot.apiKey", "sk-global2");
    h.changedElsewhere("omnicopilot.apiKeyOrigins", JSON.stringify([A]));
    await h.settle(1000);

    expect(h.take()).toEqual({ counts: {}, keys: [] });
    expect(h.changeEvents()).toBe(events);
    h.dispose();
  });

  it('panel closed: the "Set API Key" command is one refresh without a panel', async () => {
    vi.useFakeTimers();
    const h = harness({ secrets: GLOBAL });
    await h.settle(50);
    h.take();

    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("sk-new");
    await registeredCommands.get("omnicopilot.setApiKey")!();
    await h.settle(1000);

    expect(h.take()).toEqual({
      counts: { probe: 1, models: 1, combos: 1, "om-usage": 1, "me/status": 1 },
      keys: ["sk-new"],
    });
    h.dispose();
  });

  it("does nothing for a secret change that leaves the resolved connection as it was", async () => {
    vi.useFakeTimers();
    const h = harness({ secrets: GLOBAL });
    await h.settle(50);
    h.take();
    const events = h.changeEvents();

    // Another window approves the same server again: the list is rewritten as it was.
    h.changedElsewhere("omnicopilot.apiKeyOrigins", JSON.stringify([A]));
    await h.settle(1000);

    expect(h.take()).toEqual({ counts: {}, keys: [] });
    expect(h.changeEvents()).toBe(events);
    h.dispose();
  });

  it("refreshes once when a key withheld here is cleared in another window (no key in effect before or after)", async () => {
    vi.useFakeTimers();
    const h = harness({
      secrets: { "omnicopilot.apiKey": "sk-global", "omnicopilot.apiKeyOrigins": JSON.stringify(["https://elsewhere.example"]) },
    });
    await h.settle(50);
    h.take();
    const events = h.changeEvents();

    h.changedElsewhere("omnicopilot.apiKey", undefined);
    h.changedElsewhere("omnicopilot.apiKeyOrigins", undefined);
    await h.settle(1000);

    // One status-bar restart and one picker listing, all without a key; no usage read.
    expect(h.take()).toEqual({ counts: { probe: 1, models: 1, combos: 1 }, keys: ["-"] });
    expect(h.changeEvents()).toBe(events + 1);
    h.dispose();
  });
});
