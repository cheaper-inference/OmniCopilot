import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Commands a completion event may name besides our own. */
const COMPLETION_BUILT_INS = [
  "workbench.action.chat.manage",
  "workbench.action.chat.openModelPicker",
  "workbench.action.openSettings",
];

const LINK_LINE = /^\[[^\]]+\]\(command:[^)]+\)$/;

/** The text inside the parentheses of every `[label](command:...)` link, in order. */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\]\((command:[^)]+)\)/g)].map((m) => m[1]);
}

/**
 * Compare a translated walkthrough description with the English one. Returns a list of
 * problems (empty when the translation keeps every link, in order, alone on its line).
 */
function compareLinks(english: string, translated: string): string[] {
  const problems: string[] = [];
  const want = linkTargets(english);
  const got = linkTargets(translated);
  if (got.join("\n") !== want.join("\n")) {
    problems.push(`link targets differ: expected [${want.join(", ")}], got [${got.join(", ")}]`);
  }
  for (const line of translated.split("\n")) {
    if (line.includes("](command:") && !LINK_LINE.test(line)) {
      problems.push(`link not alone on its line: "${line}"`);
    }
  }
  return problems;
}

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

  it("only uses completion events that point at existing commands and settings", () => {
    const ownCommands = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
    let seen = 0;
    for (const step of steps) {
      expect(step.completionEvents?.length, `${step.id} completionEvents`).toBeGreaterThan(0);
      for (const event of step.completionEvents ?? []) {
        seen++;
        const [prefix, ...rest] = event.split(":");
        const id = rest.join(":");
        if (prefix === "onCommand") {
          const ok = ownCommands.has(id) || COMPLETION_BUILT_INS.includes(id);
          expect(ok, `${step.id}: ${event}`).toBe(true);
        } else if (prefix === "onSettingChanged") {
          expect(id, `${step.id}: ${event}`).toBe("chat.utilityModel");
        } else {
          expect.unreachable(`${step.id}: unexpected completion event ${event}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("says in the utility step that its settings need a recent VS Code", () => {
    const step = (walkthrough?.steps as Step[]).find((s) => s.id === "utility");
    const markdown = readFileSync(resolve(root, step!.media.markdown), "utf8");
    expect(markdown).toContain(
      "These settings exist in recent versions of VS Code; on an older one the search comes back empty."
    );
  });

  it("keeps the command links of every translated description intact", () => {
    const locales = readdirSync(root).filter((f) => /^package\.nls\..+\.json$/.test(f));
    for (const file of locales) {
      const translated: Record<string, string> = read(file);
      for (const key of Object.keys(translated).filter((k) => /^walkthrough\..*description$/.test(k))) {
        expect(nls[key], `${file}: ${key} has no English source`).toBeDefined();
        expect(compareLinks(nls[key], translated[key]), `${file}: ${key}`).toEqual([]);
      }
    }
  });
});

describe("compareLinks", () => {
  const english =
    "Install it.\n[Install OmniRoute](command:omnicopilot.installOmniRoute)\n[Check](command:omnicopilot.checkConnection)";

  it("accepts a translation that changes the prose and the labels but not the links", () => {
    const pt =
      "Instale.\n[Instalar o OmniRoute](command:omnicopilot.installOmniRoute)\n[Verificar](command:omnicopilot.checkConnection)";
    expect(compareLinks(english, pt)).toEqual([]);
  });

  it("rejects a missing link", () => {
    const missing = "Instale.\n[Instalar](command:omnicopilot.installOmniRoute)";
    expect(compareLinks(english, missing)).not.toEqual([]);
  });

  it("rejects an altered link target", () => {
    const altered =
      "Instale.\n[Instalar](command:omnicopilot.installOmniRoute)\n[Verificar](command:omnicopilot.checkConection)";
    expect(compareLinks(english, altered)).not.toEqual([]);
  });

  it("rejects links in a different order", () => {
    const swapped =
      "Instale.\n[Verificar](command:omnicopilot.checkConnection)\n[Instalar](command:omnicopilot.installOmniRoute)";
    expect(compareLinks(english, swapped)).not.toEqual([]);
  });

  it("rejects a link glued to prose", () => {
    const glued =
      "Instale. [Instalar](command:omnicopilot.installOmniRoute)\n[Verificar](command:omnicopilot.checkConnection)";
    expect(compareLinks(english, glued)).not.toEqual([]);
  });
});
