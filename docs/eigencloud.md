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

## Repo-specific EigenCompute contract

The deployment shape in this repo is declared in `eigencompute.yaml`:

- `POST /research`
- `POST /synthesize`
- `GET /healthz`

and an app wallet binding:

- `privateKey -> AGENT_PRIVATE_KEY`
- `address -> AGENT_ID`

Even though `GET /` is served by the application and used by smoke tests, it is not listed as a named EigenCompute endpoint in `eigencompute.yaml`.

## Environment naming

For EigenCompute environment selection, this repo follows the current live environment name:

- `mainnet-alpha`

Use `mainnet-alpha` when following the repo’s live inference path.

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
- rewrites `/research`, `/synthesize`, and `/healthz` to a fixed remote backend IP

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
