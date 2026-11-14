import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const read = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));

interface Step {
  id: string;
  title: string;
  description: string;
  media: { markdown: string };
  completionEvents?: string[];
}

const pkg = read("package.json");
const nls: Record<string, string> = read("package.nls.json");
const walkthrough = (pkg.contributes.walkthroughs ?? []).find(
  (w: { id: string }) => w.id === "omnicopilot.gettingStarted"
);
const steps: Step[] = walkthrough?.steps ?? [];

// Commands that are not ours but are safe to link to (they ship with VS Code).
const BUILT_IN_COMMANDS = ["workbench.action.chat.manage", "workbench.action.openSettings"];

/** Resolve a `%key%` reference against package.nls.json; throws on a missing key. */
function resolveNls(ref: string): string {
  const m = /^%([^%]+)%$/.exec(ref);
  if (!m) throw new Error(`not an nls reference: ${ref}`);
  return nls[m[1]];
}

describe("getting-started walkthrough", () => {
  it("declares the getting-started walkthrough with four steps in order", () => {
    expect(walkthrough).toBeDefined();
    expect(steps.map((s) => s.id)).toEqual(["run", "connect", "pickModel", "utility"]);
  });

  it("resolves every walkthrough title and description from package.nls.json", () => {
    for (const ref of [walkthrough.title, walkthrough.description]) {
      expect(resolveNls(ref)).toBeTruthy();
    }
    for (const step of steps) {
      expect(resolveNls(step.title), `${step.id} title`).toBeTruthy();
      expect(resolveNls(step.description), `${step.id} description`).toBeTruthy();
    }
  });

  it("points every step at a markdown file that exists", () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const file = step.media?.markdown;
      expect(file, `${step.id} media`).toMatch(/^media\/walkthrough\/.+\.md$/);
      expect(existsSync(resolve(root, file)), file).toBe(true);
    }
  });

  it("only links to commands that exist", () => {
    const known = new Set<string>([
      ...pkg.contributes.commands.map((c: { command: string }) => c.command),
      ...BUILT_IN_COMMANDS,
    ]);
    let seen = 0;
    for (const step of steps) {
      const text = resolveNls(step.description);
      for (const m of text.matchAll(/\(command:([^)?]+)/g)) {
        seen++;
        expect(known.has(m[1]), `${step.id} links to ${m[1]}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("keeps each button link on its own line", () => {
    const link = /^\[[^\]]+\]\(command:[^)]+\)$/;
    let seen = 0;
    for (const step of steps) {
      const lines = resolveNls(step.description).split("\n");
      for (const line of lines) {
        if (line.includes("](command:")) {
          seen++;
          expect(line, `${step.id}: "${line}"`).toMatch(link);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
