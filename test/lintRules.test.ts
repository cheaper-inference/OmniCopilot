import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** The repository's own lint configuration, applied to code that is not on disk. */
const root = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: root });

/** The no-restricted-syntax messages ESLint reports for `code` as if it were `file`. */
async function restricted(code: string, file = "src/probe.ts"): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${file}` });
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
}

const head = 'import * as vscode from "vscode";\n';

describe("the lint rules that keep settings reads where they belong", { timeout: 60_000 }, () => {
  it.each([
    'vscode.workspace.getConfiguration("omnicopilot").get("baseUrl");',
    'vscode.workspace.getConfiguration("omnicopilot").inspect("baseUrl");',
    'vscode.workspace.getConfiguration().get("omnicopilot.baseUrl");',
    'vscode.workspace.getConfiguration("omnicopilot.baseUrl");',
    "vscode.workspace.getConfiguration(`omnicopilot.baseUrl`);",
  ])("refuses a read of the server URL outside the connection module: %s", async (line) => {
    expect(await restricted(head + line)).toEqual([expect.stringContaining("resolveConnection")]);
  });

  it.each([
    'vscode.workspace.getConfiguration("omnicopilot").get("sendProjectName");',
    'vscode.workspace.getConfiguration("omnicopilot.sendProjectName");',
  ])("refuses a read of sendProjectName that is not inspect().globalValue: %s", async (line) => {
    expect(await restricted(head + line)).toEqual([expect.stringContaining("globalValue")]);
  });

  it("refuses getConfiguration on the server URL inside the connection module too, and allows its inspect()", async () => {
    expect(await restricted(head + 'vscode.workspace.getConfiguration("omnicopilot.baseUrl");', "src/connection.ts")).toHaveLength(1);
    expect(await restricted(head + 'vscode.workspace.getConfiguration("omnicopilot").inspect("baseUrl");', "src/connection.ts")).toEqual([]);
  });

  it("allows the reads the code base makes", async () => {
    expect(
      await restricted(
        head +
          'const cfg = vscode.workspace.getConfiguration("omnicopilot");\n' +
          'cfg.get("modelFilter");\n' +
          'cfg.inspect("sendProjectName")?.globalValue;\n'
      )
    ).toEqual([]);
  });
});
