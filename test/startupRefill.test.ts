import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { setMockConfig, setMockWorkspace } from "./vscode.mock";
import { activate, deactivate } from "../src/extension";

/**
 * The picker after a start-up that went wrong, through the real `activate()`. The host
 * lists the way VS Code does over RPC: a few milliseconds after the change event, one
 * listing at a time. The picker shows what the host's last listing returned.
 */

const A = "https://a.example";

function harness() {
  const server = { secretsFail: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/combos")) return json({ object: "list", data: [] });
      if (path.endsWith("/models")) return json({ object: "list", data: [{ id: "a/1" }, { id: "a/2" }, { id: "a/3" }] });
      return json({}, 404);
    })
  );
  setMockConfig({ baseUrl: A });
  setMockWorkspace({ name: "acme", folders: ["file:///work/acme"] });

  const secrets = new Map<string, string>([
    ["omnicopilot.apiKey", "sk-global"],
    ["omnicopilot.apiKeyOrigins", JSON.stringify([A])],
  ]);
  const memento = (store: Map<string, unknown>) => ({
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void store.set(key, value),
  });
  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extension: { packageJSON: { version: "test" } },
    secrets: {
      get: async (key: string) => {
        if (server.secretsFail) throw new Error("SecretStorage unavailable");
        return secrets.get(key);
      },
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
      onDidChange: () => ({ dispose() {} }),
    },
    globalState: memento(new Map<string, unknown>([["omnicopilot.welcomed", true]])),
    workspaceState: memento(new Map()),
  };

  type Provider = {
    provideLanguageModelChatInformation(o: { silent: boolean }, t: unknown): Promise<unknown[]>;
    onDidChangeLanguageModelChatInformation(listener: () => void): unknown;
  };
  let provider: Provider | undefined;
  let picker: number | "never listed" | "threw" = "never listed";
  let running = false;
  let queued = false;
  const hostList = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      picker = (await provider!.provideLanguageModelChatInformation({ silent: true }, { isCancellationRequested: false })).length;
    } catch {
      picker = "threw";
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void hostList();
      }
    }
  };
  vi.spyOn(vscode.lm, "registerLanguageModelChatProvider").mockImplementation(((_vendor: string, p: unknown) => {
    provider = p as Provider;
    provider.onDidChangeLanguageModelChatInformation(() => void setTimeout(() => void hostList(), 5));
    return { dispose() {} };
  }) as never);

  let panelProvider: { resolveWebviewView(view: unknown): void } | undefined;
  vi.spyOn(vscode.window, "registerWebviewViewProvider").mockImplementation(((_id: string, p: unknown) => {
    panelProvider = p as typeof panelProvider;
    return { dispose() {} };
  }) as never);
  const posted: Array<Record<string, unknown>> = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      postMessage: async (message: Record<string, unknown>) => void posted.push(message),
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
  };

  activate(context as never);
  setTimeout(() => void hostList(), 5); // the host's first listing

  return {
    server,
    picker: () => picker,
    panelCount: () => posted.filter((m) => m.type === "status").at(-1)?.modelCount,
    openPanel: () => panelProvider?.resolveWebviewView(view),
    settle: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    dispose: () => {
      for (const subscription of context.subscriptions) subscription.dispose();
      deactivate();
    },
  };
}

describe("the picker after SecretStorage failed at start-up", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  it.each([false, true])(
    "is filled by the next poll once SecretStorage works again (panel opened before that poll: %s)",
    async (withPanel) => {
      vi.useFakeTimers();
      const h = harness();
      await h.settle(2000);
      expect(h.picker()).toBe("threw");

      h.server.secretsFail = false;
      if (withPanel) {
        h.openPanel();
        await h.settle(2000);
        expect(h.panelCount()).toBe(3); // the panel lists for itself and shows the count
      }
      await h.settle(31_000);

      expect(h.picker()).toBe(3);
      h.dispose();
    }
  );
});
