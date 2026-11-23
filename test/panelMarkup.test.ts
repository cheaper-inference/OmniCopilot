import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniPanelProvider, escapeHtml } from "../src/panel";
import { listedModels } from "./panelHelpers";

function panelHtml(): string {
  const panel = new OmniPanelProvider(
    {} as vscode.ExtensionContext,
    {} as vscode.LogOutputChannel,
    async () => undefined,
    listedModels()
  );
  return (panel as unknown as { html(): string }).html();
}

/** `text` without the stretch from the first `open` to the last `close`. */
function without(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start < 0 || end < start ? text : text.slice(0, start) + text.slice(end + close.length);
}

/** The document without its style sheet and its script element: what the HTML parser
 * reads as markup. The panel has one of each, and the script comes last. */
function markupOf(html: string): string {
  return without(without(html, "<style>", "</style>"), "<script nonce=", "</script>");
}

const unescapeHtml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

describe("escapeHtml", () => {
  it("escapes every occurrence of the five characters that mean something in markup", () => {
    expect(escapeHtml(`a & b && <i class="x">it's</i>`)).toBe(
      "a &amp; b &amp;&amp; &lt;i class=&quot;x&quot;&gt;it&#39;s&lt;/i&gt;"
    );
    expect(escapeHtml("Save & Test")).toBe("Save &amp; Test");
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("panel document built from translated strings", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Every translated string comes back carrying markup, quotes and two ampersands. */
  const hostile = (source: string) => `</script><b title="x" onclick='y'>${source} && more</b>`;
  const withHostileTranslations = () =>
    vi.spyOn(vscode.l10n, "t").mockImplementation(((source: string) => hostile(source)) as never);

  it("keeps a translation from adding an element or an attribute to the markup", () => {
    withHostileTranslations();
    const markup = markupOf(panelHtml());
    expect(markup).not.toContain("<b ");
    expect(markup).not.toContain("</b>");
    expect(markup).not.toContain("onclick='y'");
    expect(markup).not.toContain("</script>");
  });

  it("escapes every ampersand of a translation, not only the first", () => {
    withHostileTranslations();
    const save = /<button id="save">([^<]*)<\/button>/.exec(markupOf(panelHtml()))?.[1];
    expect(save).toBeDefined();
    expect(save).toContain("&amp;&amp; more");
    expect(unescapeHtml(save!)).toBe(hostile("Save & Test"));
  });

  it("keeps the placeholder and the title attributes whole", () => {
    withHostileTranslations();
    const markup = markupOf(panelHtml());
    const placeholder = /<input id="key" type="password" placeholder="([^"]*)" \/>/.exec(markup)?.[1];
    const title = /<button id="clearKey" class="secondary" title="([^"]*)">/.exec(markup)?.[1];
    expect(unescapeHtml(placeholder ?? "")).toBe(hostile("paste your OmniRoute API key"));
    expect(unescapeHtml(title ?? "")).toBe(hostile("Remove the stored API key"));
  });

  it("keeps the strings handed to the script inside the one script element, unchanged", () => {
    withHostileTranslations();
    const html = panelHtml();
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const literal = /const S = (\{.*\});\n/.exec(html)?.[1];
    expect(literal).toBeDefined();
    expect(literal).not.toContain("<");
    const strings = JSON.parse(literal!) as Record<string, string>;
    expect(strings.keyStored).toBe(hostile("A key is stored in the OS keychain. Leave the field empty to keep it."));
  });

  it("renders the shipped English strings as before", () => {
    const markup = markupOf(panelHtml());
    expect(markup).toContain('<button id="save">Save &amp; Test</button>');
    expect(markup).toContain('<label for="url">Server URL</label>');
    expect(markup).toContain('placeholder="paste your OmniRoute API key"');
  });
});

/** A node of the minimal DOM the panel script runs against: it records what is appended. */
type FakeNode = {
  tag: string;
  id: string;
  children: unknown[];
  textContent: string;
  className: string;
  value: string;
  checked: boolean;
  href?: string;
  rel?: string;
  childElementCount: number;
  style: Record<string, string>;
  dataset: Record<string, string>;
  addEventListener(): void;
  setAttribute(): void;
  append(...nodes: unknown[]): void;
};

/** Runs the panel's real webview script against a minimal DOM and returns its elements by id,
 * the elements it created, and a way to deliver a message. The script is cut out by position. */
function runPanelScript() {
  const html = panelHtml();
  const open = html.indexOf("<script nonce=");
  const start = html.indexOf(">", open) + 1;
  const script = html.slice(start, html.lastIndexOf("</script>"));
  const node = (tag: string, id = ""): FakeNode => ({
    tag,
    id,
    children: [],
    textContent: "",
    className: "",
    value: "",
    checked: false,
    childElementCount: 0,
    style: {},
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    append(...nodes: unknown[]) {
      this.children.push(...nodes);
      this.childElementCount += nodes.filter((n) => typeof n === "object").length;
    },
  });
  const byId = new Map<string, FakeNode>();
  const created: FakeNode[] = [];
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  runInNewContext(script, {
    document: {
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, node("element", id));
        return byId.get(id);
      },
      querySelectorAll: () => [],
      createElement: (tag: string) => {
        const made = node(tag);
        created.push(made);
        return made;
      },
    },
    acquireVsCodeApi: () => ({ postMessage() {} }),
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") onMessage = listener;
      },
    },
  });
  return { byId, created, deliver: (data: unknown) => onMessage?.({ data }) };
}

describe("panel script: the footer credit", () => {
  afterEach(() => vi.restoreAllMocks());

  const translatingCredit = (translation: string) => {
    const t = vscode.l10n.t.bind(vscode.l10n);
    vi.spyOn(vscode.l10n, "t").mockImplementation(((source: string, ...args: unknown[]) =>
      source === "Created by {0}" ? translation : t(source, ...args)) as never);
  };

  it.each([
    ["Created by {0}", "Created by ", ""],
    ["Erstellt von {0} mit Liebe", "Erstellt von ", " mit Liebe"],
    ["{0} が作成", "", " が作成"],
  ])("splits %j around {0} and makes the name a link where the translation puts it", (translation, before, after) => {
    translatingCredit(translation);
    const { byId } = runPanelScript();
    const parts = byId.get("foot")!.children.slice(1);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(before);
    expect(parts[2]).toBe(after);
    expect(parts[1]).toMatchObject({ tag: "a", textContent: "Diego Souza", href: "https://github.com/diegosouzapw" });
  });

  it("still links the name after a translation that lost {0}", () => {
    translatingCredit("Erstellt von");
    const { byId } = runPanelScript();
    const parts = byId.get("foot")!.children.slice(1);
    expect(parts[0]).toBe("Erstellt von ");
    expect(parts[1]).toMatchObject({ tag: "a", textContent: "Diego Souza" });
  });
});

describe("panel script: usage bars", () => {
  it("clamps a bar to 0–100 and draws none without a percentage", () => {
    const { created, deliver } = runPanelScript();
    const quota = (percentLeft: number | null, label: string) => ({ text: "x", label, percentLeft, resetIn: null });
    deliver({
      type: "status",
      online: true,
      url: "http://localhost:20128",
      modelCount: 1,
      hasKey: true,
      usage: {
        kind: "ready",
        personal: null,
        providers: [
          {
            provider: "p",
            quotas: { over: quota(150, "over"), under: quota(-20, "under"), half: quota(42.5, "half"), none: quota(null, "none") },
          },
        ],
      },
    });

    const rows = created.filter((n) => n.className === "usage-row");
    expect(rows).toHaveLength(4);
    const widths = rows.map((row) => {
      const bar = row.children.find((child) => (child as FakeNode).className === "bar") as FakeNode | undefined;
      return bar ? (bar.children[0] as FakeNode).style.width : undefined;
    });
    expect(widths).toEqual(["100%", "0%", "42.5%", undefined]);
  });
});
