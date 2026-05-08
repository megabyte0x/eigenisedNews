# Product guide

## Overview

eigenisedNews is built around one core user experience: take a single news article URL and research it from both sides without letting each perspective cherry-pick a different source.

The product fetches the article once, prepares one shared article context, asks a main agent to create a pro prompt and a contra prompt, then runs two perspective analyses over the same prepared input. The result is meant to be reader-first: a concise framing of the article plus arguments for and against its framing, with prompts and diagnostics preserved for inspection.

The repository also includes a second, more operator-oriented workflow: multi-model synthesis with a signed manifest. That path is still part of the product, but it is not the default experience.

## Primary workflow: article research

### What the user does

1. Open the app at `GET /`.
2. Paste a single HTTP or HTTPS news article URL.
3. Click **Research both sides**.

### What the product returns

The `/research` response includes:

- the canonical article metadata (`url`, `contentSha256`, `byteLength`, optional `fetchedAt`, optional `error`)
- the generated `proPrompt`
- the generated `contraPrompt`
- `proAnalysis`
- `contraAnalysis`
- `mainSummary`
- `promptBindings` for the main, pro, and contra agents, including each visible system prompt, system-prompt hash, exact full-prompt hash, article URL/content hash, and generated research prompt when applicable
- `verifiableBuild` metadata (`appId`, `agentAddress`, `imageDigest`, `commitSha`, environment, EigenCloud dashboard URL, and prompt source path/URL)
- `agentRuns`

Error responses use a stable shape: `error` code, human-readable `message`, `requestId`, `retryable`, and article metadata when a fetch failed after the source was identified.

### Why this mode exists

Most article-analysis tools either summarize one article or compare multiple sources. This product is different: it creates adversarial-but-shared context. Both sides work from the same fetched article, so the disagreement is about interpretation, emphasis, and missing context, not about switching source material midstream.

## How article research behaves

### One source of truth per request

The `/research` pipeline fetches one article URL once and then reuses that same prepared context for the planner, pro, and contra stages.

Article access is resilient to publisher-blocking failures: when `FIRECRAWL_API_KEY` is configured, the fetcher tries Firecrawl `/v2/scrape` first for clean article markdown, then falls back to bounded direct HTTP if Firecrawl is unavailable or returns no usable content. Without a Firecrawl key, the pipeline uses direct HTTP only.

### Reader-first preprocessing

Before the model prompts are built, the article content is normalized into research context:

- HTML is converted into reader-friendly text when possible.
- noisy markup like scripts/styles is excluded from the prompt path.
- whitespace and entities are normalized.
- the final context is truncated to the configured research context limit.

This keeps the research prompt grounded in what a reader would recognize as the article, not in raw page chrome.

### Three-stage orchestration

The product uses a planner-first sequence:

1. **Main/planner stage** generates a pair of prompts.
2. **Pro stage** supports the article’s framing using the shared context.
3. **Contra stage** challenges or complicates that framing using the same context.

The returned `mainSummary` is then composed from the two perspective outputs.

### Prompt provenance and build binding

The research response is meant to make the different perspectives inspectable, not hidden inside logs. The UI shows a **Perspective provenance** panel with:

- the system prompt for the main planner, pro agent, and contra agent
- the generated pro/contra research prompt
- the system-prompt hash and the full prompt hash recorded in `agentRuns`
- article content hash reuse across both perspectives
- EigenCompute build metadata and links to the app dashboard / prompt source when deployment metadata is available

This does not turn `/research` into the signed `/synthesize` verifier flow, but it gives reviewers a minimal bind from each visible perspective prompt to the article hash and the verifiable deployed build.

## Secondary workflow: signed synthesis console

The synthesis console is still available through **Open synthesis console** in the UI.

### What it is for

This mode is aimed more at operators, auditors, and verifier-oriented workflows than everyday article reading. Instead of one article URL, it accepts:

- a topic
- zero or more URLs
- zero or more pasted source texts

It then runs the fixed model set, merges structured claims deterministically, and returns a signed manifest.

### What makes it different from article research

| Capability | `/research` | `/synthesize` |
|---|---|---|
| Primary audience | readers / analysts | operators / auditors |
| Default UI mode | yes | no |
| Input shape | one article URL | topic + URLs and/or pasted text |
| Output shape | pro/con analyses | manifest + signature + optional raw outputs |
| Verifier path | prompt/build provenance only | yes |

## UI surfaces

### Research-first UI

The default browser surface is the article research interface. It is the product’s main landing experience and is optimized to show a research docket, article binding, and the two bullet/paragraph-formatted perspectives before deeper diagnostics.

### Operator console

The synthesis console is still part of the application, but it is presented as a secondary workflow behind the **Open synthesis console** action. It exposes manifest details, claims, signature data, and optional raw model output.

## Current constraints users should understand

- Article research only accepts a single article URL per request.
- The research path is not the same as the signed multi-model synthesis path.
- The synthesis path omits raw model output by default; request `?include=raw` when strict verification matters.
- The synthesis path can return a signed partial response with HTTP 503 when the minimum model-success threshold is not met.
- The browser UI can run same-origin or against a configured remote backend via `FRONTEND_API_BASE_URL`.

## Where to go next

- [Architecture guide](architecture.md)
- [EigenCloud / EigenCompute guide](eigencloud.md)
- [Verifier runbook](verifier.md)
