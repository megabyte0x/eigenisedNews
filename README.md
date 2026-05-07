# eigenisedNews

Multi-model news synthesis with a verifiable methodology, deployed inside a TEE on EigenCompute.

A news research service that accepts a single news article URL as its primary flow, asks a main agent to create pro and contra research prompts, then runs two perspective agents over the same fetched article context. The response shows evidence-backed analysis for and against the article's framing. The original multi-model synthesis console is still available as a secondary operator interface: it accepts a topic plus sources, fans the request out to the fixed model set through the EigenCloud LLM Proxy, and returns a signed consensus manifest.

## Quick start (local)

Use Node 25 for local, CI, and container parity.

```bash
npm install
cp .env.example .env   # set AGENT_PRIVATE_KEY for local signing; gateway auth is automatic in EigenCompute
npm run dev
curl http://localhost:3000/healthz
```

Run the local UI against the current remote API:

```bash
FRONTEND_API_BASE_URL=http://34.30.150.229:3000 npm run dev
```

The deployed backend must set `CORS_ALLOW_ORIGINS=http://localhost:3000,http://127.0.0.1:3000` or browser requests from the local UI will be blocked.

When `FRONTEND_API_BASE_URL` is unset, the UI falls back to same-origin `/research` and `/synthesize` endpoints.

## Primary article research API

```bash
curl http://localhost:3000/research \
  -H 'content-type: application/json' \
  -d '{"articleUrl":"https://example.com/news/story"}'
```

The `/research` endpoint fetches the URL once, has the main agent generate separate pro and contra prompts, then returns both perspective-agent outputs:

```json
{
  "article": { "url": "https://example.com/news/story", "contentSha256": "sha256:...", "byteLength": 1234, "error": null },
  "proPrompt": "...",
  "contraPrompt": "...",
  "proAnalysis": "...",
  "contraAnalysis": "...",
  "mainSummary": "...",
  "agentRuns": [{ "role": "main", "provider": "anthropic", "model": "claude-sonnet-4.6", "status": "ok" }]
}
```

The synthesis/manifest flow remains available at `POST /synthesize` and in the UI through **Open synthesis console**.

## Trust model

The core trust mechanism is the deterministic merger: claims supported by `⌈N/2⌉` or more successful models become consensus claims, the rest become minority claims, and the algorithm itself is code in a verifiable image. Combined with the LLM Proxy (model versions are recorded), the source fetcher (raw bytes are hashed), and a TEE-derived signing key (deterministic per `appId`, persists across upgrades), every byte that influenced the synthesis is mechanically verifiable by an auditor running `scripts/verify-manifest.ts` against a saved response.

For the full design rationale and locked decisions, see `docs/design.md`.

## Manifest verification

Offline integrity/signature/merge check:

```bash
npx tsx scripts/verify-manifest.ts response.json
```

Full strict verification with URL refetch and EigenCompute provenance through the `ecloud` CLI:

```bash
npx tsx scripts/verify-manifest.ts response.json \
  --refetch \
  --ecloud \
  --strict
```

Use `?include=raw` when saving `/synthesize` responses if you want merge replay to pass in strict mode. Use `--provenance-json evidence.json` for offline review from saved `ecloud`/dashboard evidence. See `docs/verifier.md` for details.

## Deploy

Use `eigencompute.yaml` with the `ecloud` CLI; deployment metadata is recorded in each signed manifest.

## Live E2E with real LLMs

Eigen's guidance for working inference is to deploy on **mainnet-alpha** with the stable CLI and the production gateway override:

```bash
npm i -g @layr-labs/ecloud-cli@0.5.0
ecloud compute env set mainnet-alpha
```

In your deployment `.env`, set:

```bash
EIGEN_GATEWAY_URL=https://ai-gateway.eigencloud.xyz
```

Then deploy normally on `mainnet-alpha`. After the app is reachable, run a live smoke from your machine:

```bash
APP_URL=http://<public-ip>:3000 npm run e2e:live
```

The smoke test checks:
- `GET /healthz`
- `GET /` frontend shell
- `POST /synthesize?include=raw` with a deterministic text source
- signed manifest + `thresholdMet=true` + raw model outputs present

Optional overrides:

```bash
APP_URL=http://<public-ip>:3000 \
TOPIC="My real topic" \
SOURCE_TEXT="Paste real source text here" \
SOURCE_URL="https://example.com/source" \
SOURCE_URLS=$'https://example.com/a\nhttps://example.com/b' \
OUTPUT_PATH=/tmp/eigenised-news-response.json \
npm run e2e:live
```

## Out of scope (deferred)

- On-chain commit of `manifestSha256`
- Scheduled / cron synthesis
- Frontend / reader UI
- Persistent storage / history
- Streaming responses
- EIP-712 typed-data signatures
- Request authentication / rate limiting
