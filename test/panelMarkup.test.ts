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
