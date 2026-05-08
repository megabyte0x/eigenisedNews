# Architecture guide

## System overview

eigenisedNews is a single Express application that serves:

- a browser UI at `GET /`
- a health endpoint at `GET /healthz`
- the primary article-research API at `POST /research`
- the secondary signed-synthesis API at `POST /synthesize`

The app can run locally with a direct private key or inside EigenCompute with platform-injected deployment metadata and mnemonic-backed signing.

## Runtime entrypoints

### Server composition

`src/index.ts` is the runtime entrypoint. It:

- loads repo-local `.env` values without overriding existing process env
- derives deployment metadata from environment variables and hostname
- creates the runtime signer from either `AGENT_PRIVATE_KEY` or `MNEMONIC`
- mounts the HTTP routes
- serves static assets if `dist/public` or `public` exists

### Frontend boot

`src/frontend/main.tsx` boots `NewsResearchApp`, which makes article research the default UI path. The synthesis console still exists, but only as a secondary mode reached from the research surface.

## Shared runtime dependencies

Both `/research` and `/synthesize` use the same dependency bundle shape:

- `fetchUrl`
- `callModel`
- `now`
- `deployment`
- `sign`

That common shape means both flows share the same fetcher, model gateway integration, and deployment context, but they use them in very different orchestration patterns.

## Route behavior

## `GET /`

Returns the frontend HTML shell with an injected runtime-config JSON payload. When `FRONTEND_API_BASE_URL` is set, the frontend can direct browser requests to a remote backend; otherwise it falls back to same-origin API calls.

## `GET /healthz`

Returns `{ ok: true }`.

## `POST /research`

Accepts one body shape:

```json
{ "articleUrl": "https://example.com/news/story" }
```

Failure modes:

- `400` for invalid or missing URL input
- `502` for most fetch/model-stage failures
- `504` for timeout-shaped fetch failures

Failure responses are structured as `{ error, message, requestId, retryable }` plus article metadata when a fetch failure has an identified source.

Success returns article metadata, prompts, perspective analyses, summary, prompt/build provenance, and agent-run diagnostics. `promptBindings` exposes the visible main/pro/contra system prompts plus system/full prompt hashes; `verifiableBuild` exposes deployment metadata and prompt source links.

## `POST /synthesize`

Accepts a topic plus URL and/or text inputs.

Failure modes:

- `400` for validation failures
- `503` with a signed partial response when the minimum success threshold is not met

The optional `?include=raw` query parameter determines whether raw model outputs are included in the JSON response.

## CORS behavior

CORS is intentionally narrow. When `CORS_ALLOW_ORIGINS` is configured, the server only sets CORS headers for allowed origins and only handles preflight for `/research` and `/synthesize`.

## Primary pipeline: `/research`

The article research path lives in `runArticleResearch` inside `src/pipeline.ts`.

### Flow

1. Validate the article URL.
2. Fetch the article once:
   - Firecrawl `/v2/scrape` markdown first when `FIRECRAWL_API_KEY` is configured
   - bounded direct HTTP fallback if Firecrawl is unavailable or returns no usable content
   - direct HTTP only when Firecrawl is not configured
3. Record hashed article metadata.
4. Prepare article context:
   - convert HTML to text when applicable
   - normalize whitespace/entities
   - truncate to `POLICY.RESEARCH_ARTICLE_CONTEXT_MAX_CHARS`
5. Run the planner stage.
6. Parse the planner output into `proPrompt` and `contraPrompt`.
7. Run the pro stage.
8. Run the contra stage.
9. Bind each stage to prompt provenance (`systemPromptSha256`, exact `promptHash`, article hash, generated research prompt).
10. Attach deployment metadata (`appId`, `imageDigest`, `commitSha`, dashboard/source URLs).
11. Compose the returned summary and diagnostics.

### Important constraint

This pipeline uses `POLICY.MODEL_SET[0]` for the planner, pro, and contra stages. It is not a three-model fan-out path.

## Secondary pipeline: `/synthesize`

The synthesis path lives in `runSynthesis` inside `src/pipeline.ts`.

### Flow

1. Validate topic and input count.
2. Ingest inputs:
   - fetch and hash URL inputs
   - hash pasted text inputs locally
3. Build one structured prompt per configured model.
4. Call the models.
5. Parse structured claims from each successful model output.
6. Compute the model-success threshold.
7. If threshold is met, merge claims deterministically into consensus and minority sets.
8. Build the manifest.
9. Hash the manifest.
10. Sign the manifest hash.

### Why fan-out is sequential

The synthesis fan-out is intentionally serialized. The current gateway/attestation path can race under parallel model calls, so the implementation keeps calls sequential on purpose. Treat this as an invariant unless the underlying gateway behavior is re-verified.

## Deterministic merge and manifest

The synthesis architecture is built around replayability.

### Consensus

`src/merger/consensus.ts` turns per-model structured claims into:

- consensus claims
- minority claims

using a deterministic threshold derived from the count of successful models.

### Manifest

`src/manifest/build.ts` assembles a content-addressed manifest containing:

- deployment metadata
- request hash
- input records and hashes
- per-model prompt hashes and statuses
- merge results
- brief and brief hash
- timestamp

The result is then signed by the runtime signer.

## Verification architecture

The verifier is specific to `/synthesize` responses.

### What it checks

`src/verifier/verify.ts` supports checking:

- response schema
- manifest hash correctness
- signature recovery
- raw output integrity
- deterministic merge replay
- input drift by refetching URLs
- deployment provenance evidence

### Strict mode

Strict mode fails on skipped checks, not only corrupted ones. In practice, that means strict verification depends on raw outputs and provenance-capable evidence being present.

It also means local manifests and text-only synthesis requests cannot fully strict-pass on their own, because some verifier checks remain unrunnable and therefore count as failures under strict mode.

### CLI surface

`scripts/verify-manifest.ts` is the standalone CLI wrapper around the verifier.

For exact operator usage, see the [verifier runbook](verifier.md).

## Model gateway integration

Model calls go through Eigen’s provider path rather than ad hoc raw HTTP. The configured policy lives in `src/lib/policy.ts`, and the gateway/provider notes live in [LLM proxy notes](llm-proxy-notes.md).

Important policy facts:

- fixed model set of three provider/model pairs
- `MIN_SUCCESS_COUNT = 2`
- bounded topic length and input count
- bounded fetch and article-research context sizes

## Deployment topologies

### Full app on EigenCompute

`eigencompute.yaml` defines the named endpoints and wallet binding for EigenCompute deployment. This is the deployment shape that matches the full signed-manifest story.

### Frontend-only deployment on Vercel

`vercel.json` builds only the frontend output and rewrites browser requests to a fixed remote backend for `/research`, `/synthesize`, and `/healthz`.

That means the repo supports a split topology:

- frontend served from Vercel
- backend served elsewhere

## Known architecture quirks

- `dist/public` is preferred over `public` for static assets.
- The server shell and the frontend-build shell are separate sources of copy and can drift if edited independently.
- The Node runtime story is inconsistent across files: `package.json` declares `24.x`, while CI, Docker, and the bundle target use Node 25.
- Local `.env` loading is additive only; existing process env values win.

## Related docs

- [Product guide](product.md)
- [EigenCloud / EigenCompute guide](eigencloud.md)
- [Verifier runbook](verifier.md)
- [LLM proxy notes](llm-proxy-notes.md)
