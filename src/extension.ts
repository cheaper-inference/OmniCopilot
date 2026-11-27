import * as vscode from "vscode";
import { OmniRouteClient, serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import {
  clearApiKey,
  chosenKeyScope,
  connectionRefreshFingerprint,
  readStoredKey,
  resolveConnection,
  showIgnoredWorkspaceUrlNotice,
  createWithheldKeyWatcher,
  watchKeySecrets,
  displayUrl,
  keyWithheldMessage,
  plainNotificationText,
  storeApiKey,
} from "./connection";
import { OmniPanelProvider } from "./panel";
import { OmniRouteChatProvider, isKeyRejection, type ModelListing } from "./provider";
import { ConnectionStatusBar } from "./statusBar";
import { fetchPersonalUsage } from "./usage";

const OMNIROUTE_REPO = "https://github.com/cheaper-inference/OmniRoute";
const VENDOR = "omniroute";

let provider: OmniRouteChatProvider | undefined;
let statusBar: ConnectionStatusBar | undefined;
let panel: OmniPanelProvider | undefined;
/** The connection the last refresh ran for (`connectionRefreshFingerprint`: the key only by its hash). */
let refreshedFor: string | undefined;
let outputLog: vscode.LogOutputChannel | undefined;

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

/**
 * "The connection may have changed": the status bar restarts (and reads its usage
 * again), the picker lists again and the panel shows a fresh status. Every trigger
 * that can change the key in effect comes through here: the panel's Save and Clear,
 * the "Set API Key" command, the withheld-key warning and the key watcher.
 * `panelRefresh: "start"` starts the panel's refresh without waiting for it.
 */
async function connectionMayHaveChanged(
  context: vscode.ExtensionContext,
  panelRefresh: "await" | "start" = "await",
  fingerprint?: string
): Promise<void> {
  try {
    refreshedFor = fingerprint ?? connectionRefreshFingerprint(await resolveConnection(context));
  } catch (err) {
    // SecretStorage failing, say. Everything below is refreshed all the same (each part
    // reads the connection again and reports its own failure), and with nothing recorded
    // the next key change refreshes whatever it finds.
    refreshedFor = undefined;
    outputLog?.warn(`Reading the connection failed: ${String(err)}`);
  }
  statusBar?.restart();
  await provider?.refresh();
  const panelRefreshed = panel?.refreshStatus();
  if (panelRefresh === "await") await panelRefreshed;
}

/**
 * The key watcher's refresh: only when the resolved connection differs, field for
 * field, from the one the last refresh ran for. That skips the echo of this window's
 * own write (the explicit refresh already ran) and a change of a key this window does
 * not use (the global key, while the workspace key is in effect).
 */
async function refreshIfConnectionChanged(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const connection = await resolveConnection(context);
  const fingerprint = connectionRefreshFingerprint(connection);
  if (fingerprint === refreshedFor) {
    // A poll may have read the key between the writes and left a stale withheld state.
    statusBar?.recheckIfWithheldDiffers(connection);
    return;
  }
  log.info("API key changed — refreshing models and status");
  await connectionMayHaveChanged(context, "await", fingerprint);
}

async function makeClient(context: vscode.ExtensionContext): Promise<OmniRouteClient> {
  const { baseUrl, apiKey } = await resolveConnection(context);
  return new OmniRouteClient({ baseUrl, apiKey });
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OmniRoute for Copilot", { log: true });
  context.subscriptions.push(log);
  outputLog = log;
  log.info(`Activating v${context.extension.packageJSON.version}`);
  /** Start a promise nobody waits for, logging instead of leaving a rejection unhandled. */
  const background = (what: string, promise: Promise<unknown> | undefined): void => {
    void promise?.catch((err: unknown) => log.warn(`${what} failed: ${String(err)}`));
  };

  // The walkthrough's first step completes on omnicopilot.serverOnline: true while the
  // status bar finds the server online (it polls the user-level URL only), false before
  // the first answer and while it is offline.
  const setServerOnline = (online: boolean): void =>
    background(
      "Context update",
      Promise.resolve(vscode.commands.executeCommand("setContext", "omnicopilot.serverOnline", online))
    );
  setServerOnline(false);

  statusBar = new ConnectionStatusBar(
    () => makeClient(context),
    log,
    (status) => setServerOnline(status === "online"),
    () => resolveConnection(context),
    // The model picker is empty when the server was down at startup; list again once a poll
    // finds it accepting requests. The first poll runs alongside the host's first listing, so
    // it lists again only when that listing did not succeed.
    (firstPoll) =>
      background("Model refresh", firstPoll ? provider?.refreshUnlessListed() : provider?.refresh()),
    // The key's daily limit next to the status (setting omnicopilot.statusBarUsage).
    (connection) => fetchPersonalUsage(connection.baseUrl, connection.apiKey, vscode.l10n.t)
  );
  context.subscriptions.push(statusBar);

  provider = new OmniRouteChatProvider({
    context,
    log,
    onActivity: (ok) => statusBar?.reportActivity(ok),
  });
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
  log.info(`Language model chat provider registered (vendor: ${VENDOR})`);

  panel = new OmniPanelProvider(
    context,
    log,
    () => connectionMayHaveChanged(context),
    () => provider!.currentListing()
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OmniPanelProvider.viewId, panel)
  );

  registerCommands(context, log);

  // "Use the key here" in the withheld-key warning is the user approving the server.
  const withheldKeyWatcher = createWithheldKeyWatcher(
    context,
    () => connectionMayHaveChanged(context),
    (err) => log.warn(`Withheld-key check failed: ${String(err)}`)
  );
  context.subscriptions.push(withheldKeyWatcher);

  // A key stored, replaced or cleared in another window of this machine arrives here, and so
  // does the echo of this window's own writes; only a change of the connection refreshes.
  context.subscriptions.push(
    watchKeySecrets(
      context,
      () => refreshIfConnectionChanged(context, log),
      (err) => log.warn(`Refresh after an API key change failed: ${String(err)}`)
    )
  );
  // What the start-up (the first poll and the host's first listing) runs for, unless an
  // explicit refresh has already recorded a newer one.
  background(
    "Connection check",
    resolveConnection(context).then((connection) => {
      refreshedFor ??= connectionRefreshFingerprint(connection);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("omnicopilot")) return;
      log.info("Configuration changed — refreshing models and status");
      // Only the server and what the status bar shows make its usage number worthless.
      const usageAffected = ["baseUrl", "statusBar", "statusBarUsage"].some((key) =>
        e.affectsConfiguration(`omnicopilot.${key}`)
      );
      statusBar?.restart({ keepUsage: !usageAffected });
      background("Model refresh", provider?.refresh());
      background("Panel refresh", panel?.refreshStatus());
      withheldKeyWatcher.schedule();
      background("Workspace URL check", showIgnoredWorkspaceUrlNotice(context));
    })
  );

  statusBar.start();
  background("Workspace URL check", showIgnoredWorkspaceUrlNotice(context));
  background("First-run check", checkFirstRun(context, log));
}

function registerCommands(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // The management gear in "Manage Models" and the status-bar menu both land
  // on the visual panel (Activity Bar view) where URL + API key live.
  register("omnicopilot.manage", () => panel?.focus());
  register("omnicopilot.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "omnicopilot")
  );
  register("omnicopilot.setApiKey", () => setApiKey(context, log));

  register("omnicopilot.refreshModels", async () => {
    if (!provider) return;
    // The picker is told to list again, and the command takes part in that same listing
    // (whichever of the two asks first starts it): one download, made after the command
    // was invoked, so the result below is what the server answered. The provider tells
    // the user why when it fails. Not awaited: the listing starts in this same turn.
    void provider.refresh();
    const listing = await provider.listModels({ silent: false });
    if (listing.ok) {
      void vscode.window.showInformationMessage(
        // The count comes last so the sentence needs no plural form in any language.
        vscode.l10n.t("Models listed from {1}: {0}.", listing.count, displayUrl(listing.serverUrl))
      );
    } else {
      await explainWithheldKey(context, listing);
    }
  });

  register("omnicopilot.checkConnection", async () => {
    // A probe overtaken by a change of the connection is checked again for the new one.
    const ok = await statusBar?.checkNow({ rechecks: 2 });
    if (ok) {
      // The probe is answered without a key; only a listing proves the key works.
      const listing = await provider?.listModels({ silent: false });
      if (listing?.ok) {
        // Named like "Models listed from …": the root of the server the listing went to.
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Connected to OmniRoute at {0}.", displayUrl(listing.serverUrl))
        );
      } else if (listing) {
        await explainWithheldKey(context, listing);
      }
    } else {
      const summary = statusBar?.failureSummary;
      void vscode.window.showWarningMessage(
        summary !== undefined
          ? plainNotificationText(summary)
          : vscode.l10n.t(
              "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot.baseUrl points at it."
            )
      );
    }
  });

  register("omnicopilot.openDashboard", async () => {
    const root = serverRootUrl((await resolveConnection(context)).baseUrl);
    const mode = getConfig().get<string>("dashboardOpen", "external");
    if (mode === "editor") {
      // The Simple Browser is an iframe, so the server must allow framing.
      // Probing first matters: simpleBrowser.show SUCCEEDS against a server that
      // sends X-Frame-Options: DENY, leaving a "refused to connect" tab that the
      // catch below would never see.
      const client = await makeClient(context);
      if (await client.canEmbedDashboard()) {
        try {
          await vscode.commands.executeCommand("simpleBrowser.show", root);
          return;
        } catch (err) {
          log.warn(`Simple Browser unavailable, falling back to external: ${String(err)}`);
        }
      } else {
        log.info(
          `${root} does not allow framing — opening externally. Rebuild OmniRoute with DASHBOARD_ALLOW_EMBED=vscode to enable the editor tab.`
        );
        void warnDashboardNotEmbeddable();
      }
    }
    void vscode.env.openExternal(vscode.Uri.parse(root));
  });

  register("omnicopilot.openGitHub", () => {
    void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
  });

  register("omnicopilot.installOmniRoute", async () => {
    const copyLabel = vscode.l10n.t("Copy install command");
    const githubLabel = vscode.l10n.t("Open GitHub");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute is a free, open-source AI router: one endpoint, hundreds of providers (many of them free), auto-fallback. Install it with npm and this extension lights up automatically."
      ),
      copyLabel,
      githubLabel
    );
    if (pick === copyLabel) {
      await vscode.env.clipboard.writeText("npm install -g omniroute && omniroute");
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Copied "{0}" — paste it in any terminal.', "npm install -g omniroute && omniroute")
      );
    } else if (pick === githubLabel) {
      void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
    }
  });

  register("omnicopilot.configureCliTool", (toolId?: unknown) =>
    configureCliTool(context, log, typeof toolId === "string" ? toolId : undefined)
  );

  register("omnicopilot.quickActions", () => quickActions(context));
}


/** A listing failed. The provider has already said so, except when the server
 * answered 401/403 to a request that went out without the stored key: that is the
 * expected answer, and the reason is the withheld key. */
async function explainWithheldKey(
  context: vscode.ExtensionContext,
  listing: ModelListing
): Promise<void> {
  if (!listing.keyWithheld || !isKeyRejection(listing.failure?.status)) return;
  const message = keyWithheldMessage(await resolveConnection(context));
  if (message) void vscode.window.showWarningMessage(plainNotificationText(message));
}

/** Explain once why `dashboardOpen: "editor"` fell back to the browser. The flag
 * is compiled into the OmniRoute build, so this cannot be fixed from the client. */
let embedWarningShown = false;
async function warnDashboardNotEmbeddable(): Promise<void> {
  if (embedWarningShown) return;
  embedWarningShown = true;
  const learnMore = vscode.l10n.t("How to enable it");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "This OmniRoute server does not allow embedding, so the dashboard opened in your browser. It has to be built with DASHBOARD_ALLOW_EMBED=vscode — a build-time option, so setting the variable on an existing install is not enough."
    ),
    learnMore
  );
  if (pick === learnMore) {
    void vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/cheaper-inference/OmniRoute/blob/main/docs/guides/VSCODE-COPILOT.md")
    );
  }
}

/** Menu behind the status-bar item. */
async function quickActions(context: vscode.ExtensionContext): Promise<void> {
  const client = await makeClient(context);
  const online = await client.ping(1500);

  const items: Array<vscode.QuickPickItem & { action: string }> = [
    {
      label: online
        ? `$(circle-filled) ${vscode.l10n.t("Online")}`
        : `$(circle-outline) ${vscode.l10n.t("Offline")}`,
      description: client.baseUrl,
      action: "check",
    },
    { label: `$(gear) ${vscode.l10n.t("Configure connection (URL / API key)")}`, action: "manage" },
    { label: `$(sync) ${vscode.l10n.t("Refresh models")}`, action: "refresh" },
    { label: `$(dashboard) ${vscode.l10n.t("Open OmniRoute dashboard")}`, action: "dashboard" },
    {
      label: `$(terminal) ${vscode.l10n.t("Configure a coding CLI (Codex, Claude Code…)")}`,
      action: "cli",
    },
    { label: `$(github) ${vscode.l10n.t("OmniRoute on GitHub")}`, action: "github" },
  ];
  if (!online) {
    items.splice(1, 0, {
      label: `$(cloud-download) ${vscode.l10n.t("Install OmniRoute")}`,
      description: "npm i -g omniroute",
      action: "install",
    });
  }

  const picked = await vscode.window.showQuickPick(items, { title: "OmniRoute" });
  const commandByAction: Record<string, string> = {
    check: "omnicopilot.checkConnection",
    manage: "omnicopilot.manage",
    refresh: "omnicopilot.refreshModels",
    dashboard: "omnicopilot.openDashboard",
    cli: "omnicopilot.configureCliTool",
    github: "omnicopilot.openGitHub",
    install: "omnicopilot.installOmniRoute",
  };
  if (picked) void vscode.commands.executeCommand(commandByAction[picked.action]);
}

async function setApiKey(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  // The command works on the key the user chose: this workspace's own when the
  // workspace is set to use one, the global key otherwise.
  const scope = chosenKeyScope(context);
  const existing = await readStoredKey(context, scope);
  const key = await vscode.window.showInputBox({
    title:
      scope === "workspace"
        ? vscode.l10n.t("API key for this workspace")
        : vscode.l10n.t("OmniRoute API key"),
    prompt: vscode.l10n.t("Stored securely in the OS keychain (SecretStorage). Leave empty to clear."),
    value: existing ?? "",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;

  if (key.trim()) {
    await storeApiKey(context, key.trim(), undefined, scope);
    log.info("API key stored in SecretStorage");
  } else if (existing) {
    await clearApiKey(context, scope);
    log.info("API key cleared");
  }
  // The status bar (and its usage number), the picker and the panel follow the key
  // that was just stored or cleared.
  await connectionMayHaveChanged(context, "start");
}

/** One-time welcome: point users at the model picker or at installing OmniRoute. */
async function checkFirstRun(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const FLAG = "omnicopilot.welcomed";
  if (context.globalState.get<boolean>(FLAG)) return;
  await context.globalState.update(FLAG, true);

  const client = await makeClient(context);
  const online = await client.ping();
  log.info(`First run — OmniRoute ${online ? "detected" : "not detected"} at ${client.baseUrl}`);

  if (online) {
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute detected! Your models are ready — open the Copilot Chat model picker and choose any OmniRoute model."
      ),
      vscode.l10n.t("How to pick a model")
    );
    if (pick) {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://code.visualstudio.com/docs/agent-customization/language-models")
      );
    }
  } else {
    const installLabel = vscode.l10n.t("Install OmniRoute");
    const configureLabel = vscode.l10n.t("Configure connection");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniCopilot: bring hundreds of AI models to Copilot Chat with OmniRoute — many free providers, free forever. No OmniRoute server detected yet."
      ),
      installLabel,
      configureLabel
    );
    if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
    } else if (pick === configureLabel) {
      void vscode.commands.executeCommand("omnicopilot.manage");
    }
  }
}

export function deactivate(): void {
  provider = undefined;
  statusBar = undefined;
  panel = undefined;
  refreshedFor = undefined;
  outputLog = undefined;
}
