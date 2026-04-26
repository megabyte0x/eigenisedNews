# eigenisedNews

Multi-model news synthesis with a verifiable methodology, deployed inside a TEE on EigenCompute.

## What it is

A single-endpoint HTTP service that accepts a topic plus a set of sources (URLs and/or raw text), fans the request out to a fixed set of LLMs through the EigenCloud LLM Proxy, and merges their structured outputs deterministically — no LLM judge — into a consensus brief plus minority perspectives. The agent returns a content-addressed manifest of every input, model call, and merge step, signed by the TEE-derived EVM wallet. Operators cannot silently change the model set, prompts, merge logic, or retry policy without producing a new image digest, recorded on-chain via the EigenCompute verifiable build pipeline.

## Quick start (local)

```bash
npm install
cp .env.example .env   # fill in LLM_PROXY_URL and LLM_PROXY_API_KEY
npm run dev
curl http://localhost:3000/healthz
```

## Trust model

The trust pivot is the deterministic merger: claims supported by `⌈N/2⌉` or more successful models become consensus claims, the rest become minority claims, and the algorithm itself is code in a verifiable image. Combined with the LLM Proxy (model versions are recorded), the source fetcher (raw bytes are hashed), and a TEE-derived signing key (deterministic per `appId`, persists across upgrades), every byte that influenced the synthesis is mechanically verifiable by an auditor running `scripts/verify-manifest.ts` against a saved response.

For the full design rationale and locked decisions, see `docs/design.md` (which points to the canonical doc at `../docs/plans/2026-04-27-eigenised-news-design.md`).

## Manifest verification

```bash
tsx scripts/verify-manifest.ts <path-to-saved-response.json>
```

The verifier runs four independent checks:

1. **Provenance** — `imageDigest` and `commitSha` on the EigenCompute verify dashboard.
2. **Signature** — recover signer over `manifestSha256` and compare to `agentAddress`.
3. **Inputs** — refetch URLs and compare `contentSha256`.
4. **Merge** — re-run the deterministic merger against the per-model claims.

## Deploy

See `docs/deploy.md`.

## Out of scope (deferred)

- On-chain commit of `manifestSha256`
- Scheduled / cron synthesis
- Frontend / reader UI
- Persistent storage / history
- Streaming responses
- EIP-712 typed-data signatures
- Request authentication / rate limiting
