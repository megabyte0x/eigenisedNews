# eigenisedNews

eigenisedNews is a research product for interrogating a single news article from both sides.

Its primary workflow accepts one article URL, fetches that article once, prepares a shared article context, asks a main agent to create two research prompts, then returns a pro analysis and a contra analysis over the same source material. The repo also keeps a secondary operator workflow: a signed multi-model synthesis console that produces a verifiable manifest over a fixed model set.

## What the product does

- **Primary mode: article research.** Submit one news article URL and get two evidence-backed perspectives on the same article: one supporting the framing and one challenging it.
- **Secondary mode: signed synthesis.** Submit a topic plus URLs and/or pasted source text, fan the request out to the fixed model set, and receive a signed consensus manifest.
- **Verifier support.** Saved `/synthesize` responses can be replayed and checked offline, with optional URL refetch and EigenCompute provenance evidence.

Read the deeper docs here:

- [Product guide](docs/product.md)
- [Architecture guide](docs/architecture.md)
- [EigenCloud / EigenCompute guide](docs/eigencloud.md)
- [Verifier runbook](docs/verifier.md)
- [LLM proxy notes](docs/llm-proxy-notes.md)

## Product surfaces

### 1. Article research (`POST /research`)

This is the default UI and the main product story.

```bash
curl http://localhost:3000/research \
  -H 'content-type: application/json' \
  -d '{"articleUrl":"https://example.com/news/story"}'
```

The response includes article metadata, the pro/contra prompts derived from the article, both analyses, clean request/error metadata, and agent run diagnostics. It also returns `promptBindings` (the visible system prompt for each main/pro/contra agent, system-prompt hash, and full prompt hash) plus `verifiableBuild` metadata (`appId`, `imageDigest`, `commitSha`, dashboard URL, and prompt source path) so a reviewer can connect each perspective to the deployed EigenCompute build.

When `FIRECRAWL_API_KEY` is configured, article fetching uses Firecrawl `/v2/scrape` first for clean markdown content. If Firecrawl is unavailable or returns no usable content, the fetcher falls back to the existing bounded direct HTTP request. Without `FIRECRAWL_API_KEY`, direct HTTP remains the only fetch path.

### 2. Signed synthesis (`POST /synthesize`)

This is the secondary operator-facing flow. It accepts a topic plus URLs and/or pasted source text, runs the fixed model set, merges claims deterministically, and signs the resulting manifest.

Raw model outputs are omitted by default. Request `?include=raw` when you want strict verifier replay to pass.

## Quick start (local)

Use Node 25 for local, CI, and container parity.

```bash
npm install
cp .env.example .env
# then replace AGENT_PRIVATE_KEY in .env with a real 32-byte hex key
npm run dev
curl http://localhost:3000/healthz
```

For local signing, set `AGENT_PRIVATE_KEY` in `.env`. In EigenCompute, the app can derive its runtime signer from the platform-injected `MNEMONIC` instead.

To enable Firecrawl as the primary article-access fetcher, set `FIRECRAWL_API_KEY` in `.env` or the deployment environment. `FIRECRAWL_API_URL` is optional and defaults to the hosted Firecrawl API.

## Frontend to remote backend

To run the local frontend against a deployed backend:

```bash
FRONTEND_API_BASE_URL=http://<backend-host>:3000 npm run dev
```

When `FRONTEND_API_BASE_URL` is unset, the UI uses same-origin `/research` and `/synthesize` requests. If you point the local UI at a remote backend, that backend must allow the browser origins via `CORS_ALLOW_ORIGINS`.

## Trust and verification summary

The `/synthesize` path is built for replayable verification. The app records request and input hashes, per-model prompt hashes and outcomes, deterministic merge results, deployment metadata, and a signature over the manifest hash. The standalone verifier can then check integrity, signature recovery, raw output consistency, merge replay, refetch drift, and optional EigenCompute provenance.

The `/research` path is intentionally lighter-weight than `/synthesize`, but its response now exposes prompt provenance: main/pro/contra system prompts, hashes for the exact full prompts that ran, article content hash, and verifiable-build metadata linking the prompt source to the deployed image/commit.

Use the verifier directly:

```bash
npx tsx scripts/verify-manifest.ts response.json
```

Use strict verification when you also have raw outputs and provenance-capable evidence:

```bash
npx tsx scripts/verify-manifest.ts response.json --refetch --ecloud --strict
```

Strict mode fails on skipped checks as well as corrupted ones. In practice, local manifests and text-only synthesis requests are not enough for a full strict pass unless every required online/provenance check is also runnable.

See the [verifier runbook](docs/verifier.md) for the exact checks and failure modes.

## Deploy on EigenCompute

This repo ships an `eigencompute.yaml` for EigenCompute deployment and uses EigenCloud-compatible gateway routing for model calls. The short version is:

```bash
npm i -g @layr-labs/ecloud-cli@0.5.0
ecloud compute env set mainnet-alpha
```

For the platform details, app wallet behavior, gateway usage, and live smoke flow, see the [EigenCloud / EigenCompute guide](docs/eigencloud.md).

## Live smoke against a deployed app

```bash
APP_URL=http://<public-ip>:3000 npm run e2e:live
```

The smoke check verifies:

- `GET /healthz`
- `GET /` frontend shell
- `POST /synthesize?include=raw`
- signed manifest output with `thresholdMet=true`

## Current scope

What already exists:

- article-research-first browser UI
- signed synthesis operator console
- standalone verifier CLI
- EigenCompute deployment config

What is still out of scope:

- on-chain commit of `manifestSha256`
- scheduled / cron synthesis
- persistent storage / history
- streaming responses
- EIP-712 typed-data signatures
- request authentication / rate limiting
