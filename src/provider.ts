import * as vscode from "vscode";
import { expandForAgentsWindow } from "./agentsWindow";
import { selectChatModels } from "./catalogFilter";
import { OmniRouteClient, OmniRouteRequestError, projectHeaderValue, serverRootUrl } from "./client";
import { SECRET_API_KEY, displayUrl, resolveConnection, type Connection } from "./connection";
import { estimateTokens, toOpenAiMessages, toOpenAiTools } from "./convert";
import { comboDetail, comboSummary, comboSummaryMarkdown, describeModel, priceLabel } from "./modelInfo";
import {
  buildEffortSchema,
  effortTiersFor,
  isReasoningModel,
  resolveReasoningEffort,
  type EffortSchema,
} from "./reasoning";
import { requestParamsFromModelOptions } from "./requestParams";
import { DEFAULT_RETRY_POLICY, nextRetryDelay } from "./retry";
import { createToolNameAliases } from "./toolNames";
import type { ChatRequest, OmniRouteCombo, OmniRouteModel, StreamUsage } from "./types";
import { USAGE_MIME_TYPE, buildUsagePayload } from "./usage";

export { SECRET_API_KEY };

interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
  /** #14 — proposed-API (`chatProvider`) field read by the host via duck
   * typing; scopes an entry to one chat session type (the Agents window's
   * agent host) and removes it from the general picker. See agentsWindow.ts. */
  targetChatSessionType?: string;
  /** Proposed-API field read by the host via duck typing: every property with
   * an `enum` becomes a submenu in the model picker, and the choice comes back
   * in `options.modelConfiguration`. Not in the stable typings. */
  configurationSchema?: EffortSchema;
  /** Proposed-API fields read by the host the same way. The window is the
   * total one (input plus output); `pricing` is a free-form label; `infoText`
   * maps a category to a MARKDOWN string shown as a banner in the picker
   * hover. `isBYOK` is derived by the host, and `inputCost`/`outputCost` are in
   * Copilot credits, not dollars: none of those three is ever set here. */
  maxContextWindowTokens?: number;
  pricing?: string;
  infoText?: Record<string, string>;
}

/** Choices the host hands back for the picker declared in `configurationSchema`
 * (proposed API, so read through a local type). */
interface ConfiguredChatOptions {
  modelConfiguration?: Record<string, unknown>;
}

/** `vscode.LanguageModelThinkingPart` is proposed API: hosts expose the class
 * at runtime, the typings do not declare it, and an older host may lack it. */
type ThinkingPartClass = new (value: string) => vscode.LanguageModelResponsePart;

/** The host's thinking-part class, or undefined when it has none. Read at call
 * time, never cached at load. */
function thinkingPartClass(): ThinkingPartClass | undefined {
  const candidate = (vscode as { LanguageModelThinkingPart?: unknown }).LanguageModelThinkingPart;
  return typeof candidate === "function" ? (candidate as ThinkingPartClass) : undefined;
}

/** Picker label for a reasoning tier; an unknown tier shows its identifier. */
function effortLabel(tier: string): string {
  switch (tier) {
    case "none":
      return vscode.l10n.t("Off");
    case "low":
      return vscode.l10n.t("Low");
    case "medium":
      return vscode.l10n.t("Medium");
    case "high":
      return vscode.l10n.t("High");
    case "xhigh":
      return vscode.l10n.t("Extra high");
    case "max":
      return vscode.l10n.t("Max");
    default:
      return tier;
  }
}

/** What one listing of the server's models came to. */
export interface ModelListing {
  /** The picker entries; empty when the listing failed or nothing passed the filters. */
  infos: OmniModelInfo[];
  /** The server answered the listing and the answer was used. */
  ok: boolean;
  /** Root of the server the listing went to. */
  serverUrl: string;
  /** How many models the picker lists: the entries above, counted once per model
   * (the Agents-window clones share their model's id). */
  count: number;
  /** Why it failed: an HTTP status the server answered with, or no status at all,
   * and the client's own sentence about it. */
  failure?: { status?: number; message?: string };
  /** The stored key was not sent to this server (see `Connection.keyWithheld`). */
  keyWithheld: boolean;
}

/** The server turned the request down because of the key it saw (or did not see). */
export function isKeyRejection(status: number | undefined): status is 401 | 403 {
  return status === 401 || status === 403;
}

export interface ProviderDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  /** Called whenever a request round-trip settles, with success flag —
   * feeds the status bar without extra polling. */
  onActivity?: (ok: boolean) => void;
}

/** Names of the tools the conversation has already called. */
function historicalToolNames(messages: readonly vscode.LanguageModelChatRequestMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) names.push(part.name);
    }
  }
  return names;
}

/** The server could not be reached at all — as opposed to answering with an
 * HTTP error, which proves it is up. */
function isNetworkError(err: unknown): boolean {
  return err instanceof OmniRouteRequestError && err.info.network === true;
}

/** The arguments of a streamed tool call as an object. An empty string is a call
 * without parameters; text that is not a JSON object gives undefined. */
function parseToolInput(args: string): Record<string, unknown> | undefined {
  if (args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Sleep for `ms`; resolves true if the request was cancelled meanwhile. */
function waitUnlessCancelled(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (token.isCancellationRequested) return resolve(true);
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(true);
    });
  });
}

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

export class OmniRouteChatProvider
  implements vscode.LanguageModelChatProvider<OmniModelInfo>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  /** Ids the catalog marks as reasoning/thinking-capable, refreshed with the
   * catalog. Chat requests consult it before applying the configured default
   * effort — the request itself carries no capability information. */
  private reasoningModelIds = new Set<string>();
  /** Tiers each model advertises (`capabilities.effort_tiers`), by id. */
  private effortTiersById = new Map<string, string[]>();
  /** What the last listing that succeeded came to, until the next `refresh()`. */
  private lastListing: ModelListing | undefined;
  /** The listing under way (whoever started it), for `currentListing` to join. Its
   * `result` is undefined when the host cancelled it or it threw: that is nobody's answer. */
  private inFlightListing: { generation: number; result: Promise<ModelListing | undefined> } | undefined;
  /** Whether the host's last listing in this refresh generation succeeded; undefined
   * until it has listed (a cancelled listing does not count). */
  private hostListingOk: boolean | undefined;
  /** Counts `refresh()` calls: a listing that finishes after one belongs to a
   * connection that may no longer be the current one. */
  private refreshGeneration = 0;

  constructor(private readonly deps: ProviderDeps) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** Re-query the catalog and tell VS Code the model list changed. */
  async refresh(): Promise<void> {
    this.refreshGeneration += 1;
    this.lastListing = undefined;
    this.inFlightListing = undefined;
    this.hostListingOk = undefined;
    this.reasoningModelIds.clear();
    this.effortTiersById.clear();
    this._onDidChange.fire();
  }

  private async makeClient(): Promise<OmniRouteClient> {
    return (await this.connect()).client;
  }

  private async connect(): Promise<{ client: OmniRouteClient; connection: Connection }> {
    const connection = await resolveConnection(this.deps.context);
    const { baseUrl, apiKey } = connection;
    // The client puts the project on chat requests only. The opt-in is a privacy
    // choice that belongs to the user: only the user-level value counts, never a
    // workspace or folder one, whatever scope the platform enforces.
    const optIn = getConfig().inspect<boolean>("sendProjectName")?.globalValue === true;
    const project = optIn ? projectHeaderValue(vscode.workspace.name) : undefined;
    return { client: new OmniRouteClient({ baseUrl, apiKey, project }), connection };
  }

  // ── Model discovery ─────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const generation = this.refreshGeneration;
    const listing = await this.listModels(options, token);
    if (generation === this.refreshGeneration && !token.isCancellationRequested) {
      this.hostListingOk = listing.ok;
    }
    return listing.infos;
  }

  /**
   * One real listing of the server's models. Unless `silent`, a failure tells
   * the user why (the message is not awaited: it must not hold the listing).
   * `silent: true` never prompts: an unreachable server simply contributes no
   * models until the user fixes the connection. While it runs, `currentListing`
   * joins it instead of downloading the catalog again.
   */
  listModels(options: { silent: boolean }, token?: vscode.CancellationToken): Promise<ModelListing> {
    const generation = this.refreshGeneration;
    const listing = this.listFromServer(options, token).then((result) => {
      // A listing whose request the host cancelled is not an answer about the server (the
      // client returns no models for a cancelled token): it neither becomes the count nor
      // clears the one already known.
      if (generation === this.refreshGeneration && !token?.isCancellationRequested) {
        this.lastListing = result.ok ? result : undefined;
      }
      return result;
    });
    const entry = {
      generation,
      result: listing.then(
        (result) => (token?.isCancellationRequested ? undefined : result),
        () => undefined
      ),
    };
    this.inFlightListing = entry;
    // Once it is over the entry goes: a failed listing is not kept for the next caller.
    void entry.result.then(() => {
      if (this.inFlightListing === entry) this.inFlightListing = undefined;
    });
    return listing;
  }

  /**
   * What the picker lists right now, for a view that only reports it (the panel):
   * the last listing that succeeded, else the listing under way in this refresh
   * generation, else one silent listing of its own that every caller asking while
   * it runs shares. Read-only: it never prompts, and a failed listing is not kept,
   * so the next call lists again. A listing the host cancelled is nobody's answer:
   * a caller that joined it lists for itself.
   *
   * When its own listing succeeds after the host's last listing failed, the picker
   * is told to list again (once), so the two agree.
   */
  async currentListing(): Promise<ModelListing> {
    let joined: typeof this.inFlightListing;
    for (;;) {
      if (this.lastListing) return this.lastListing;
      const running =
        this.inFlightListing?.generation === this.refreshGeneration ? this.inFlightListing : undefined;
      if (!running || running === joined) break;
      joined = running;
      const shared = await running.result;
      if (shared) return shared;
    }
    const generation = this.refreshGeneration;
    const listing = await this.listModels({ silent: true });
    if (listing.ok && generation === this.refreshGeneration && this.hostListingOk === false) {
      // The host still holds the empty list of its failed listing. The listing this event
      // causes is the host's own, so it cannot start another round.
      this.hostListingOk = undefined;
      this._onDidChange.fire();
    }
    return listing;
  }

  private async listFromServer(
    options: { silent: boolean },
    token?: vscode.CancellationToken
  ): Promise<ModelListing> {
    const { client, connection } = await this.connect();
    const serverUrl = serverRootUrl(client.baseUrl);

    let models: OmniRouteModel[];
    let combos: OmniRouteCombo[];
    try {
      // The combos only add detail to the picker, so they are fetched at the
      // same time and a failure there (listCombos never throws) costs nothing.
      [models, combos] = await Promise.all([client.listModels(token), client.listCombos(token)]);
      this.deps.onActivity?.(true);
    } catch (err) {
      // An HTTP error (a 401, say) means the server answered: still reachable.
      this.deps.onActivity?.(!isNetworkError(err));
      this.deps.log.warn(`Model discovery failed: ${String(err)}`);
      const status = err instanceof OmniRouteRequestError ? err.info.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (!options.silent) {
        if (!isKeyRejection(status)) {
          void this.offerConnectionHelp(serverUrl);
        } else if (!connection.keyWithheld) {
          void this.offerKeyHelp(serverUrl, status, connection.hasStoredKey);
        }
        // With the key withheld a 401/403 is the expected answer: the
        // withheld-key warning and the panel already say why.
      }
      return {
        infos: [],
        ok: false,
        count: 0,
        serverUrl,
        failure: { status, message },
        keyWithheld: connection.keyWithheld,
      };
    }

    const infos = this.toModelInfos(models, combos);
    this.deps.log.info(`Listed ${infos.length} models from ${client.baseUrl}`);
    return {
      infos,
      ok: true,
      count: new Set(infos.map((info) => info.omniModelId)).size,
      serverUrl,
      keyWithheld: connection.keyWithheld,
    };
  }

  private toModelInfos(models: OmniRouteModel[], combos: OmniRouteCombo[] = []): OmniModelInfo[] {
    const cfg = getConfig();
    const maxOutput = cfg.get<number>("maxOutputTokens", 16384);
    const defaultContext = cfg.get<number>("defaultContextLength", 128000);
    const filterRaw = cfg.get<string>("modelFilter", "").trim();

    let filter: RegExp | undefined;
    if (filterRaw) {
      try {
        filter = new RegExp(filterRaw, "i");
      } catch {
        // invalid regex → fall back to substring matching
        const needle = filterRaw.toLowerCase();
        filter = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    }

    const configuredEffort = cfg.get<string>("defaultReasoningEffort", "");
    // A combo is listed in /v1/models under its own name.
    const combosByName = new Map(combos.map((combo) => [combo.name, combo]));
    const infos: OmniModelInfo[] = [];
    this.reasoningModelIds.clear();
    this.effortTiersById.clear();
    for (const model of selectChatModels(models)) {
      if (filter && !filter.test(model.id)) continue;
      if (isReasoningModel(model)) this.reasoningModelIds.add(model.id);

      const described = describeModel(model, {
        maxOutputTokens: maxOutput,
        defaultContextLength: defaultContext,
      });
      if (described.effortTiers) this.effortTiersById.set(model.id, described.effortTiers);
      const caps = model.capabilities ?? {};
      const combo = model.owned_by === "combo" ? combosByName.get(model.id) : undefined;
      const price = priceLabel(model, (message, ...args) => vscode.l10n.t(message, ...args));
      const tooltip = [
        `OmniRoute · ${model.id}`,
        ...(combo ? [comboSummary(combo)] : []),
        ...(isReasoningModel(model) ? ["extended thinking"] : []),
      ].join(" · ");

      infos.push({
        id: model.id,
        name: described.name,
        family: model.owned_by || "omniroute",
        version: "1.0.0",
        detail: model.owned_by === "combo" ? comboDetail(combo) : model.owned_by,
        tooltip,
        ...(combo ? { infoText: { combo: comboSummaryMarkdown(combo) } } : {}),
        ...(price ? { pricing: price } : {}),
        maxContextWindowTokens: described.contextLength,
        maxInputTokens: described.maxInputTokens,
        maxOutputTokens: described.maxOutputTokens,
        capabilities: {
          // Catalog knows tool_calling/vision per model; default to tools ON
          // (agent mode is the whole point) when the field is absent.
          toolCalling: caps.tool_calling !== false,
          imageInput: caps.vision === true,
        },
        omniModelId: model.id,
        ...(isReasoningModel(model)
          ? {
              configurationSchema: buildEffortSchema(
                effortTiersFor(model),
                { title: vscode.l10n.t("Thinking effort"), label: effortLabel },
                configuredEffort
              ),
            }
          : {}),
      });
    }
    // #14: opt-in second set of entries scoped to the Copilot Agents window.
    // Same omniModelId → the chat path needs no change for these clones.
    return expandForAgentsWindow(infos, cfg.get<boolean>("exposeToAgentsWindow", false));
  }

  /** `serverUrl` is the root of the resolved connection the listing went to. */
  private async offerConnectionHelp(serverUrl: string): Promise<void> {
    const configureLabel = vscode.l10n.t("Configure Connection");
    const installLabel = vscode.l10n.t("Install OmniRoute");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("Could not reach OmniRoute at {0}. Is it running?", displayUrl(serverUrl)),
      configureLabel,
      installLabel
    );
    if (pick === configureLabel) {
      void vscode.commands.executeCommand("omnicopilot.manage");
    } else if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
    }
  }

  /** `serverUrl` is the root of the resolved connection the listing went to.
   * Without a stored key the server is not rejecting one: it needs one. */
  private async offerKeyHelp(serverUrl: string, status: number, hasKey: boolean): Promise<void> {
    const setKeyLabel = vscode.l10n.t("Set API key");
    const address = displayUrl(serverUrl);
    const pick = await vscode.window.showWarningMessage(
      hasKey
        ? vscode.l10n.t("OmniRoute at {0} rejected the API key (HTTP {1}).", address, status)
        : vscode.l10n.t("OmniRoute at {0} needs an API key (HTTP {1}).", address, status),
      setKeyLabel
    );
    if (pick === setKeyLabel) {
      void vscode.commands.executeCommand("omnicopilot.setApiKey");
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────

  async provideLanguageModelChatResponse(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const client = await this.makeClient();
    const log = this.deps.log;

    // Tool names over the wire limit are shortened; the editor still sees (and
    // later replays) the original names, so remember the way back.
    const aliases = createToolNameAliases([
      ...(options.tools ?? []).map((tool) => tool.name),
      ...historicalToolNames(messages),
    ]);

    const request: ChatRequest = {
      model: model.omniModelId,
      messages: toOpenAiMessages(messages, {
        imageInput: model.capabilities?.imageInput === true,
        toolName: aliases.toWire,
      }),
      stream: true,
      stream_options: { include_usage: true },
      tools: toOpenAiTools(options.tools, aliases.toWire),
    };

    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      request.tool_choice = "required";
    }

    const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
    Object.assign(
      request,
      requestParamsFromModelOptions(modelOptions, { maxOutputTokens: model.maxOutputTokens })
    );

    // #7: forward extended-thinking effort. The picker choice (then any per-request value) wins;
    // the configured default only reaches models the catalog marks as reasoning-
    // capable. Nothing is sent when neither applies, so non-thinking models keep
    // the exact request shape they had before.
    const effort = resolveReasoningEffort({
      modelConfiguration: (options as ConfiguredChatOptions).modelConfiguration,
      modelOptions,
      configuredDefault: getConfig().get<string>("defaultReasoningEffort", ""),
      modelIsReasoning: this.reasoningModelIds.has(model.omniModelId),
      modelTiers: this.effortTiersById.get(model.omniModelId),
    });
    if (effort) request.reasoning_effort = effort;

    log.debug(
      `Chat → ${model.omniModelId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)`
    );

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    const startedAt = Date.now();
    let retries = 0;

    try {
      for (;;) {
        // Once text, reasoning or a tool call has reached the editor the answer
        // cannot be started over; the usage part is bookkeeping and does not
        // count, and neither does reasoning a host without thinking parts dropped.
        let streamedOutput = false;
        let serverUsage: StreamUsage | null = null;
        let completionChars = 0;
        let finishReason: string | undefined;
        let invalidToolCall = false;
        // Text or a tool call reached the editor: there is an answer, however short.
        let answered = false;

        try {
          for await (const event of client.streamChat(request, abort.signal)) {
            if (token.isCancellationRequested) break;
            if (event.kind === "usage") {
              serverUsage = event.usage;
            } else if (event.kind === "thinking") {
              // Proposed API: the class may be missing, so it is looked up for
              // every part. Without it the reasoning is dropped, not delivered.
              const ThinkingPart = thinkingPartClass();
              if (ThinkingPart) {
                streamedOutput = true;
                progress.report(new ThinkingPart(event.text));
              }
            } else if (event.kind === "text") {
              streamedOutput = true;
              answered = true;
              completionChars += event.text.length;
              progress.report(new vscode.LanguageModelTextPart(event.text));
            } else if (event.kind === "finish") {
              finishReason = event.reason;
            } else if (event.kind === "toolCall") {
              streamedOutput = true;
              const input = event.cutOff ? undefined : parseToolInput(event.args);
              if (input === undefined) {
                // Never run a tool on arguments that were not understood or never
                // arrived; the request fails once the stream is over and the reason
                // is known.
                log.warn(
                  event.cutOff
                    ? `Tool call ${event.name} was cut off before its arguments; not reporting it`
                    : `Tool call ${event.name} had invalid JSON args; not reporting it`
                );
                invalidToolCall = true;
              } else {
                answered = true;
                progress.report(
                  new vscode.LanguageModelToolCallPart(event.id, aliases.fromWire(event.name), input)
                );
              }
            }
          }
          if (!token.isCancellationRequested) {
            if (finishReason === "length" || finishReason === "content_filter") {
              log.warn(`Answer from ${model.omniModelId} ended early (finish_reason: ${finishReason})`);
            }
            if (invalidToolCall) {
              throw new Error(
                finishReason === "length"
                  ? vscode.l10n.t(
                      "The model's answer was cut off before the tool call was complete. Raise omnicopilot.maxOutputTokens or ask for smaller steps."
                    )
                  : vscode.l10n.t("The model sent a tool call with invalid arguments.")
              );
            }
            if (finishReason === "length" && !answered) {
              // Reasoning (shown or not) took the whole limit. Not retried: the same
              // request would spend the limit the same way.
              throw new Error(
                vscode.l10n.t(
                  "The model used its whole output limit before it wrote an answer. Raise omnicopilot.maxOutputTokens or lower the thinking effort."
                )
              );
            }
          }
          if (!token.isCancellationRequested) {
            // VS Code's chat reads this part to drive the Context Window widget.
            const { payload, estimated } = buildUsagePayload(serverUsage, {
              promptChars: JSON.stringify(request.messages).length,
              completionChars,
            });
            progress.report(
              new vscode.LanguageModelDataPart(
                new TextEncoder().encode(JSON.stringify(payload)),
                USAGE_MIME_TYPE
              )
            );
            log.debug(
              `Usage ← ${model.omniModelId}: ${payload.prompt_tokens}+${payload.completion_tokens}${estimated ? " (estimated)" : ""}`
            );
          }
          this.deps.onActivity?.(true);
          return;
        } catch (err) {
          if (token.isCancellationRequested) return;
          const delay = streamedOutput
            ? null
            : nextRetryDelay(err, retries, Date.now() - startedAt, DEFAULT_RETRY_POLICY);
          if (delay === null) {
            // HTTP errors prove the server answered; only a network failure is "offline".
            this.deps.onActivity?.(!isNetworkError(err));
            log.error(`Chat request failed: ${String(err)}`);
            if (retries > 0 && err instanceof Error) {
              err.message = vscode.l10n.t("{0} (retried {1}×)", err.message, retries);
            }
            throw err;
          }
          retries++;
          log.warn(
            `Chat request to ${model.omniModelId} failed (${String(err)}); ` +
              `retry ${retries}/${DEFAULT_RETRY_POLICY.maxRetries} in ${(delay / 1000).toFixed(1)} s`
          );
          if (await waitUnlessCancelled(delay, token)) return;
        }
      }
    } finally {
      cancelSub.dispose();
    }
  }

  // ── Token counting ──────────────────────────────────────────────────────

  async provideTokenCount(
    _model: OmniModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return estimateTokens(text);
  }
}
