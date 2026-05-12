# EigenCloud / EigenCompute guide

## Overview

This repo is designed to run on EigenCompute and to use EigenCloud-compatible model gateway routing for inference.

In practical terms, EigenCompute provides the TEE runtime and app-wallet machinery, while the model-calling path relies on Eigen’s provider/gateway flow rather than hard-coded direct provider integrations.

## What EigenCompute provides to this app

### TEE runtime

The application is intended to run inside an EigenCompute Intel TDX TEE. In repo terms, the important assumption is that runtime signing, deployment metadata, and gateway integration are designed around an attested EigenCompute environment rather than a plain Node process.

### Runtime wallet behavior

This repo supports two signer paths:

- **local development:** use `AGENT_PRIVATE_KEY`
- **EigenCompute runtime:** derive signing from the platform-injected `MNEMONIC`

Inside EigenCompute, the runtime mnemonic is injected by KMS and is meant to be consumed by the workload at runtime rather than managed like an ordinary local `.env` secret.

### Deployment metadata

The runtime also reads deployment-facing metadata from environment variables such as:

- `EIGEN_APP_ID`
- `EIGEN_IMAGE_DIGEST`
- `EIGEN_COMMIT_SHA`
- `EIGEN_ENVIRONMENT`
- `AGENT_ID`

Those values feed the signed manifest deployment section for `/synthesize` responses.

To avoid user-facing “unknown” build labels, set `EIGEN_COMMIT_SHA` and `EIGEN_IMAGE_DIGEST` during deployment whenever the platform does not inject them. The runtime also accepts common build-system aliases for commit/image metadata (`ECLOUD_COMMIT_SHA`, `GIT_COMMIT_SHA`, `SOURCE_COMMIT`, `COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, `ECLOUD_IMAGE_DIGEST`, `IMAGE_DIGEST`, `CONTAINER_IMAGE_DIGEST`, and `DOCKER_IMAGE_DIGEST`) before falling back to `unknown`.

### Persistent research storage

EigenCompute persistent storage is exposed to workloads at `USER_PERSISTENT_DATA_PATH` and currently resolves to `/mnt/disks/userdata` per the EigenCompute persistent storage guide. The app writes saved article reports under:

```text
$USER_PERSISTENT_DATA_PATH/eigenised-news/research-reports
```

If `USER_PERSISTENT_DATA_PATH` is absent but `EIGEN_ENVIRONMENT` is `sepolia` or `mainnet-alpha`, the app falls back to `/mnt/disks/userdata/eigenised-news/research-reports`. Local development uses `.data/eigenised-news/research-reports`, and tests/operators may override with `RESEARCH_STORAGE_DIR`.

The stored reports back:

- duplicate URL reuse before the fetch/model pipeline runs
- `GET /research/history` for the previous-article index
- `GET /research/history/:id?include=raw` for loading a full saved report into the UI
- successful `POST /research/jobs` queue results when the queue finishes a job

The queue itself can also persist job state separately when `RESEARCH_QUEUE_STORE_PATH` points at a JSON file on the persistent storage mount, for example `/mnt/disks/userdata/eigenised-news/research-queue.json`.

See the EigenCompute persistent storage docs: <https://docs.eigencloud.xyz/eigencompute/howto/build/persistent_storage>.

## Repo-specific EigenCompute contract

The deployment shape in this repo is declared in `eigencompute.yaml`:

- `POST /api/research`
- `POST /research`
- `POST /research/jobs`
- `GET /research/jobs`
- `GET /research/jobs/:jobId`
- `GET /research/history`
- `GET /research/history/:id`
- `POST /synthesize`
- `GET /openapi.json`
- `GET /.well-known/x402`
- `GET /verify`
- `GET /skill.md`
- `GET /healthz`

and an app wallet binding:

- `privateKey -> AGENT_PRIVATE_KEY`
- `address -> AGENT_ID`

Even though `GET /` is served by the application and used by smoke tests, it is not listed as a named EigenCompute endpoint in `eigencompute.yaml`.

## Environment naming

For EigenCompute environment selection, this repo follows the current live environment name:

- `sepolia`
- `mainnet-alpha`

Use `sepolia` for payment-route and deployment rehearsals, then `mainnet-alpha` when following the repo’s live inference path.

## Paid research API environment

`POST /api/research` is the paid agent-facing variant of the article research route. It uses `dual402` and accepts either:

- x402 on Base USDC
- MPP on Tempo USDC

Set `PAID_RESEARCH_ENABLED=true` in deployed environments so the app fails closed if payment config is missing. The payment env surface is:

```bash
PAID_RESEARCH_ENABLED=true
PAID_RESEARCH_PRICE_USDC=0.05
RECIPIENT_WALLET=0x...
MPP_SECRET_KEY=<32-byte-random-hex>
USDC_TEMPO=0x20C000000000000000000000b9537d11c60E8b50
MPP_TESTNET=false
X402_NETWORK=eip155:8453
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=<cdp-key-id>
CDP_API_KEY_SECRET=<cdp-key-secret>
BASE_URL=https://<public-api-origin>
SERVICE_NAME=eigenisedNews-paid-research
SERVICE_VERSION=0.1.0
```

For sepolia/test rails, use:

```bash
USDC_TEMPO=0x20c0000000000000000000000000000000000000
MPP_TESTNET=true
X402_NETWORK=eip155:84532
X402_FACILITATOR_URL=https://x402.org/facilitator
```

The support endpoints for agents are:

- `GET /openapi.json`
- `GET /.well-known/x402`
- `GET /verify`
- `GET /skill.md`

## Model gateway usage

### How this repo calls models

This codebase does not build raw provider-specific HTTP requests as its primary integration strategy. It uses the Eigen gateway/provider path documented in `docs/llm-proxy-notes.md`.

The important repo-level implications are:

- the model set is fixed in `src/lib/policy.ts`
- provider/model names are treated as policy, not ad hoc request values
- gateway routing is configurable by environment

### Gateway environment variables

This repo prefers:

- `EIGEN_GATEWAY_URL`

and still tolerates the older fallback alias:

- `EIGEN_GATEWAY_BASE_URL`

Public EigenCloud examples also document environment-driven gateway routing. In this repo, the canonical override name is `EIGEN_GATEWAY_URL`.

### Current live-inference guidance

The repo’s live path uses:

```bash
ecloud compute env set mainnet-alpha
```

and points gateway traffic at:

```bash
EIGEN_GATEWAY_URL=https://ai-gateway.eigencloud.xyz
```

Treat the hostname as repo-configured operational guidance. The stronger public guarantee is that EigenCloud examples document env-driven gateway configuration, not that every repo must hard-code the same host literal forever.

## Local vs deployed behavior

### Local development

Local development typically uses:

- `.env` for local values
- `AGENT_PRIVATE_KEY` for signing
- optional `FRONTEND_API_BASE_URL` to point the browser UI at a deployed backend

`src/lib/env.ts` only fills missing values from the repo-local `.env` file. Existing process env values always win.

### Deployed EigenCompute runtime

Inside EigenCompute, the app can use:

- `MNEMONIC` for runtime signing
- deployment metadata env vars for manifest identity
- platform-provided gateway/auth context for inference

### Frontend against remote backend

If you run the local UI against a deployed backend with `FRONTEND_API_BASE_URL`, that backend must allow the local browser origins via `CORS_ALLOW_ORIGINS`.

## Vercel frontend-only deployment

This repo also includes a Vercel deployment shape in `vercel.json`.

That config:

- builds only `dist/public`
- rewrites `/research` plus nested `/research/*` endpoints, `/api/research`, `/synthesize`, discovery routes, `/verify`, `/skill.md`, and `/healthz` to a fixed remote backend IP

This is not a full EigenCompute deployment. It is a frontend-only publishing path that depends on an already-running backend.

## Live smoke flow

Once a deployment is reachable, the repo’s live smoke command is:

```bash
APP_URL=http://<public-ip>:3000 npm run e2e:live
```

That smoke path checks:

- `GET /healthz`
- `GET /`
- `POST /synthesize?include=raw`
- signed output with `thresholdMet=true`

The saved smoke response can then feed the verifier.

## Operational cautions

### Node-version drift

There is a real mismatch in this repo today:

- `package.json` declares Node `24.x`
- CI uses Node 25
- Docker uses Node 25
- the server bundle targets Node 25

When documenting or validating deployment behavior, trust the actual runtime/build path over the stale engines declaration.

### Strict verifier expectations

Strict verifier mode fails on skipped checks. That means you need raw outputs and provenance-capable evidence, not just a syntactically valid synthesis response.

Local manifests and text-only synthesis requests are therefore not enough for a complete strict pass by themselves, because some verifier checks remain unrunnable.

### Troubleshooting history vs canonical docs

`docs/eigencloud-llm-gateway-issue.md` is useful historical/troubleshooting context, but it should not be treated as the canonical product/deployment guide.

## Related docs

- [Product guide](product.md)
- [Architecture guide](architecture.md)
- [Verifier runbook](verifier.md)
- [LLM proxy notes](llm-proxy-notes.md)
