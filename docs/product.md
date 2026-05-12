# Product guide

## Overview

eigenisedNews is built around one core user experience: take a single news article URL and research it from both sides without letting each perspective cherry-pick a different source.

The product fetches the article once, prepares one shared article context, asks a main agent to create a pro prompt and a contra prompt, then runs two perspective analyses over the same prepared input. The result is reader-first: a concise framing of the article plus arguments for and against its framing, with prompts and diagnostics preserved for inspection.

The repository also exposes the same article-research workflow as a paid agent API at `POST /api/research`. That route is for autonomous clients that discover the service, pay with x402 or MPP, and receive the signed research response directly. A separate operator-oriented workflow — multi-model synthesis with a signed manifest — remains available, but it is not the default experience.

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
- `promptBindings` for the main planner, pro, contra, and main-summary stages, including each visible system prompt, system-prompt hash, exact full-prompt hash, article URL/content hash, and generated research prompt when applicable
- `verifiableBuild` metadata (`appId`, `agentAddress`, `imageDigest`, `commitSha`, environment, EigenCloud dashboard URL, and prompt source path/URL)
- `agentRuns`
- a signed `manifest`, `signature`, and `raw` audit payload when requested with `?include=raw`

Error responses use a stable shape: `error` code, human-readable `message`, `requestId`, `retryable`, and article metadata when a fetch failed after the source was identified.

### Why this mode exists

Most article-analysis tools either summarize one article or compare multiple sources. This product is different: it creates adversarial-but-shared context. Both sides work from the same fetched article, so the disagreement is about interpretation, emphasis, and missing context, not about switching source material midstream.

## How article research behaves

### One source of truth per request

The `/research` pipeline fetches one article URL once and then reuses that same prepared context for the planner, pro, contra, and main-summary stages.

Article access is resilient to publisher-blocking failures: when `FIRECRAWL_API_KEY` is configured, the fetcher tries Firecrawl `/v2/scrape` first for clean article markdown, then falls back to bounded direct HTTP if Firecrawl is unavailable or returns no usable content. Without a Firecrawl key, the pipeline uses direct HTTP only.

### Reader-first preprocessing

Before the model prompts are built, the article content is normalized into research context:

- HTML is converted into reader-friendly text when possible.
- noisy markup like scripts/styles is excluded from the prompt path.
- whitespace and entities are normalized.
- the final context is truncated to the configured research context limit.

This keeps the research prompt grounded in what a reader would recognize as the article, not in raw page chrome.

### Four-stage orchestration

The product uses a planner-first sequence:

1. **Main/planner stage** generates a pair of prompts.
2. **Pro stage** supports the article’s framing using the shared context.
3. **Contra stage** challenges or complicates that framing using the same context.
4. **Main-summary stage** reads the pro and contra outputs, explicitly considers their final verdicts, and produces a quick reader-facing comparison of similarities, divergences, and the bottom line.

The returned `mainSummary` is the main agent’s comparison summary, not a deterministic concatenation of the two perspective outputs.

### Signed provenance and build binding

The research response makes the different perspectives inspectable instead of hiding them in logs. Each successful response includes a signed research manifest that binds:

- the system prompt for the main planner, pro agent, contra agent, and main-summary stage
- the generated pro/contra research prompt
- the system-prompt hash and the full prompt hash recorded in `agentRuns`
- article content hash reuse across both perspectives
- output hashes for pro analysis, contra analysis, and the main-agent summary
- EigenCompute build metadata and links to the app dashboard / prompt source when deployment metadata is available

The UI shows this in the **Perspective provenance** panel and exposes browser verification for verifier workflows.

The **Verification guide** card explains the proof in product language: verification does not decide which opinion is correct; it proves the article binding, prompt binding, raw agent inputs/outputs when included, manifest signature, and EigenCompute build provenance. Readers can click **Verify this result** to run the checks through `POST /verify` in the browser without downloading a JSON file or running a terminal command. The “Verify build” dashboard link is styled as a primary proof action, while missing commit/image metadata is called out as “not provided” instead of a misleading `unknown` label.

The **Previous researched articles** library lists saved reports from the server-side persistent store. Clicking an entry loads that signed report directly into the reader, and duplicate submitted links reuse the stored report rather than creating another agent run.

The queue API (`POST /research/jobs`) accepts one or more article URLs for batch processing. It runs jobs sequentially by default, exposes job status/result endpoints, and writes successful queued reports into the same persistent history.

## Paid agent workflow

Agents call `POST /api/research` with the same JSON body as `/research`:

```json
{ "articleUrl": "https://example.com/news/story" }
```

Unpaid requests return `402 Payment Required` with both x402 and MPP challenges. After payment, clients retry the same request and receive the normal signed research response. Agents can inspect `GET /openapi.json`, `GET /.well-known/x402`, `GET /verify`, and `GET /skill.md` before paying. `GET /verify` includes a public explanation of the research verifier checks, persistent history endpoints, and whether commit/image build metadata is present.

## Secondary workflow: signed synthesis console

The synthesis console is available through **Open synthesis console** in the UI.

### What it is for

The synthesis mode is aimed more at operators, auditors, and verifier-oriented workflows than everyday article reading. Instead of one article URL, it accepts:

- a topic
- zero or more URLs
- zero or more pasted source texts

It then runs the fixed model set, merges structured claims deterministically, and returns a signed manifest.

### What makes it different from article research

| Capability | `/research` | `/api/research` | `/synthesize` |
|---|---|---|---|
| Primary audience | readers / analysts | autonomous paid agents | operators / auditors |
| Default UI mode | yes | no | no |
| Payment required | no | yes, x402 or MPP | no |
| Input shape | one article URL | one article URL | topic + URLs and/or pasted text |
| Output shape | pro/con analyses + signed research manifest | same as `/research` after payment | manifest + signature + optional raw outputs |
| Verifier path | prompt/build provenance | prompt/build provenance; use `?include=raw` for audit evidence | yes |

## UI surfaces

### Research-first UI

The default browser surface is the article research interface. It is the product’s main landing experience and is optimized to show a research docket, article binding, and the two bullet/paragraph-formatted perspectives before deeper diagnostics.

### Operator console

The synthesis console is a secondary workflow behind the **Open synthesis console** action. It exposes manifest details, claims, signature data, and optional raw model output.

## Current constraints users should understand

- Article research only accepts a single article URL per request.
- Paid agent research is disabled unless payment environment variables are complete, or fails closed when `PAID_RESEARCH_ENABLED=true`.
- The research path is not the same as the signed multi-model synthesis path.
- The synthesis path omits raw model output by default; request `?include=raw` when strict verification matters.
- The synthesis path can return a signed partial response with HTTP 503 when the minimum model-success threshold is not met.
- The browser UI can run same-origin or against a configured remote backend via `FRONTEND_API_BASE_URL`.

## Where to go next

- [Architecture guide](architecture.md)
- [EigenCloud / EigenCompute guide](eigencloud.md)
- [Verifier runbook](verifier.md)
