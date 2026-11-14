import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { DEFAULT_BASE_URL, normalizeBaseUrl, serverRootUrl } from "./client";
import { explainProbeFailure, type ProbeResult } from "./diagnostics";

/** SecretStorage entry holding the API key. */
export const SECRET_API_KEY = "omnicopilot.apiKey";
/** SecretStorage entry holding the origins the user approved for the stored key,
 * as a JSON array, newest last. It lives next to the key so that it travels
 * with it to every window, remote host and profile that can read the key. */
export const SECRET_API_KEY_ORIGINS = "omnicopilot.apiKeyOrigins";
/** SecretStorage entry of a workspace's own key: this prefix + 16 hex characters of a
 * hash of the workspace identity, so the identity (a path) never appears in a name. */
export const SECRET_API_KEY_WORKSPACE_PREFIX = "omnicopilot.apiKey.ws.";
/** The approved origins of that workspace key, next to it, like the global key's list. */
export const SECRET_API_KEY_ORIGINS_WORKSPACE_PREFIX = "omnicopilot.apiKeyOrigins.ws.";
/** workspaceState entry (a boolean): this workspace uses its own key when one is stored. */
export const STATE_USE_WORKSPACE_KEY = "omnicopilot.useWorkspaceKey";
/** How many approved origins are kept; the oldest is dropped first. */
const MAX_APPROVED_ORIGINS = 5;
/** globalState entry listing the plain-HTTP origins the user was already warned about. */
const STATE_INSECURE_WARNED = "omnicopilot.insecureOriginsWarned";
/** workspaceState entry holding the ignored workspace URL the user was last told about. */
const STATE_IGNORED_URL_NOTICE = "omnicopilot.ignoredUrlNotice";

/** Where a key is stored: the user's global key, or the one of the open workspace. */
export type KeyScope = "workspace" | "global";

export interface Connection {
  /** Normalized API base URL (always ends in `/v1`). */
  baseUrl: string;
  /** Scheme + host + port of `baseUrl`. */
  origin: string;
  /** The key to send. Undefined when none is stored or when it is withheld. */
  apiKey?: string;
  hasStoredKey: boolean;
  /** A key is stored but was saved for another origin, so it is not sent. */
  keyWithheld: boolean;
  /** Origins the user approved for the stored key, newest last. */
  approvedOrigins: string[];
  /** A server URL this workspace's settings set and that is not used (see `ignoredWorkspaceUrl`). */
  ignoredWorkspaceUrl: string | undefined;
  /** Which stored key is in effect (the one `apiKey`, `hasStoredKey` and `keyWithheld` describe). */
  keyScope: KeyScope | "none";
  /** A workspace is open, so it can have a key of its own. */
  workspaceKeyAvailable: boolean;
  /** This workspace is set to use its own key (stored or not yet). */
  useWorkspaceKey: boolean;
}

/** `hash` is the first 16 hex characters of the SHA-256 of the workspace identity. */
function workspaceHash(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

/** SecretStorage entry of the key of the workspace with this identity. */
export function workspaceSecretName(workspaceId: string): string {
  return SECRET_API_KEY_WORKSPACE_PREFIX + workspaceHash(workspaceId);
}

/** SecretStorage entry of the origins approved for that workspace key. */
export function workspaceOriginsSecretName(workspaceId: string): string {
  return SECRET_API_KEY_ORIGINS_WORKSPACE_PREFIX + workspaceHash(workspaceId);
}

/**
 * What identifies the open workspace: its saved workspace file, else the first
 * folder. An untitled workspace file has no stable name (it changes once saved),
 * so it does not count. Undefined when no workspace is open.
 */
export function workspaceIdentity(args: {
  workspaceFile?: string;
  firstFolder?: string;
}): string | undefined {
  const file = args.workspaceFile?.trim();
  if (file && !/^untitled:/i.test(file)) return file;
  return args.firstFolder?.trim() || undefined;
}

function currentWorkspaceIdentity(): string | undefined {
  return workspaceIdentity({
    workspaceFile: vscode.workspace.workspaceFile?.toString(),
    firstFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
  });
}

/**
 * Which key is in effect: the workspace's own when a workspace is open, the
 * switch is on and one is stored; else the global one when stored; else none.
 */
export function chooseKeyScope(args: {
  workspaceId?: string;
  useWorkspaceKey: boolean;
  workspaceKey?: string;
  globalKey?: string;
}): { scope: KeyScope | "none"; key?: string } {
  if (args.workspaceId && args.useWorkspaceKey && args.workspaceKey) {
    return { scope: "workspace", key: args.workspaceKey };
  }
  if (args.globalKey) return { scope: "global", key: args.globalKey };
  return { scope: "none" };
}

/** The two secrets of one scope; a workspace scope needs an open workspace. */
function secretNames(scope: KeyScope): { key: string; origins: string } {
  if (scope === "global") return { key: SECRET_API_KEY, origins: SECRET_API_KEY_ORIGINS };
  const id = currentWorkspaceIdentity();
  if (!id) throw new Error("No workspace is open, so there is no workspace key.");
  return { key: workspaceSecretName(id), origins: workspaceOriginsSecretName(id) };
}

/** The stored key of one scope, for the "Set API Key" prompt to show. */
export async function readStoredKey(
  context: vscode.ExtensionContext,
  scope: KeyScope
): Promise<string | undefined> {
  return (await context.secrets.get(secretNames(scope).key)) || undefined;
}

function useWorkspaceKeySwitch(context: vscode.ExtensionContext): boolean {
  return context.workspaceState.get<boolean>(STATE_USE_WORKSPACE_KEY, false) === true;
}

async function setUseWorkspaceKey(context: vscode.ExtensionContext, on: boolean): Promise<void> {
  await context.workspaceState.update(STATE_USE_WORKSPACE_KEY, on);
}

/** Scheme, lower-case host and port of a base URL, without any path. */
export function originOf(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized.replace(/\/v1$/i, "").toLowerCase();
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return octets !== null && octets.slice(1).every((part) => Number(part) <= 255);
}

/**
 * The key goes only to the origins the user approved for it. A key from before
 * 1.4.0 (no list at all) is adopted by the current origin; after that, a changed
 * URL keeps the key at home until the user approves it on purpose.
 */
export function decideKeyUse(args: {
  storedKey?: string;
  approvedOrigins?: readonly string[];
  currentOrigin: string;
}): { apiKey?: string; keyWithheld: boolean; bindNow: boolean } {
  const { storedKey, approvedOrigins, currentOrigin } = args;
  if (!storedKey) return { apiKey: undefined, keyWithheld: false, bindNow: false };
  if (approvedOrigins === undefined) {
    return { apiKey: storedKey, keyWithheld: false, bindNow: true };
  }
  if (approvedOrigins.includes(currentOrigin)) {
    return { apiKey: storedKey, keyWithheld: false, bindNow: false };
  }
  return { apiKey: undefined, keyWithheld: true, bindNow: false };
}

/**
 * The stored list of approved origins. Undefined only when nothing is stored (a
 * key from before 1.4.0); anything unreadable is an empty list, so a damaged
 * value withholds the key instead of letting any origin adopt it.
 */
export function parseApprovedOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function readApprovedOrigins(
  context: vscode.ExtensionContext,
  name: string = SECRET_API_KEY_ORIGINS
): Promise<string[] | undefined> {
  return parseApprovedOrigins(await context.secrets.get(name));
}

async function writeApprovedOrigins(
  context: vscode.ExtensionContext,
  origins: readonly string[],
  name: string = SECRET_API_KEY_ORIGINS
): Promise<void> {
  await context.secrets.store(name, JSON.stringify(origins));
}

/** The fields of `inspect("baseUrl")` the server URL may come from. */
interface InspectedUrl {
  globalValue?: unknown;
  defaultValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * The server URL as the user set it: the user-level value (in a remote window VS
 * Code merges the remote machine's settings into it), else the declared default,
 * else the built-in one. Workspace, folder and language-specific values are never
 * read, so a repository cannot point the extension, and the key, elsewhere.
 */
export function userLevelBaseUrl(inspected: InspectedUrl | undefined): string {
  for (const value of [inspected?.globalValue, inspected?.defaultValue]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return DEFAULT_BASE_URL;
}

/**
 * The URL a workspace's settings set but that is not used: the folder value, else
 * the workspace value (the one VS Code would have applied), when it is a
 * non-empty string whose root differs from the effective one.
 */
export function ignoredWorkspaceUrl(args: {
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  effectiveRoot: string;
}): string | undefined {
  const candidate = [args.workspaceFolderValue, args.workspaceValue].find(
    (value): value is string => typeof value === "string" && value.trim() !== ""
  );
  if (candidate === undefined) return undefined;
  return serverRootUrl(candidate) === args.effectiveRoot ? undefined : candidate.trim();
}

/** Longest address shown in a notification; longer ones are cut with "…". */
const MAX_DISPLAY_URL = 200;

/** C0/C1 control characters, DEL and the Unicode line and paragraph separators. */
function isControlOrLineBreak(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** Characters VS Code's notification link syntax `[label](target)` is made of. */
function encodeLinkSyntax(text: string, keepBrackets = false): string {
  return text.replace(/[[\]()<>`]/g, (char) =>
    keepBrackets && (char === "[" || char === "]")
      ? char
      : `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Whether `value` is an http: or https: URL (after trimming). */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * An address made safe to show in a notification. VS Code renders
 * `[label](command:…)` in notification text as a link that runs the command, and
 * an address can come from a workspace's, a remote machine's or a container's
 * settings. An http(s) URL is reduced to the parser's scheme, host, port and path
 * (no credentials, query, fragment or trailing slash); anything else is shown as
 * trimmed text. Then line breaks and control characters are removed, the link
 * characters are percent-encoded (except an IPv6 host's brackets) and the result
 * is cut to 200 characters. It can never contain `](`.
 */
export function displayUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = value.trim();
  const strip = (part: string) => [...part].filter((char) => !isControlOrLineBreak(char)).join("");
  let shown: string;
  if (isHttpUrl(text)) {
    const url = new URL(text);
    // Only an IPv6 host can hold brackets; parentheses and backticks can occur in a host.
    const origin = encodeLinkSyntax(`${url.protocol}//${url.host}`, url.hostname.startsWith("["));
    shown = origin + encodeLinkSyntax(strip(url.pathname.replace(/\/+$/, "")));
  } else {
    shown = encodeLinkSyntax(strip(text));
  }
  return shown.length > MAX_DISPLAY_URL ? `${shown.slice(0, MAX_DISPLAY_URL)}…` : shown;
}

/** Free text (an error message) made safe for a notification: control characters
 * and line breaks become one space, and no `](` is left to form a link. */
export function plainNotificationText(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of text) {
    if (isControlOrLineBreak(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  if (pendingSpace) out += " ";
  return out.split("](").join("] (");
}

/** The only read of the `omnicopilot.baseUrl` setting. */
function readUrlSetting(): { baseUrl: string; ignoredWorkspaceUrl: string | undefined } {
  const inspected = vscode.workspace
    .getConfiguration("omnicopilot")
    .inspect<string>("baseUrl") as InspectedUrl | undefined;
  const baseUrl = normalizeBaseUrl(userLevelBaseUrl(inspected));
  return {
    baseUrl,
    ignoredWorkspaceUrl: ignoredWorkspaceUrl({
      workspaceValue: inspected?.workspaceValue,
      workspaceFolderValue: inspected?.workspaceFolderValue,
      effectiveRoot: serverRootUrl(baseUrl),
    }),
  };
}

function configuredBaseUrl(): string {
  return readUrlSetting().baseUrl;
}

/** The one place that resolves the server URL and the stored API key. */
export async function resolveConnection(context: vscode.ExtensionContext): Promise<Connection> {
  const setting = readUrlSetting();
  const baseUrl = setting.baseUrl;
  const origin = originOf(baseUrl);
  const workspaceId = currentWorkspaceIdentity();
  const useWorkspaceKey = useWorkspaceKeySwitch(context);
  const globalKey = (await context.secrets.get(SECRET_API_KEY)) || undefined;
  const workspaceKey = workspaceId
    ? (await context.secrets.get(workspaceSecretName(workspaceId))) || undefined
    : undefined;

  const chosen = chooseKeyScope({ workspaceId, useWorkspaceKey, workspaceKey, globalKey });
  // The key goes only to origins approved FOR THAT KEY: the list read is the chosen key's own.
  const originsName =
    chosen.scope === "workspace" && workspaceId
      ? workspaceOriginsSecretName(workspaceId)
      : SECRET_API_KEY_ORIGINS;
  const keyName =
    chosen.scope === "workspace" && workspaceId ? workspaceSecretName(workspaceId) : SECRET_API_KEY;
  // The list, then the key, then the list again. A Save landing in between would
  // pair the old key with the new key's list; if the two reads of the list differ
  // the key is withheld for this call, and the next poll reads a settled state.
  const rawBefore = await context.secrets.get(originsName);
  const storedKey = chosen.scope === "none" ? undefined : (await context.secrets.get(keyName)) || undefined;
  const rawAfter = await context.secrets.get(originsName);
  const settled = rawBefore === rawAfter;
  const stored = parseApprovedOrigins(rawAfter);
  // Only the global key can predate the list (1.4.0). A workspace key is always
  // written with one, so a missing list there is damage and withholds the key.
  const approvedOrigins = chosen.scope === "workspace" ? (stored ?? []) : stored;

  const decision = settled
    ? decideKeyUse({ storedKey, approvedOrigins, currentOrigin: origin })
    : { apiKey: undefined, keyWithheld: Boolean(storedKey), bindNow: false };
  if (decision.bindNow) {
    await writeApprovedOrigins(context, [origin], originsName);
    await warnIfInsecure(context, origin);
  }
  return {
    baseUrl,
    origin,
    apiKey: decision.apiKey,
    hasStoredKey: Boolean(storedKey),
    keyWithheld: decision.keyWithheld,
    approvedOrigins: decision.bindNow ? [origin] : (approvedOrigins ?? []),
    ignoredWorkspaceUrl: setting.ignoredWorkspaceUrl,
    keyScope: chosen.scope,
    workspaceKeyAvailable: workspaceId !== undefined,
    useWorkspaceKey,
  };
}

/**
 * The scope the "Set API Key" command writes: the one the user chose. The
 * workspace's when a workspace is open and its switch is on (even before it has
 * a key, so the typed key becomes the workspace key), the global one otherwise.
 */
export function chosenKeyScope(context: vscode.ExtensionContext): KeyScope {
  return currentWorkspaceIdentity() !== undefined && useWorkspaceKeySwitch(context)
    ? "workspace"
    : "global";
}

/**
 * The scope a write that "acts on the key in effect" targets: the workspace's when
 * that key is in effect, the global one otherwise. A plain read, with none of the
 * bookkeeping `resolveConnection` does.
 */
export async function keyScopeInEffect(context: vscode.ExtensionContext): Promise<KeyScope> {
  const workspaceId = currentWorkspaceIdentity();
  if (!workspaceId || !useWorkspaceKeySwitch(context)) return "global";
  return (await context.secrets.get(workspaceSecretName(workspaceId))) ? "workspace" : "global";
}

/**
 * On activation and on a configuration change: when this workspace's settings set
 * a server URL that is not used, say so once per value (remembered per workspace).
 */
export async function showIgnoredWorkspaceUrlNotice(context: vscode.ExtensionContext): Promise<void> {
  const setting = readUrlSetting();
  const ignored = setting.ignoredWorkspaceUrl;
  // A value that is not an http(s) URL is only shown in the panel, as text.
  if (!isHttpUrl(ignored) || ignored === context.workspaceState.get<string>(STATE_IGNORED_URL_NOTICE)) {
    return;
  }
  await context.workspaceState.update(STATE_IGNORED_URL_NOTICE, ignored);
  const openPanel = vscode.l10n.t("Open panel");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "This workspace's settings set an OmniRoute server URL ({0}). It is not used: the server URL is read from your user settings, and it is {1}.",
      displayUrl(ignored),
      displayUrl(serverRootUrl(setting.baseUrl))
    ),
    openPanel
  );
  if (pick === openPanel) void vscode.commands.executeCommand("omnicopilot.manage");
}

/**
 * Store a new key in one scope (the global key by default), approved for one
 * origin only: that of `baseUrl` when given (the URL the user is saving in the
 * panel), else the one currently configured. Storing a workspace key also turns
 * on this workspace's use of its own key.
 */
export async function storeApiKey(
  context: vscode.ExtensionContext,
  key: string,
  baseUrl?: string,
  scope: KeyScope = "global"
): Promise<void> {
  const names = secretNames(scope);
  const origin = originOf(baseUrl ?? configuredBaseUrl());
  // Fail-closed at every step: first an empty list (whichever key is stored is
  // withheld everywhere), then the new key, then its one approved origin. The old
  // key is never approved for the new origin, nor the new key for the old ones,
  // and a key is never left without a list (which would read as pre-1.4.0).
  await writeApprovedOrigins(context, [], names.origins);
  await context.secrets.store(names.key, key);
  await writeApprovedOrigins(context, [origin], names.origins);
  if (scope === "workspace") await setUseWorkspaceKey(context, true);
  await warnIfInsecure(context, origin);
}

/**
 * Explicit user action: also send the stored key of one scope to the origin of
 * `baseUrl` when given (the URL the user is saving in the panel), else to the one
 * configured. It never approves anything for the other scope's key.
 */
export async function rebindApiKey(
  context: vscode.ExtensionContext,
  baseUrl?: string,
  scope: KeyScope = "global"
): Promise<void> {
  const names = secretNames(scope);
  if (!(await context.secrets.get(names.key))) return;
  const origin = originOf(baseUrl ?? configuredBaseUrl());
  const approved = (await readApprovedOrigins(context, names.origins)) ?? [];
  const next = [...approved.filter((item) => item !== origin), origin].slice(-MAX_APPROVED_ORIGINS);
  await writeApprovedOrigins(context, next, names.origins);
  await warnIfInsecure(context, origin);
}

/** Delete one scope's key and its list; the other scope's key is untouched.
 * Clearing the workspace key also turns this workspace's switch off. */
export async function clearApiKey(
  context: vscode.ExtensionContext,
  scope: KeyScope = "global"
): Promise<void> {
  const names = secretNames(scope);
  // The key first: a key left without its list would read as one from before 1.4.0.
  await context.secrets.delete(names.key);
  await context.secrets.delete(names.origins);
  if (scope === "workspace") await setUseWorkspaceKey(context, false);
}

/**
 * The panel's Save: the key typed (if any), the "only in this workspace" box and
 * the URL being saved. Ticked with a key typed stores a workspace key; unticked
 * with a key typed stores the global one and turns the switch off; with no key
 * typed only the switch changes, and the URL is approved for the key then in
 * effect. Without an open workspace the box means nothing. Returns whether a key
 * was stored.
 */
export async function saveKeyFromPanel(
  context: vscode.ExtensionContext,
  args: { key: string; useWorkspaceKey: boolean; url: string }
): Promise<boolean> {
  const hasWorkspace = currentWorkspaceIdentity() !== undefined;
  const useWorkspace = hasWorkspace && args.useWorkspaceKey;
  if (hasWorkspace && !useWorkspace) await setUseWorkspaceKey(context, false);

  if (args.key) {
    await storeApiKey(context, args.key, args.url, useWorkspace ? "workspace" : "global");
    return true;
  }
  if (useWorkspace) await setUseWorkspaceKey(context, true);
  await rebindApiKey(context, args.url, await keyScopeInEffect(context));
  return false;
}

/** Tell the user, once per origin, that a key bound to plain HTTP travels in the clear. */
async function warnIfInsecure(context: vscode.ExtensionContext, origin: string): Promise<void> {
  if (!origin.startsWith("http://") || isLoopbackOrigin(origin)) return;
  const warned = context.globalState.get<string[]>(STATE_INSECURE_WARNED, []);
  if (warned.includes(origin)) return;
  await context.globalState.update(STATE_INSECURE_WARNED, [...warned, origin]);
  void vscode.window.showWarningMessage(
    vscode.l10n.t(
      "The API key for {0} travels over plain HTTP. Anyone on the network path can read it. Prefer HTTPS or a tunnel for a server outside this machine.",
      displayUrl(origin)
    )
  );
}

/** The sentence that tells the user why requests leave without their key; undefined when the key is sent. */
export function keyWithheldMessage(connection: Connection): string | undefined {
  if (!connection.keyWithheld) return undefined;
  return vscode.l10n.t(
    "The stored API key was saved for {0} and is not being sent to {1}. Press Save & Test to use it here.",
    connection.approvedOrigins.at(-1) ?? "",
    connection.origin
  );
}

/**
 * After a configuration change: when the stored key is now withheld, say so once
 * per scope and origin (`warned` is the caller's in-memory record) and offer to approve
 * the new server. `onRebound` refreshes whatever depends on the key.
 */
export async function warnIfKeyWithheld(
  context: vscode.ExtensionContext,
  warned: Set<string>,
  onRebound: () => Promise<void>
): Promise<void> {
  const connection = await resolveConnection(context);
  // Per scope as well as origin: a global key announced for this server must not
  // silence a workspace key withheld for the same one.
  const announced = `${connection.keyScope}|${connection.origin}`;
  if (!connection.keyWithheld || warned.has(announced)) return;
  warned.add(announced);
  const useHere = vscode.l10n.t("Use the key here");
  const openPanel = vscode.l10n.t("Open panel");
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "The OmniRoute server URL is now {0}. The stored API key was saved for {1} and is not being sent to the new server.",
      displayUrl(serverRootUrl(connection.baseUrl)),
      displayUrl(connection.approvedOrigins.at(-1))
    ),
    useHere,
    openPanel
  );
  if (pick === useHere) {
    // Approve the server the warning named, even if the setting moved again meanwhile.
    await rebindApiKey(
      context,
      connection.baseUrl,
      connection.keyScope === "workspace" ? "workspace" : "global"
    );
    await onRebound();
  } else if (pick === openPanel) {
    void vscode.commands.executeCommand("omnicopilot.manage");
  }
}

/** How long the server URL must stay unchanged before a withheld key is announced.
 * The Settings editor commits a string after a one-second pause in typing. */
export const URL_SETTLE_MS = 1500;

/**
 * Runs `warnIfKeyWithheld` once the configuration has stopped changing for
 * `URL_SETTLE_MS`, resolving the connection again at that moment, so only the URL
 * the user ended on can produce the warning and its "Use the key here".
 */
export function createWithheldKeyWatcher(
  context: vscode.ExtensionContext,
  onRebound: () => Promise<void>,
  onError: (err: unknown) => void
): { schedule(): void; dispose(): void } {
  const warned = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        warnIfKeyWithheld(context, warned, onRebound).catch(onError);
      }, URL_SETTLE_MS);
    },
    dispose: cancel,
  };
}

/** How long the secrets must stay quiet before a changed key is acted on. Storing a
 * key writes three times (an emptied list, the key, its list), so one change of a
 * key arrives as a burst. */
export const SECRET_CHANGE_SETTLE_MS = 150;

/** Whether a SecretStorage entry is one of the two pairs that decide which key is
 * sent: the global key and its list, and those of the open workspace. */
function isKeySecretName(name: string): boolean {
  if (name === SECRET_API_KEY || name === SECRET_API_KEY_ORIGINS) return true;
  const workspaceId = currentWorkspaceIdentity();
  return (
    workspaceId !== undefined &&
    (name === workspaceSecretName(workspaceId) || name === workspaceOriginsSecretName(workspaceId))
  );
}

/**
 * Calls `onChange` once the key, or the list of origins approved for it, has stopped
 * changing for `SECRET_CHANGE_SETTLE_MS`. SecretStorage is shared by every window, so
 * this is how a window learns that another one stored or cleared the key. Changes to
 * any other secret are ignored. The workspace pair is the open workspace's own, read
 * when each change arrives. Dispose it with the extension.
 *
 * It relies on a refresh not writing a secret: a refresh that did would fire this
 * watcher again. The one exception is `resolveConnection` adopting a key that has no
 * approved-servers list (one stored before 1.4.0) by writing the list; that write
 * fires one more change and refresh, and the second pass finds the list, so it
 * cannot repeat.
 */
export function watchKeySecrets(
  context: vscode.ExtensionContext,
  onChange: () => Promise<void>,
  onError: (err: unknown) => void
): { dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const subscription = context.secrets.onDidChange((event) => {
    if (!isKeySecretName(event.key)) return;
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      onChange().catch(onError);
    }, SECRET_CHANGE_SETTLE_MS);
  });
  return {
    dispose() {
      cancel();
      subscription.dispose();
    },
  };
}

/** Explain a failed probe for the server at `baseUrl`, using what this VS Code window knows about itself. */
export function describeProbeFailure(
  baseUrl: string,
  result: Extract<ProbeResult, { ok: false }>,
  timeoutMs: number
): { summary: string; hints: string[] } {
  return explainProbeFailure(result, {
    // The summary is shown in a notification by "Check Connection".
    url: displayUrl(serverRootUrl(baseUrl)),
    timeoutSeconds: Math.round(timeoutMs / 1000),
    remoteName: vscode.env.remoteName,
    isLoopback: isLoopbackOrigin(originOf(baseUrl)),
    t: vscode.l10n.t,
  });
}
