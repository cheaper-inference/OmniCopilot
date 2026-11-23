import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { configUpdates, setMockConfig, setMockInspect, setMockWorkspace } from "./vscode.mock";
import {
  SECRET_API_KEY,
  SECRET_API_KEY_ORIGINS,
  clearApiKey,
  decideKeyUse,
  keyWithheldMessage,
  parseApprovedOrigins,
  rebindApiKey,
  resolveConnection,
  storeApiKey,
  warnIfKeyWithheld,
  createWithheldKeyWatcher,
  watchKeySecrets,
  SECRET_CHANGE_SETTLE_MS,
  isLoopbackOrigin,
  originOf,
  ignoredWorkspaceUrl,
  showIgnoredWorkspaceUrlNotice,
  userLevelBaseUrl,
  displayUrl,
  plainNotificationText,
  isHttpUrl,
  SECRET_API_KEY_WORKSPACE_PREFIX,
  SECRET_API_KEY_ORIGINS_WORKSPACE_PREFIX,
  STATE_USE_WORKSPACE_KEY,
  chooseKeyScope,
  saveKeyFromPanel,
  workspaceIdentity,
  workspaceOriginsSecretName,
  workspaceSecretName,
} from "../src/connection";

/** A settings value that VS Code would render as a clickable command link in a notification. */
const LINK_PAYLOAD =
  "[http://localhost:20128](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D)";
/** The same link inside the path of a real http URL. */
const LINK_IN_PATH = `http://evil.example/${LINK_PAYLOAD}`;


/** An extension context whose SecretStorage and globalState are plain maps. */
function fakeContext(state: Record<string, unknown> = {}) {
  const secrets = new Map<string, string>();
  const global = new Map<string, unknown>(Object.entries(state));
  const local = new Map<string, unknown>();
  const context = {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: {
      get: <T>(key: string, fallback?: T) => (global.has(key) ? (global.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) global.delete(key);
        else global.set(key, value);
      },
    },
    workspaceState: {
      get: <T>(key: string, fallback?: T) => (local.has(key) ? (local.get(key) as T) : fallback),
      update: async (key: string, value: unknown) => {
        if (value === undefined) local.delete(key);
        else local.set(key, value);
      },
    },
  };
  return Object.assign(context as unknown as vscode.ExtensionContext, {
    secretMap: secrets,
    stateMap: global,
    workspaceMap: local,
  });
}

describe("originOf", () => {
  it.each([
    ["http://LocalHost:20128/v1/", "http://localhost:20128"],
    ["localhost:20128", "http://localhost:20128"],
    ["https://Example.com/v1", "https://example.com"],
    ["http://[::1]:20128/", "http://[::1]:20128"],
    ["https://example.com:8443/some/path", "https://example.com:8443"],
    ["", "http://localhost:20128"],
  ])("reduces %s to scheme, lower-case host and port", (input, expected) => {
    expect(originOf(input)).toBe(expected);
  });

  it("ignores the path, so /v1 or no /v1 yields the same origin", () => {
    expect(originOf("https://example.com")).toBe(originOf("https://example.com/v1/"));
  });
});

describe("isLoopbackOrigin", () => {
  it.each([
    "http://localhost:20128",
    "http://127.0.0.1:20128",
    "http://127.1.2.3:20128",
    "http://[::1]:20128",
    "https://localhost",
  ])("recognises %s as loopback", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each([
    "http://192.168.0.4:20128",
    "https://example.com",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "http://127.0.0.256:20128",
    "not a url",
  ])("does not treat %s as loopback", (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(false);
  });
});

describe("decideKeyUse", () => {
  const local = "http://localhost:20128";

  it("sends no key when none is stored", () => {
    expect(decideKeyUse({ currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("treats an empty stored key as no key", () => {
    expect(decideKeyUse({ storedKey: "", approvedOrigins: [local], currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("uses a key approved for several origins at any of them", () => {
    expect(
      decideKeyUse({
        storedKey: "sk-1",
        approvedOrigins: ["https://a.example", local],
        currentOrigin: local,
      })
    ).toEqual({ apiKey: "sk-1", keyWithheld: false, bindNow: false });
  });

  it("withholds a key whose approved list is empty (a malformed value reads as empty)", () => {
    expect(decideKeyUse({ storedKey: "sk-1", approvedOrigins: [], currentOrigin: local })).toEqual({
      apiKey: undefined,
      keyWithheld: true,
      bindNow: false,
    });
  });

  it("uses a key that was never bound and asks to bind it now", () => {
    expect(decideKeyUse({ storedKey: "sk-1", currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: true,
    });
  });

  it("uses a key bound to the current origin", () => {
    expect(decideKeyUse({ storedKey: "sk-1", approvedOrigins: [local], currentOrigin: local })).toEqual({
      apiKey: "sk-1",
      keyWithheld: false,
      bindNow: false,
    });
  });

  it("withholds a key bound to another origin", () => {
    expect(
      decideKeyUse({
        storedKey: "sk-1",
        approvedOrigins: [local],
        currentOrigin: "https://evil.example",
      })
    ).toEqual({ apiKey: undefined, keyWithheld: true, bindNow: false });
  });
});

describe("userLevelBaseUrl", () => {
  it("uses the user-level value, then the default, then the built-in default", () => {
    expect(userLevelBaseUrl({ globalValue: "https://u.example", defaultValue: "http://d:1" })).toBe(
      "https://u.example"
    );
    expect(userLevelBaseUrl({ globalValue: "", defaultValue: "http://d:1" })).toBe("http://d:1");
    expect(userLevelBaseUrl({ globalValue: "   ", defaultValue: "http://d:1" })).toBe("http://d:1");
    expect(userLevelBaseUrl({ globalValue: 42, defaultValue: "http://d:1" })).toBe("http://d:1");
    expect(userLevelBaseUrl({ globalValue: 42 })).toBe("http://localhost:20128");
    expect(userLevelBaseUrl(undefined)).toBe("http://localhost:20128");
  });
});

describe("resolveConnection reads the server URL from the user level only", () => {
  it.each([
    ["a workspace value", { workspaceValue: "https://ws.example" }],
    ["a folder value", { workspaceFolderValue: "https://folder.example" }],
    ["a language-specific value", { workspaceLanguageValue: "https://l.example", globalLanguageValue: "https://gl.example", defaultLanguageValue: "https://dl.example", workspaceFolderLanguageValue: "https://fl.example" }],
  ])("ignores %s", async (_name, fields) => {
    setMockConfig({});
    setMockInspect("baseUrl", { defaultValue: "http://localhost:20128", ...fields });
    expect((await resolveConnection(fakeContext())).baseUrl).toBe("http://localhost:20128/v1");
  });

  it("uses the user-level value over a workspace value", async () => {
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: "https://ws.example" });
    const connection = await resolveConnection(fakeContext());
    expect(connection.baseUrl).toBe("https://user.example/v1");
    expect(connection.ignoredWorkspaceUrl).toBe("https://ws.example");
  });

  it.each([[""], [42], [null]])("falls back to the default for the user value %j", async (value) => {
    setMockConfig({ baseUrl: value });
    setMockInspect("baseUrl", { defaultValue: "http://localhost:20128" });
    expect((await resolveConnection(fakeContext())).baseUrl).toBe("http://localhost:20128/v1");
  });
});

describe("ignoredWorkspaceUrl", () => {
  const effectiveRoot = "http://localhost:20128";

  it("names the folder value first, then the workspace value", () => {
    expect(
      ignoredWorkspaceUrl({
        workspaceValue: "https://ws.example",
        workspaceFolderValue: "https://folder.example",
        effectiveRoot,
      })
    ).toBe("https://folder.example");
    expect(ignoredWorkspaceUrl({ workspaceValue: "https://ws.example", effectiveRoot })).toBe(
      "https://ws.example"
    );
  });

  it("says nothing when the value equals the effective URL after normalisation", () => {
    expect(ignoredWorkspaceUrl({ workspaceValue: "localhost:20128/v1/", effectiveRoot })).toBeUndefined();
    expect(
      ignoredWorkspaceUrl({
        workspaceValue: "https://ws.example",
        workspaceFolderValue: " http://localhost:20128 ",
        effectiveRoot,
      })
    ).toBeUndefined();
  });

  it("says nothing without a non-empty string", () => {
    expect(ignoredWorkspaceUrl({ effectiveRoot })).toBeUndefined();
    expect(ignoredWorkspaceUrl({ workspaceValue: "", workspaceFolderValue: "  ", effectiveRoot })).toBeUndefined();
    expect(ignoredWorkspaceUrl({ workspaceValue: 42, effectiveRoot })).toBeUndefined();
  });
});

describe("showIgnoredWorkspaceUrlNotice", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tells the user once per ignored value, and again when it changes", async () => {
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: "https://ws.example" });
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Open panel" as never);
    const run = vi.spyOn(vscode.commands, "executeCommand");
    const context = fakeContext();

    await showIgnoredWorkspaceUrlNotice(context);
    await showIgnoredWorkspaceUrlNotice(context);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]).toEqual([
      "This workspace's settings set an OmniRoute server URL (https://ws.example). It is not used: the server URL is read from your user settings, and it is https://user.example.",
      "Open panel",
    ]);
    expect(run).toHaveBeenCalledWith("omnicopilot.manage");
    expect(context.workspaceState.get("omnicopilot.ignoredUrlNotice")).toBe("https://ws.example");

    setMockInspect("baseUrl", { workspaceValue: "https://other.example" });
    await showIgnoredWorkspaceUrlNotice(context);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][0]).toContain("(https://other.example)");
  });

  it("says nothing when no workspace value differs from the user-level URL", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    setMockConfig({ baseUrl: "https://user.example" });
    await showIgnoredWorkspaceUrlNotice(fakeContext());
    setMockInspect("baseUrl", { workspaceValue: "https://user.example/v1" });
    await showIgnoredWorkspaceUrlNotice(fakeContext());
    expect(info).not.toHaveBeenCalled();
  });
});

describe("parseApprovedOrigins", () => {
  it("reads a missing value as a key from before 1.4.0", () => {
    expect(parseApprovedOrigins(undefined)).toBeUndefined();
  });

  it("reads a JSON array of origins", () => {
    expect(parseApprovedOrigins('["https://a.example","http://localhost:20128"]')).toEqual([
      "https://a.example",
      "http://localhost:20128",
    ]);
  });

  it.each(["", "not json", "{}", '"https://a.example"', "null", "[1,2]"])(
    "reads the malformed value %j as an empty list, never as a legacy key",
    (raw) => {
      expect(parseApprovedOrigins(raw)).toEqual([]);
    }
  );
});

describe("key binding in SecretStorage", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  afterEach(() => vi.restoreAllMocks());

  function origins(context: ReturnType<typeof fakeContext>): unknown {
    const raw = context.secretMap.get(SECRET_API_KEY_ORIGINS);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  it("adopts a key from before 1.4.0 once and records the origin next to the key", async () => {
    setMockConfig({ baseUrl: `${A}/v1` });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");

    const first = await resolveConnection(context);
    expect(first).toMatchObject({ apiKey: "sk-1", keyWithheld: false, approvedOrigins: [A] });
    expect(origins(context)).toEqual([A]);

    setMockConfig({ baseUrl: B });
    const second = await resolveConnection(context);
    expect(second).toMatchObject({ apiKey: undefined, keyWithheld: true, approvedOrigins: [A] });
    expect(origins(context)).toEqual([A]);
  });

  it("keeps the binding out of globalState", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    await resolveConnection(context);
    expect([...context.stateMap.keys()]).toEqual([]);
  });

  it("withholds the key in a window whose URL was never approved, and names the approved origin", async () => {
    setMockConfig({ baseUrl: B });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([A]));

    const connection = await resolveConnection(context);

    expect(connection).toMatchObject({ apiKey: undefined, keyWithheld: true, hasStoredKey: true });
    expect(keyWithheldMessage(connection)).toBe(
      `The stored API key was saved for ${A} and is not being sent to ${B}. Press Save & Test to use it here.`
    );
  });

  it("names no server the key was saved for when its list of approved servers is empty", async () => {
    setMockConfig({ baseUrl: B });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, "[]");

    const connection = await resolveConnection(context);

    expect(connection).toMatchObject({ keyWithheld: true, approvedOrigins: [] });
    expect(keyWithheldMessage(connection)).toBe(
      `The stored API key is not approved for ${B} and is not being sent to it. Press Save & Test to use it here.`
    );
  });

  it("keeps a link out of the empty-list sentence once it is made a notification", () => {
    const message = keyWithheldMessage({
      keyWithheld: true,
      approvedOrigins: [],
      origin: "[x](command:y)",
    } as never);

    expect(message).toContain("not approved for");
    expect(plainNotificationText(message!)).not.toContain("](");
  });

  it("treats a malformed origins secret as an empty list: the key is withheld", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, "{oops");

    expect(await resolveConnection(context)).toMatchObject({ apiKey: undefined, keyWithheld: true });
    expect(context.secretMap.get(SECRET_API_KEY_ORIGINS)).toBe("{oops");
  });

  it("releases the key to a changed URL only after rebindApiKey, keeping the old origin", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    setMockConfig({ baseUrl: B });
    expect((await resolveConnection(context)).apiKey).toBeUndefined();

    await rebindApiKey(context);

    expect((await resolveConnection(context)).apiKey).toBe("sk-1");
    expect(origins(context)).toEqual([A, B]);
    setMockConfig({ baseUrl: A });
    expect((await resolveConnection(context)).apiKey).toBe("sk-1");
  });

  it("keeps at most the five most recently approved origins, the newest last", async () => {
    const context = fakeContext();
    setMockConfig({ baseUrl: "https://o0.example" });
    await storeApiKey(context, "sk-1");
    for (let i = 1; i <= 6; i++) {
      setMockConfig({ baseUrl: `https://o${i}.example` });
      await rebindApiKey(context);
    }
    setMockConfig({ baseUrl: "https://o2.example" });
    await rebindApiKey(context);

    expect(origins(context)).toEqual([
      "https://o3.example",
      "https://o4.example",
      "https://o5.example",
      "https://o6.example",
      "https://o2.example",
    ]);
    setMockConfig({ baseUrl: "https://o1.example" });
    const connection = await resolveConnection(context);
    expect(connection.keyWithheld).toBe(true);
    expect(keyWithheldMessage(connection)).toContain("saved for https://o2.example");
  });

  it("does nothing on rebind when no key is stored", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await rebindApiKey(context);
    expect(context.secretMap.size).toBe(0);
  });

  it("resets the approved list to the current origin when a new key is stored", async () => {
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-old");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([A, B]));
    setMockConfig({ baseUrl: "https://c.example" });

    await storeApiKey(context, "sk-new");

    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-new");
    expect(origins(context)).toEqual(["https://c.example"]);
    setMockConfig({ baseUrl: A });
    expect((await resolveConnection(context)).apiKey).toBeUndefined();
  });

  it("removes the key and its approved origins together", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");

    await clearApiKey(context);

    expect(context.secretMap.has(SECRET_API_KEY)).toBe(false);
    expect(context.secretMap.has(SECRET_API_KEY_ORIGINS)).toBe(false);
    expect(await resolveConnection(context)).toMatchObject({ hasStoredKey: false, keyWithheld: false });
  });

  it("warns once per plain-HTTP origin outside this machine, also for an adopted key", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const lan = "http://192.168.0.4:20128";
    setMockConfig({ baseUrl: lan });
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");

    await resolveConnection(context); // adopts the legacy key
    await storeApiKey(context, "sk-2");
    await rebindApiKey(context);
    setMockConfig({ baseUrl: "http://localhost:20128" });
    await rebindApiKey(context);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      `The API key for ${lan} travels over plain HTTP. Anyone on the network path can read it. Prefer HTTPS or a tunnel for a server outside this machine.`
    );
  });
});

describe("warnIfKeyWithheld", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  afterEach(() => vi.restoreAllMocks());

  async function keySavedForA() {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    return context;
  }

  it("warns once per origin when the URL moved away from the key", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const warned = new Set<string>();
    setMockConfig({ baseUrl: `${B}/v1` });

    await warnIfKeyWithheld(context, warned, async () => undefined);
    await warnIfKeyWithheld(context, warned, async () => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      `The OmniRoute server URL is now ${B}. The stored API key was saved for ${A} and is not being sent to the new server.`,
      "Use the key here",
      "Open panel",
    ]);
  });

  it("says nothing while the key is sent, or when none is stored", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const context = await keySavedForA();
    await warnIfKeyWithheld(context, new Set(), async () => undefined);
    setMockConfig({ baseUrl: B });
    await warnIfKeyWithheld(fakeContext(), new Set(), async () => undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("approves the new server and refreshes when the user picks Use the key here", async () => {
    const context = await keySavedForA();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Use the key here" as never);
    const refreshed = vi.fn(async () => undefined);
    setMockConfig({ baseUrl: B });

    await warnIfKeyWithheld(context, new Set(), refreshed);

    expect(refreshed).toHaveBeenCalledTimes(1);
    expect((await resolveConnection(context)).apiKey).toBe("sk-1");
  });

  it("opens the panel without approving anything on Open panel", async () => {
    const context = await keySavedForA();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Open panel" as never);
    const run = vi.spyOn(vscode.commands, "executeCommand");
    const refreshed = vi.fn(async () => undefined);
    setMockConfig({ baseUrl: B });

    await warnIfKeyWithheld(context, new Set(), refreshed);

    expect(run).toHaveBeenCalledWith("omnicopilot.manage");
    expect(refreshed).not.toHaveBeenCalled();
    expect((await resolveConnection(context)).keyWithheld).toBe(true);
  });
});

describe("approving the URL being saved", () => {
  it("binds a rebind or a new key to an explicit URL instead of the configured one", async () => {
    setMockConfig({ baseUrl: "https://a.example" });
    const context = fakeContext();
    await storeApiKey(context, "sk-1", "https://b.example/v1");
    expect(JSON.parse(context.secretMap.get(SECRET_API_KEY_ORIGINS) ?? "")).toEqual([
      "https://b.example",
    ]);
    await rebindApiKey(context, "c.example:8080");
    expect(JSON.parse(context.secretMap.get(SECRET_API_KEY_ORIGINS) ?? "")).toEqual([
      "https://b.example",
      "http://c.example:8080",
    ]);
  });
});

describe("createWithheldKeyWatcher", () => {
  const A = "https://a.example";
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function keySavedForA() {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    return context;
  }

  it("warns once, for the URL in effect when the edits settle", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const watcher = createWithheldKeyWatcher(context, async () => undefined, () => undefined);

    for (const url of ["https://b", "https://b.ex", "https://b.example"]) {
      setMockConfig({ baseUrl: url });
      watcher.schedule();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("The OmniRoute server URL is now https://b.example.");
    watcher.dispose();
  });

  it("says nothing when the URL goes back to an approved one before it settles", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const watcher = createWithheldKeyWatcher(context, async () => undefined, () => undefined);

    setMockConfig({ baseUrl: "https://b.example" });
    watcher.schedule();
    await vi.advanceTimersByTimeAsync(800);
    setMockConfig({ baseUrl: A });
    watcher.schedule();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();

    expect(warn).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("stops a pending check when disposed", async () => {
    const context = await keySavedForA();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const watcher = createWithheldKeyWatcher(context, async () => undefined, () => undefined);

    setMockConfig({ baseUrl: "https://b.example" });
    watcher.schedule();
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("storeApiKey write order", () => {
  it("never leaves the old key approved for the new server, nor the new key for the old ones", async () => {
    const A = "https://a.example";
    const B = "https://b.example";
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-old");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([A]));
    setMockConfig({ baseUrl: B }); // changed in Settings: the old key is withheld here

    const snapshots: Array<{ key?: string; origins?: string[] }> = [];
    const store = context.secrets.store.bind(context.secrets);
    context.secrets.store = async (name: string, value: string) => {
      await store(name, value);
      snapshots.push({
        key: context.secretMap.get(SECRET_API_KEY),
        origins: parseApprovedOrigins(context.secretMap.get(SECRET_API_KEY_ORIGINS)),
      });
    };

    await storeApiKey(context, "sk-new");

    expect(snapshots.length).toBeGreaterThan(0);
    for (const { key, origins } of snapshots) {
      expect(key === "sk-old" && origins?.includes(B), JSON.stringify({ key, origins })).toBe(false);
      expect(key === "sk-new" && origins?.includes(A), JSON.stringify({ key, origins })).toBe(false);
      expect(key !== undefined && origins === undefined).toBe(false);
    }
    expect(snapshots.at(-1)).toEqual({ key: "sk-new", origins: [B] });
  });
});

describe("displayUrl", () => {
  it("keeps a plain URL readable", () => {
    expect(displayUrl("https://omni.example")).toBe("https://omni.example");
    expect(displayUrl("  http://192.168.0.4:20128/  ")).toBe("http://192.168.0.4:20128");
    expect(displayUrl("https://omni.example/gateway/v1")).toBe("https://omni.example/gateway/v1");
  });

  it("drops credentials, query and fragment", () => {
    expect(displayUrl("https://user:secret@omni.example:8443/p/?token=abc#frag")).toBe(
      "https://omni.example:8443/p"
    );
  });

  it("keeps the brackets of an IPv6 host", () => {
    expect(displayUrl("http://[::1]:20128/")).toBe("http://[::1]:20128");
    expect(displayUrl("http://[2001:db8::1]/a[b]")).toBe("http://[2001:db8::1]/a%5Bb%5D");
  });

  it("percent-encodes brackets, parentheses, angle brackets and backticks in a path", () => {
    expect(displayUrl("https://omni.example/a[b](c)<d>`e")).toBe(
      "https://omni.example/a%5Bb%5D%28c%29%3Cd%3E%60e"
    );
    expect(displayUrl("http://a(b).example/")).toBe("http://a%28b%29.example");
  });

  it("neutralises the link payload, as text or inside a URL", () => {
    for (const value of [LINK_PAYLOAD, LINK_IN_PATH]) {
      const shown = displayUrl(value);
      expect(shown).not.toContain("](");
      expect(shown).not.toMatch(/[()<>`]/);
    }
    expect(displayUrl(LINK_PAYLOAD)).toBe(
      "%5Bhttp://localhost:20128%5D%28command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22x%22%7D%29"
    );
  });

  it("cuts a very long value to 200 characters plus an ellipsis", () => {
    const shown = displayUrl("x".repeat(5000));
    expect(shown).toBe(`${"x".repeat(200)}…`);
    expect(displayUrl(`https://omni.example/${"a".repeat(5000)}`)).toHaveLength(201);
  });

  it("removes control characters and line breaks", () => {
    expect(displayUrl("evil\n[x]\r\n(command:y)\u0007\u2028")).toBe("evil%5Bx%5D%28command:y%29");
  });

  it("gives nothing for a non-string or an empty value", () => {
    expect(displayUrl(42)).toBe("");
    expect(displayUrl(undefined)).toBe("");
    expect(displayUrl(null)).toBe("");
    expect(displayUrl("   ")).toBe("");
  });

  it("can never contain the link separator", () => {
    const samples = [LINK_PAYLOAD, LINK_IN_PATH, "](", "a](b", "http://h/](x", "[a]\n(b)", "x".repeat(199) + "](y"];
    for (const value of samples) expect(displayUrl(value)).not.toContain("](");
  });
});

describe("plainNotificationText", () => {
  it("joins lines and breaks every link separator", () => {
    expect(plainNotificationText("bad\r\nthing\u0000here")).toBe("bad thing here");
    expect(plainNotificationText(`Error: ${LINK_PAYLOAD}`)).not.toContain("](");
    expect(plainNotificationText("[a](b) and [c]](d)")).toBe("[a] (b) and [c]] (d)");
  });
});

describe("isHttpUrl", () => {
  it("accepts only http and https URLs", () => {
    expect(isHttpUrl("https://omni.example")).toBe(true);
    expect(isHttpUrl(" http://[::1]:20128 ")).toBe(true);
    expect(isHttpUrl(LINK_PAYLOAD)).toBe(false);
    expect(isHttpUrl("localhost:20128")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
  });
});

describe("notifications built from settings carry no link", () => {
  afterEach(() => vi.restoreAllMocks());

  const texts = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]));

  it("does not show the ignored-workspace-URL notice for a value that is not an http URL", async () => {
    setMockConfig({ baseUrl: "https://user.example" });
    setMockInspect("baseUrl", { workspaceValue: LINK_PAYLOAD });
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await showIgnoredWorkspaceUrlNotice(fakeContext());

    expect(info).not.toHaveBeenCalled();
  });

  it("shows an http workspace URL in the notice only with the link broken", async () => {
    setMockConfig({ baseUrl: LINK_IN_PATH });
    setMockInspect("baseUrl", { workspaceValue: `${LINK_IN_PATH}/other` });
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await showIgnoredWorkspaceUrlNotice(fakeContext());

    expect(info).toHaveBeenCalledTimes(1);
    expect(texts(info)[0]).not.toContain("](");
  });

  it("names the plain-HTTP origin without a link", async () => {
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await storeApiKey(fakeContext(), "sk-1");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(texts(warn)[0]).not.toContain("](");
  });

  it("names both servers of the withheld-key warning without a link", async () => {
    const context = fakeContext();
    context.secretMap.set(SECRET_API_KEY, "sk-1");
    context.secretMap.set(SECRET_API_KEY_ORIGINS, JSON.stringify([LINK_PAYLOAD]));
    setMockConfig({ baseUrl: LINK_IN_PATH });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await warnIfKeyWithheld(context, new Set(), async () => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(texts(warn)[0]).not.toContain("](");
  });
});


describe("workspaceSecretName / workspaceOriginsSecretName", () => {
  const id = "file:///home/dev/projects/acme/acme.code-workspace";

  it("names the secrets from 16 hex characters of a hash of the identity", () => {
    expect(workspaceSecretName(id)).toMatch(/^omnicopilot\.apiKey\.ws\.[0-9a-f]{16}$/);
    expect(workspaceOriginsSecretName(id)).toMatch(/^omnicopilot\.apiKeyOrigins\.ws\.[0-9a-f]{16}$/);
    expect(workspaceSecretName(id).startsWith(SECRET_API_KEY_WORKSPACE_PREFIX)).toBe(true);
    expect(workspaceOriginsSecretName(id).startsWith(SECRET_API_KEY_ORIGINS_WORKSPACE_PREFIX)).toBe(true);
  });

  it("is stable, and the key and its list share the suffix", () => {
    expect(workspaceSecretName(id)).toBe(workspaceSecretName(id));
    expect(workspaceSecretName(id).split(".").pop()).toBe(workspaceOriginsSecretName(id).split(".").pop());
  });

  it("never carries the identity, and two identities give two names", () => {
    const other = "file:///home/dev/projects/beta";
    for (const name of [workspaceSecretName(id), workspaceOriginsSecretName(id)]) {
      expect(name).not.toContain("acme");
      expect(name).not.toContain("home");
    }
    expect(workspaceSecretName(id)).not.toBe(workspaceSecretName(other));
    expect(workspaceOriginsSecretName(id)).not.toBe(workspaceOriginsSecretName(other));
  });
});

describe("workspaceIdentity", () => {
  it("prefers the saved workspace file, then the first folder", () => {
    expect(workspaceIdentity({ workspaceFile: "file:///w/a.code-workspace", firstFolder: "file:///w/a" })).toBe(
      "file:///w/a.code-workspace"
    );
    expect(workspaceIdentity({ firstFolder: "file:///w/a" })).toBe("file:///w/a");
  });

  it("does not use an untitled workspace file, which has no stable name", () => {
    expect(workspaceIdentity({ workspaceFile: "untitled:1700000000000", firstFolder: "file:///w/a" })).toBe(
      "file:///w/a"
    );
    expect(workspaceIdentity({ workspaceFile: "untitled:1700000000000" })).toBeUndefined();
  });

  it("is undefined when nothing is open", () => {
    expect(workspaceIdentity({})).toBeUndefined();
    expect(workspaceIdentity({ workspaceFile: "", firstFolder: "  " })).toBeUndefined();
  });
});

describe("chooseKeyScope", () => {
  const base = { workspaceId: "file:///w/a", useWorkspaceKey: true, workspaceKey: "sk-ws", globalKey: "sk-g" };

  it("uses the workspace key when a workspace is open, the switch is on and the key is stored", () => {
    expect(chooseKeyScope(base)).toEqual({ scope: "workspace", key: "sk-ws" });
  });

  it("uses the global key when the switch is off", () => {
    expect(chooseKeyScope({ ...base, useWorkspaceKey: false })).toEqual({ scope: "global", key: "sk-g" });
  });

  it("uses the global key when no workspace is open, whatever the switch says", () => {
    expect(chooseKeyScope({ ...base, workspaceId: undefined })).toEqual({ scope: "global", key: "sk-g" });
  });

  it("uses the global key when the switch is on but no workspace key is stored", () => {
    expect(chooseKeyScope({ ...base, workspaceKey: undefined })).toEqual({ scope: "global", key: "sk-g" });
    expect(chooseKeyScope({ ...base, workspaceKey: "" })).toEqual({ scope: "global", key: "sk-g" });
  });

  it("has no key when neither is stored", () => {
    expect(chooseKeyScope({ ...base, workspaceKey: undefined, globalKey: undefined })).toEqual({
      scope: "none",
    });
    expect(chooseKeyScope({ useWorkspaceKey: false })).toEqual({ scope: "none" });
  });

  it("falls back to the workspace key only through the switch, never when it is off", () => {
    expect(chooseKeyScope({ ...base, useWorkspaceKey: false, globalKey: undefined })).toEqual({ scope: "none" });
  });
});

describe("one API key per workspace", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  const WS = "file:///work/acme";
  afterEach(() => {
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  const originsOf = (context: ReturnType<typeof fakeContext>, name: string): unknown => {
    const raw = context.secretMap.get(name);
    return raw === undefined ? undefined : JSON.parse(raw);
  };

  /** A global key and a workspace key, both approved for A, the switch on. */
  async function bothKeys() {
    setMockConfig({ baseUrl: A });
    setMockWorkspace({ name: "acme", folders: [WS] });
    const context = fakeContext();
    await storeApiKey(context, "sk-global");
    await storeApiKey(context, "sk-ws", undefined, "workspace");
    return context;
  }

  it("lets the workspace key win over the global one", async () => {
    const context = await bothKeys();
    expect(await resolveConnection(context)).toMatchObject({
      apiKey: "sk-ws",
      keyScope: "workspace",
      hasStoredKey: true,
      workspaceKeyAvailable: true,
      useWorkspaceKey: true,
    });
  });

  it("stores the workspace key under its own secrets and turns the switch on", async () => {
    const context = await bothKeys();
    expect(context.secretMap.get(workspaceSecretName(WS))).toBe("sk-ws");
    expect(originsOf(context, workspaceOriginsSecretName(WS))).toEqual([A]);
    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-global");
    expect(context.workspaceMap.get(STATE_USE_WORKSPACE_KEY)).toBe(true);
  });

  it("serves the global key when the switch is off, and the workspace key again when it is back on", async () => {
    const context = await bothKeys();
    context.workspaceMap.set(STATE_USE_WORKSPACE_KEY, false);
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-global", keyScope: "global" });
    expect(context.secretMap.get(workspaceSecretName(WS))).toBe("sk-ws");
    context.workspaceMap.set(STATE_USE_WORKSPACE_KEY, true);
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-ws", keyScope: "workspace" });
  });

  it("serves the global key when the switch is on but no workspace key is stored", async () => {
    setMockConfig({ baseUrl: A });
    setMockWorkspace({ folders: [WS] });
    const context = fakeContext();
    await storeApiKey(context, "sk-global");
    context.workspaceMap.set(STATE_USE_WORKSPACE_KEY, true);
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-global", keyScope: "global" });
  });

  it("has no workspace key without an open workspace, even with the switch on", async () => {
    const context = await bothKeys();
    setMockWorkspace();
    expect(await resolveConnection(context)).toMatchObject({
      apiKey: "sk-global",
      keyScope: "global",
      workspaceKeyAvailable: false,
    });
  });

  it("keeps two workspaces' keys apart", async () => {
    const context = await bothKeys();
    setMockWorkspace({ folders: ["file:///work/other"] });
    // The switch is still on, but the other workspace has no key of its own.
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-global", keyScope: "global" });
  });

  it("reports the scope as none when nothing is stored", async () => {
    setMockConfig({ baseUrl: A });
    setMockWorkspace({ folders: [WS] });
    expect(await resolveConnection(fakeContext())).toMatchObject({
      keyScope: "none",
      hasStoredKey: false,
      workspaceKeyAvailable: true,
    });
  });

  it("approves servers per key: approving B for the workspace key does not approve it for the global one", async () => {
    const context = await bothKeys();
    setMockConfig({ baseUrl: B });
    expect(await resolveConnection(context)).toMatchObject({
      apiKey: undefined,
      keyWithheld: true,
      keyScope: "workspace",
    });

    await rebindApiKey(context, undefined, "workspace");

    expect(originsOf(context, workspaceOriginsSecretName(WS))).toEqual([A, B]);
    expect(originsOf(context, SECRET_API_KEY_ORIGINS)).toEqual([A]);
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-ws", keyWithheld: false });
    context.workspaceMap.set(STATE_USE_WORKSPACE_KEY, false);
    expect(await resolveConnection(context)).toMatchObject({
      apiKey: undefined,
      keyWithheld: true,
      keyScope: "global",
    });
  });

  it("approving a server for the global key does not approve it for the workspace key", async () => {
    const context = await bothKeys();
    setMockConfig({ baseUrl: B });
    await rebindApiKey(context, undefined, "global");
    expect(originsOf(context, SECRET_API_KEY_ORIGINS)).toEqual([A, B]);
    expect(originsOf(context, workspaceOriginsSecretName(WS))).toEqual([A]);
    expect((await resolveConnection(context)).keyWithheld).toBe(true);
  });

  it("withholds a workspace key whose list is missing: it is never adopted by whichever origin asks", async () => {
    const context = await bothKeys();
    context.secretMap.delete(workspaceOriginsSecretName(WS));
    expect(await resolveConnection(context)).toMatchObject({
      apiKey: undefined,
      keyWithheld: true,
      keyScope: "workspace",
    });
    expect(context.secretMap.has(workspaceOriginsSecretName(WS))).toBe(false);
  });

  it("withholds a workspace key whose list is damaged", async () => {
    const context = await bothKeys();
    context.secretMap.set(workspaceOriginsSecretName(WS), "{oops");
    expect(await resolveConnection(context)).toMatchObject({ apiKey: undefined, keyWithheld: true });
  });

  it("clears one scope and leaves the other", async () => {
    const context = await bothKeys();

    await clearApiKey(context, "workspace");

    expect(context.secretMap.has(workspaceSecretName(WS))).toBe(false);
    expect(context.secretMap.has(workspaceOriginsSecretName(WS))).toBe(false);
    expect(context.workspaceMap.get(STATE_USE_WORKSPACE_KEY)).toBe(false);
    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-global");
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-global", keyScope: "global" });

    const again = await bothKeys();
    await clearApiKey(again, "global");
    expect(again.secretMap.has(SECRET_API_KEY)).toBe(false);
    expect(again.secretMap.has(SECRET_API_KEY_ORIGINS)).toBe(false);
    expect(again.secretMap.get(workspaceSecretName(WS))).toBe("sk-ws");
    expect(again.workspaceMap.get(STATE_USE_WORKSPACE_KEY)).toBe(true);
  });

  it("writes a workspace key in the fail-closed order, never leaving it without a list", async () => {
    setMockConfig({ baseUrl: B });
    setMockWorkspace({ folders: [WS] });
    const context = fakeContext();
    const keyName = workspaceSecretName(WS);
    const listName = workspaceOriginsSecretName(WS);
    context.secretMap.set(keyName, "sk-old");
    context.secretMap.set(listName, JSON.stringify([A]));

    const snapshots: Array<{ key?: string; origins?: string[] }> = [];
    const store = context.secrets.store.bind(context.secrets);
    context.secrets.store = async (name: string, value: string) => {
      await store(name, value);
      snapshots.push({
        key: context.secretMap.get(keyName),
        origins: parseApprovedOrigins(context.secretMap.get(listName)),
      });
    };

    await storeApiKey(context, "sk-new", undefined, "workspace");

    expect(snapshots.length).toBeGreaterThan(0);
    for (const { key, origins } of snapshots) {
      expect(key === "sk-old" && origins?.includes(B), JSON.stringify({ key, origins })).toBe(false);
      expect(key === "sk-new" && origins?.includes(A), JSON.stringify({ key, origins })).toBe(false);
      expect(key !== undefined && origins === undefined).toBe(false);
    }
    expect(snapshots.at(-1)).toEqual({ key: "sk-new", origins: [B] });
  });

  it("refuses to store a workspace key when no workspace is open, and writes nothing", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await expect(storeApiKey(context, "sk-ws", undefined, "workspace")).rejects.toThrow();
    expect(context.secretMap.size).toBe(0);
    expect(context.workspaceMap.size).toBe(0);
  });

  it("writes nothing about any key to settings or globalState", async () => {
    const context = await bothKeys();
    await rebindApiKey(context, "https://c.example", "workspace");
    await clearApiKey(context, "workspace");
    expect(configUpdates).toEqual([]);
    expect([...context.stateMap.keys()]).toEqual([]);
    expect([...context.workspaceMap.keys()]).toEqual([STATE_USE_WORKSPACE_KEY]);
    expect(JSON.stringify([...context.workspaceMap.values()])).not.toContain("sk-");
  });

  it("warns about plain HTTP for a workspace key without letting the address become a link", async () => {
    setMockConfig({ baseUrl: LINK_PAYLOAD });
    setMockWorkspace({ folders: [WS] });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    await storeApiKey(fakeContext(), "sk-ws", undefined, "workspace");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("](");
  });

  it("releases only the key in effect from the withheld-key warning", async () => {
    const context = await bothKeys();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Use the key here" as never);
    setMockConfig({ baseUrl: B });

    await warnIfKeyWithheld(context, new Set(), async () => undefined);

    expect(originsOf(context, workspaceOriginsSecretName(WS))).toEqual([A, B]);
    expect(originsOf(context, SECRET_API_KEY_ORIGINS)).toEqual([A]);
  });
});

describe("saveKeyFromPanel", () => {
  const A = "https://a.example";
  const WS = "file:///work/acme";
  afterEach(() => {
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  function withWorkspace() {
    setMockConfig({ baseUrl: A });
    setMockWorkspace({ folders: [WS] });
    return fakeContext();
  }

  it("stores a typed key as the workspace key when the box is ticked", async () => {
    const context = withWorkspace();
    const stored = await saveKeyFromPanel(context, { key: "sk-ws", useWorkspaceKey: true, url: A });
    expect(stored).toBe(true);
    expect(context.secretMap.get(workspaceSecretName(WS))).toBe("sk-ws");
    expect(context.secretMap.has(SECRET_API_KEY)).toBe(false);
    expect(context.workspaceMap.get(STATE_USE_WORKSPACE_KEY)).toBe(true);
  });

  it("only turns the switch on when the box is ticked and no key is typed, keeping what is stored", async () => {
    const context = withWorkspace();
    await storeApiKey(context, "sk-global");
    const stored = await saveKeyFromPanel(context, { key: "", useWorkspaceKey: true, url: A });
    expect(stored).toBe(false);
    expect(context.workspaceMap.get(STATE_USE_WORKSPACE_KEY)).toBe(true);
    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-global");
    expect([...context.secretMap.keys()].some((name) => name.includes(".ws."))).toBe(false);
    // No workspace key yet: the global key stays in effect.
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-global", keyScope: "global" });
  });

  it("keeps a stored workspace key when the box is ticked and no key is typed", async () => {
    const context = withWorkspace();
    await storeApiKey(context, "sk-ws", undefined, "workspace");
    context.workspaceMap.set(STATE_USE_WORKSPACE_KEY, false);
    await saveKeyFromPanel(context, { key: "", useWorkspaceKey: true, url: A });
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-ws", keyScope: "workspace" });
  });

  it("turns the switch off when the box is unticked, and a typed key becomes the global key", async () => {
    const context = withWorkspace();
    await storeApiKey(context, "sk-ws", undefined, "workspace");
    const stored = await saveKeyFromPanel(context, { key: "sk-new-global", useWorkspaceKey: false, url: A });
    expect(stored).toBe(true);
    expect(context.workspaceMap.get(STATE_USE_WORKSPACE_KEY)).toBe(false);
    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-new-global");
    expect(context.secretMap.get(workspaceSecretName(WS))).toBe("sk-ws");
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-new-global", keyScope: "global" });
  });

  it("approves the URL being saved for the key in effect only", async () => {
    const context = withWorkspace();
    await storeApiKey(context, "sk-global");
    await storeApiKey(context, "sk-ws", undefined, "workspace");
    await saveKeyFromPanel(context, { key: "", useWorkspaceKey: true, url: "https://b.example" });
    expect(JSON.parse(context.secretMap.get(workspaceOriginsSecretName(WS)) ?? "")).toEqual([
      A,
      "https://b.example",
    ]);
    expect(JSON.parse(context.secretMap.get(SECRET_API_KEY_ORIGINS) ?? "")).toEqual([A]);
  });

  it("ignores the box when no workspace is open", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    const stored = await saveKeyFromPanel(context, { key: "sk-1", useWorkspaceKey: true, url: A });
    expect(stored).toBe(true);
    expect(context.secretMap.get(SECRET_API_KEY)).toBe("sk-1");
    expect(context.workspaceMap.size).toBe(0);
  });
});

describe("the withheld-key warning is announced per scope and origin", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  const WS = "file:///work/acme";
  afterEach(() => {
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  /** A global and a workspace key, both approved for A only; the URL moved to B. */
  async function bothWithheldAtB() {
    setMockConfig({ baseUrl: A });
    setMockWorkspace({ folders: [WS] });
    const context = fakeContext();
    await storeApiKey(context, "sk-global");
    await storeApiKey(context, "sk-ws", undefined, "workspace");
    setMockConfig({ baseUrl: B });
    return context;
  }

  it.each([
    ["the global key first, then the workspace key", false],
    ["the workspace key first, then the global key", true],
  ])("announces %s for the same origin, and each once", async (_name, workspaceFirst) => {
    const context = await bothWithheldAtB();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const warned = new Set<string>();
    const useWorkspace = (on: boolean) => void context.workspaceState.update(STATE_USE_WORKSPACE_KEY, on);

    useWorkspace(workspaceFirst);
    await warnIfKeyWithheld(context, warned, async () => undefined);
    await warnIfKeyWithheld(context, warned, async () => undefined);
    expect(warn).toHaveBeenCalledTimes(1);

    useWorkspace(!workspaceFirst);
    await warnIfKeyWithheld(context, warned, async () => undefined);
    await warnIfKeyWithheld(context, warned, async () => undefined);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("announces the same scope and origin once", async () => {
    const context = await bothWithheldAtB();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const warned = new Set<string>();
    for (let i = 0; i < 3; i++) await warnIfKeyWithheld(context, warned, async () => undefined);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("a key is never paired with a list read at another moment", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  afterEach(() => vi.restoreAllMocks());

  /** The old key (approved for A) is read; then a Save of a new key for B completes
   * during the `nth` read of the key secret. */
  async function resolveDuringSave(nth: number) {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-old");
    setMockConfig({ baseUrl: B });

    const get = context.secrets.get.bind(context.secrets);
    let keyReads = 0;
    let saving = false;
    context.secrets.get = async (name: string) => {
      const value = await get(name);
      if (name === SECRET_API_KEY && ++keyReads === nth && !saving) {
        saving = true;
        await storeApiKey(context, "sk-new"); // approves B for sk-new only
      }
      return value;
    };
    return resolveConnection(context);
  }

  it.each([[1], [2]])("does not send the old key to the new origin when a Save lands during key read %i", async (nth) => {
    const connection = await resolveDuringSave(nth);
    expect(connection.apiKey).not.toBe("sk-old");
  });

  it("withholds the key for this call when the list changed between its two reads", async () => {
    const connection = await resolveDuringSave(2);
    expect(connection).toMatchObject({ apiKey: undefined, keyWithheld: true });
  });

  it("still sends a settled key", async () => {
    setMockConfig({ baseUrl: A });
    const context = fakeContext();
    await storeApiKey(context, "sk-1");
    expect(await resolveConnection(context)).toMatchObject({ apiKey: "sk-1", keyWithheld: false });
  });
});

describe("watchKeySecrets", () => {
  const WS = "file:///work/acme";
  const OTHER_WS = "file:///work/other";

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setMockWorkspace();
  });

  /** A context whose SecretStorage can announce a change, as VS Code does for another window's write. */
  function watched() {
    const listeners = new Set<(event: { key: string }) => void>();
    const context = {
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
        onDidChange: (listener: (event: { key: string }) => void) => {
          listeners.add(listener);
          return { dispose: () => void listeners.delete(listener) };
        },
      },
    } as unknown as vscode.ExtensionContext;
    return { context, listenerCount: () => listeners.size, change: (key: string) => listeners.forEach((l) => l({ key })) };
  }

  it("calls back once, 150 ms after the last change of a burst (a key is stored in three writes)", async () => {
    const { context, change } = watched();
    const onChange = vi.fn(async () => undefined);
    const watcher = watchKeySecrets(context, onChange, () => undefined);

    change(SECRET_API_KEY_ORIGINS);
    await vi.advanceTimersByTimeAsync(100);
    change(SECRET_API_KEY);
    await vi.advanceTimersByTimeAsync(100);
    change(SECRET_API_KEY_ORIGINS);
    await vi.advanceTimersByTimeAsync(SECRET_CHANGE_SETTLE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(SECRET_CHANGE_SETTLE_MS).toBe(150);
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it("reacts to the global pair and to the pair of the open workspace, and to nothing else", async () => {
    setMockWorkspace({ folders: [WS] });
    const { context, change } = watched();
    const onChange = vi.fn(async () => undefined);
    const watcher = watchKeySecrets(context, onChange, () => undefined);
    const settle = () => vi.advanceTimersByTimeAsync(SECRET_CHANGE_SETTLE_MS);

    for (const name of [
      SECRET_API_KEY,
      SECRET_API_KEY_ORIGINS,
      workspaceSecretName(WS),
      workspaceOriginsSecretName(WS),
    ]) {
      change(name);
      await settle();
    }
    expect(onChange).toHaveBeenCalledTimes(4);

    onChange.mockClear();
    for (const name of [
      "some.other.extension.token",
      "omnicopilot.somethingElse",
      workspaceSecretName(OTHER_WS),
      workspaceOriginsSecretName(OTHER_WS),
    ]) {
      change(name);
      await settle();
    }
    expect(onChange).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("ignores a workspace pair when no workspace is open", async () => {
    const { context, change } = watched();
    const onChange = vi.fn(async () => undefined);
    const watcher = watchKeySecrets(context, onChange, () => undefined);

    change(workspaceSecretName(WS));
    await vi.advanceTimersByTimeAsync(SECRET_CHANGE_SETTLE_MS);

    expect(onChange).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("stops listening and drops a pending call when disposed", async () => {
    const { context, change, listenerCount } = watched();
    const onChange = vi.fn(async () => undefined);
    const watcher = watchKeySecrets(context, onChange, () => undefined);
    expect(listenerCount()).toBe(1);

    change(SECRET_API_KEY);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(SECRET_CHANGE_SETTLE_MS * 2);

    expect(listenerCount()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a failed refresh instead of leaving a rejection unhandled", async () => {
    const { context, change } = watched();
    const onError = vi.fn();
    const watcher = watchKeySecrets(
      context,
      async () => {
        throw new Error("refresh failed");
      },
      onError
    );

    change(SECRET_API_KEY);
    await vi.advanceTimersByTimeAsync(SECRET_CHANGE_SETTLE_MS);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "refresh failed" }));
    watcher.dispose();
  });
});
