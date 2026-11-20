import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createdTerminals, setMockConfig, setMockWorkspace } from "./vscode.mock";
import { storeApiKey } from "../src/connection";
import {
  CLI_TOOLS,
  cliRemoteDecision,
  configureCliTool,
  isSafeRemoteUrl,
  remoteUrlArgument,
  resolveCliCommand,
  shellQuote,
} from "../src/cliBridge";

const linux = { platform: "linux" as const };
const cmdExe = { platform: "win32" as const, shellPath: "C:\\Windows\\System32\\cmd.exe" };
const winPath = "C:\\Program Files (x86)\\nodejs\\omniroute.cmd";

describe("resolveCliCommand", () => {
  it.each([
    "omniroute",
    "npx omniroute",
    "/usr/local/bin/omniroute",
    "~/bin/omniroute",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\omniroute.cmd",
  ])("accepts %s and returns it unchanged", (value) => {
    expect(resolveCliCommand(value, linux)).toEqual({ ok: true, command: value });
    expect(resolveCliCommand(`  ${value}  `, cmdExe)).toEqual({ ok: true, command: value });
  });

  it("double-quotes a quoted executable path on cmd.exe, without the call operator", () => {
    expect(resolveCliCommand(`"${winPath}"`, cmdExe)).toEqual({
      ok: true,
      command: `"${winPath}"`,
    });
  });

  it.each(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Windows\\System32\\powershell.exe"])(
    "prefixes the call operator for PowerShell (%s)",
    (shellPath) => {
      expect(resolveCliCommand(`"${winPath}"`, { platform: "win32", shellPath })).toEqual({
        ok: true,
        command: `& "${winPath}"`,
      });
    }
  );

  it("single-quotes a quoted executable path on linux", () => {
    expect(resolveCliCommand("'/opt/my tools/omniroute'", linux)).toEqual({
      ok: true,
      command: "'/opt/my tools/omniroute'",
    });
  });

  it("re-quotes a path that was wrapped in the other quote character", () => {
    expect(resolveCliCommand('"/opt/my tools/omniroute"', linux)).toEqual({
      ok: true,
      command: "'/opt/my tools/omniroute'",
    });
  });

  it.each([
    "omniroute; curl x | sh",
    "omniroute && id",
    "`id`",
    "$(id)",
    "omniroute | tee",
    "a\nb",
    "omni'route",
    'omni"route',
    "omniroute > f",
    "",
    "   ",
    '"',
    winPath,
    "omniroute (x86)",
  ])("rejects %j", (value) => {
    expect(resolveCliCommand(value, linux)).toEqual({ ok: false });
    expect(resolveCliCommand(value, cmdExe)).toEqual({ ok: false });
  });

  it.each(["'", '"', "`", "$", ";", "&", "|", "<", ">", "\n"])(
    "rejects a quoted value whose inside holds %j",
    (bad) => {
      for (const quote of ['"', "'"]) {
        const value = `${quote}/opt/my${bad}tools/omniroute${quote}`;
        expect(resolveCliCommand(value, linux)).toEqual({ ok: false });
        expect(resolveCliCommand(value, cmdExe)).toEqual({ ok: false });
      }
    }
  );

  it("rejects a value with mismatched quotes", () => {
    expect(resolveCliCommand(`"/opt/omniroute'`, linux)).toEqual({ ok: false });
  });
});

describe("shellQuote", () => {
  it("wraps a value in double quotes for a Windows shell and leaves it as it is", () => {
    expect(shellQuote(winPath, "win32")).toBe(`"${winPath}"`);
    expect(shellQuote("https://a.example:20128", "win32")).toBe('"https://a.example:20128"');
  });

  it.each([
    ['a double quote', 'C:\\tools\\omni"route.cmd'],
    ['a double quote after a backslash', 'C:\\tools\\" & calc & "'],
    ['a trailing backslash', "C:\\tools\\"],
  ])("refuses a value with %s on Windows: no escape is right for both cmd.exe and PowerShell", (_what, value) => {
    expect(shellQuote(value, "win32")).toBeUndefined();
  });

  it("single-quotes for a POSIX shell, where a quote inside is closed, escaped and reopened", () => {
    expect(shellQuote("/opt/my tools/omniroute", "linux")).toBe("'/opt/my tools/omniroute'");
    expect(shellQuote("it's", "linux")).toBe("'it'\\''s'");
    // Inside single quotes a backslash is an ordinary character, a trailing one included.
    expect(shellQuote("/opt/dir\\", "linux")).toBe("'/opt/dir\\'");
  });
});

describe("resolveCliCommand and a path that cannot be quoted", () => {
  it("refuses a quoted Windows path that ends in a backslash (it would swallow the closing quote)", () => {
    expect(resolveCliCommand('"C:\\Program Files\\omni\\"', cmdExe)).toEqual({ ok: false });
    expect(
      resolveCliCommand('"C:\\Program Files\\omni\\"', {
        platform: "win32",
        shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      })
    ).toEqual({ ok: false });
  });

  it("still takes the same kind of path on linux, where single quotes keep the backslash literal", () => {
    expect(resolveCliCommand("'/opt/my tools/dir\\'", linux)).toEqual({
      ok: true,
      command: "'/opt/my tools/dir\\'",
    });
  });
});

describe("CLI_TOOLS", () => {
  it("lists the Gemini, Zed, WhyCodes and 5dive setups", () => {
    const subcommands = CLI_TOOLS.map((tool) => tool.subcommand);
    for (const sub of ["setup-gemini", "setup-zed", "setup-whycodes", "setup-5dive"]) {
      expect(subcommands).toContain(sub);
    }
  });

  it("gives every tool a unique id and a setup-* subcommand", () => {
    expect(new Set(CLI_TOOLS.map((tool) => tool.id)).size).toBe(CLI_TOOLS.length);
    for (const tool of CLI_TOOLS) expect(tool.subcommand).toMatch(/^setup-[a-z0-9]+$/);
  });
});

describe("isSafeRemoteUrl", () => {
  it.each([
    "https://omni.example",
    "http://192.168.0.4:20128",
    "http://[::1]:20128",
    "http://[2001:db8::1]:8080",
    "https://omni.example/gateway/omniroute",
    "https://omni.example:8443/a-b_c.d~e",
  ])("accepts %s", (root) => {
    expect(isSafeRemoteUrl(root)).toBe(true);
  });

  it.each(["$", "`", '"', "'", "<", ">", "|", "&", ";", "(", ")", "{", "}", "\\", "%"])(
    "refuses a URL carrying %s",
    (char) => {
      expect(isSafeRemoteUrl(`https://omni.example/a${char}b`)).toBe(false);
      expect(isSafeRemoteUrl(`https://omni.example/x?q=${char}`)).toBe(false);
    }
  );

  it.each([" ", "\t", "\n", "\r", "\u0000", "\u001b", "\u007f"])(
    "refuses a URL carrying whitespace or the control character %j",
    (char) => {
      expect(isSafeRemoteUrl(`https://omni.example/a${char}b`)).toBe(false);
    }
  );

  it("refuses what is not an http(s) URL", () => {
    expect(isSafeRemoteUrl("not a url")).toBe(false);
    expect(isSafeRemoteUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeRemoteUrl("")).toBe(false);
  });
});

describe("isSafeRemoteUrl and cmd.exe variables", () => {
  it("refuses a percent sign, which cmd.exe expands inside double quotes", () => {
    expect(isSafeRemoteUrl("https://omni.example/%PATH%")).toBe(false);
    expect(isSafeRemoteUrl("https://omni.example/a%20b")).toBe(false);
  });
});

describe("remoteUrlArgument", () => {
  it("passes the re-serialised root, without a trailing slash", () => {
    expect(remoteUrlArgument("https://Omni.Example:443")).toBe("https://omni.example");
    expect(remoteUrlArgument("http://[::1]:20128")).toBe("http://[::1]:20128");
    expect(remoteUrlArgument("https://omni.example/gateway")).toBe("https://omni.example/gateway");
  });

  it("gives nothing for a URL that is refused", () => {
    expect(remoteUrlArgument("https://omni.example/$(calc)")).toBeUndefined();
  });
});

describe("Configure Coding CLI and the workspace key", () => {
  const WS = "file:///work/acme";
  const QUESTION =
    "This workspace's API key will be handed to Codex CLI, whose configuration is shared by all your projects.";

  afterEach(() => {
    vi.restoreAllMocks();
    setMockWorkspace();
    createdTerminals.length = 0;
  });

  function fakeContext() {
    const secrets = new Map<string, string>();
    const local = new Map<string, unknown>();
    return {
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => void secrets.set(key, value),
        delete: async (key: string) => void secrets.delete(key),
      },
      globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
      workspaceState: {
        get: <T>(key: string, fallback?: T) => (local.has(key) ? (local.get(key) as T) : fallback),
        update: async (key: string, value: unknown) => void local.set(key, value),
      },
    } as unknown as vscode.ExtensionContext;
  }

  const log = () =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as vscode.LogOutputChannel;

  async function withKeys(opts: { workspaceKey: boolean }) {
    setMockConfig({ baseUrl: "http://localhost:20128" });
    setMockWorkspace({ folders: [WS] });
    const context = fakeContext();
    await storeApiKey(context, "sk-global");
    if (opts.workspaceKey) await storeApiKey(context, "sk-ws", undefined, "workspace");
    return context;
  }

  it("asks first, as a modal with the single action Continue, and proceeds on Continue", async () => {
    const context = await withKeys({ workspaceKey: true });
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Continue" as never);

    await configureCliTool(context, log(), "codex");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([QUESTION, { modal: true }, "Continue"]);
    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].env).toEqual({ OMNIROUTE_API_KEY: "sk-ws" });
    expect(createdTerminals[0].sent).toEqual(["omniroute setup-codex"]);
  });

  it.each([[undefined], ["Cancel"]])("sends nothing to a terminal when the question is answered %j", async (answer) => {
    const context = await withKeys({ workspaceKey: true });
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(answer as never);

    await configureCliTool(context, log(), "codex");

    expect(createdTerminals).toHaveLength(0);
  });

  it("does not ask when the global key is in effect", async () => {
    const context = await withKeys({ workspaceKey: false });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await configureCliTool(context, log(), "codex");

    expect(warn).not.toHaveBeenCalled();
    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].env).toEqual({ OMNIROUTE_API_KEY: "sk-global" });
  });

  it("does not ask when no key is stored", async () => {
    setMockConfig({ baseUrl: "http://localhost:20128" });
    setMockWorkspace({ folders: [WS] });
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await configureCliTool(fakeContext(), log(), "codex");

    expect(warn).not.toHaveBeenCalled();
    expect(createdTerminals[0].env).toBeUndefined();
  });
});

describe("the server address handed to the CLI", () => {
  it("is left out only when the root is exactly the default", () => {
    expect(cliRemoteDecision("http://localhost:20128")).toEqual({ kind: "default" });
  });

  it.each([
    ["HTTP://LOCALHOST:20128"],
    ["http://localhost:20128/"],
    ["http://localhost:20128/v1"],
    ["http://localhost:20128/v1/"],
    [" http://Localhost:20128/V1/ "],
  ])("recognises the default server written as %j", (root) => {
    expect(cliRemoteDecision(root)).toEqual({ kind: "default" });
  });

  it.each([
    ["http://localhost:20128/other", "http://localhost:20128/other"],
    ["http://user@localhost:20128", "http://user@localhost:20128"],
    ["http://localhost:20128?x=1", "http://localhost:20128/?x=1"],
  ])("does not take %s for the default server", (root, remote) => {
    expect(cliRemoteDecision(root)).toEqual({ kind: "remote", remote });
  });

  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://localhost:20128", "https://localhost:20128"],
    ["http://127.0.0.1:20128", "http://127.0.0.1:20128"],
    ["https://omni.example", "https://omni.example"],
    ["http://192.168.0.17:20128", "http://192.168.0.17:20128"],
  ])("is passed as --remote for %s", (root, remote) => {
    expect(cliRemoteDecision(root)).toEqual({ kind: "remote", remote });
  });

  it("is refused for a root that cannot be typed into a terminal safely", () => {
    expect(cliRemoteDecision("https://omni.example/$(calc)")).toEqual({ kind: "refused" });
    expect(cliRemoteDecision("ftp://omni.example")).toEqual({ kind: "refused" });
  });
});

describe("Configure Coding CLI and a local server that is not the default", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    createdTerminals.length = 0;
  });

  const context = {
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    globalState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
    workspaceState: { get: (_key: string, fallback?: unknown) => fallback, update: async () => undefined },
  } as unknown as vscode.ExtensionContext;
  const log = () =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as vscode.LogOutputChannel;

  it.each([
    ["http://localhost:3000", "omniroute setup-codex --remote 'http://localhost:3000'"],
    ["https://localhost:20128", "omniroute setup-codex --remote 'https://localhost:20128'"],
    ["http://127.0.0.1:20128", "omniroute setup-codex --remote 'http://127.0.0.1:20128'"],
    ["http://localhost:20128", "omniroute setup-codex"],
    ["localhost:20128/v1/", "omniroute setup-codex"],
  ])("runs the CLI for %s as %s", async (baseUrl, command) => {
    setMockConfig({ baseUrl });

    await configureCliTool(context, log(), "codex");

    expect(createdTerminals[0]?.sent).toEqual([command]);
  });
});
