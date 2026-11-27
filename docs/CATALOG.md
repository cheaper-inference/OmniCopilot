# How the model list is built

What you see in the Copilot Chat picker is not the raw `GET /v1/models` payload.
The extension shapes it, and the numbers below come from a real OmniRoute
instance measured on 2026-08-18 (2345 raw catalog entries).

| Stage | Entries | What happened |
| --- | ---: | --- |
| Raw catalog, server default | 2345 | every model listed **twice** (see below) |
| `?prefix=alias` | 1396 | 949 duplicate ids dropped, **zero models lost** |
| Non-chat models removed | 1319 | 26 image / video / audio / rerank rows |

## 1. Why the raw catalog lists everything twice

OmniRoute's `MODELS_CATALOG_PREFIX_MODE` defaults to **`dual`**, which advertises
each model under *both* its short alias prefix and its canonical provider prefix,
for backward compatibility with client configs that hardcoded either one:

```
cc/claude-sonnet-4-6        ← alias prefix
claude/claude-sonnet-4-6    ← canonical prefix — same model
```

Both route fine; they are the same model. In a picker they read as duplicates.

The extension asks for **`GET /v1/models?prefix=alias`**, a supported per-request
override (see `tests/unit/models-catalog-low-noise-flag.test.ts` in the OmniRoute
repo), so the server sends one id per model without changing its global setting
for other clients.

> ⚠️ **Never use `?prefix=canonical`.** In OmniRoute's `catalog.ts` the canonical
> row is only emitted when `canonicalProviderId !== alias`, so providers without a
> distinct alias would emit **nothing** — that mode silently loses models. `alias`
> is the safe direction, and was verified as lossless: all 949 dropped ids were
> mirrors.

A second, server-independent guard drops mirror rows via their `parent`
back-reference, so an OmniRoute too old to honor `?prefix` is covered too. On the
measured instance both paths converge on the same 1319 models.

## 2. Why some models never appear

**Specialty registries.** The catalog also carries image, video, audio, rerank,
embedding and moderation models. OmniRoute rejects those on a chat request:

```
HTTP 400 — Model 'cheaperinference/nano-banana-pro' is an image-generation model
and cannot be used on /v1/chat/completions. Use POST /v1/images/generations instead.
```

They are filtered by the catalog's `type` field, so they never reach the picker.

**Responses-API models are *not* filtered.** Every Codex / GPT-5.x entry is listed
as `supported_endpoints: ["responses"]`, but OmniRoute translates those for
`/v1/chat/completions` — `cx/gpt-5.5-low` and `cx/gpt-5.6-sol-low` both answer
HTTP 200. Treating "does not list chat" as "unusable" would drop 26 working
models, so only genuinely non-conversational surfaces are excluded.

**Your `modelFilter` setting.** `omnicopilot.modelFilter` is a regex (falling back
to substring matching if the regex is invalid) applied to the model id. Empty by
default.

## 3. Why you see providers you never configured

OmniRoute advertises models from:

1. every provider with an **active connection**, plus
2. every **noAuth** provider — the ones that need no credential at all. This is
   the free-providers part of OmniRoute, and it is intentional.

To hide the keyless ones, add them to `blockedProviders` in the OmniRoute
dashboard settings. Nothing needs to change in the extension.

## 4. Refreshing

The extension caches the catalog per discovery call. **`OmniRoute: Refresh
Models`** (Command Palette) or the ↻ link in the panel re-queries the server and
tells VS Code the list changed. Changing any `omnicopilot.*` setting refreshes
automatically.
