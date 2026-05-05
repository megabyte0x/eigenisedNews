# Manifest Verifier

`scripts/verify-manifest.ts` independently checks a saved `/synthesize` response. Save responses with `?include=raw` when you want deterministic merge replay to be fully verifiable.

## Modes

Offline mode allows checks that need live network or platform access to skip:

```bash
npx tsx scripts/verify-manifest.ts response.json
```

Strict mode fails on any skipped or failed check:

```bash
npx tsx scripts/verify-manifest.ts response.json --strict
```

Strict mode is intended for audit packages that include raw model outputs and provenance evidence, or for environments with `ecloud` authentication configured.

## Checks

| Check | Offline? | What it proves |
|---|---:|---|
| `schema` | Yes | The response has the expected top-level manifest/signature/raw shape. Malformed input returns a verifier failure instead of throwing. |
| `manifest_hash` | Yes | Recomputes the manifest hash with `manifestSha256: "sha256:"` as the placeholder and compares it to the claimed hash. |
| `signature` | Yes | Recovers the EVM signer over `manifestSha256` and compares it to `manifest.deployment.agentAddress`. |
| `raw_outputs` | Yes, if `raw` is present | Verifies one raw output per successful model, no unexpected outputs, raw hashes match `ModelRun.rawOutputSha256`, and parsed claim counts match the manifest. |
| `inputs` | Optional online | With `--refetch`, refetches URL inputs and compares current `contentSha256` to the manifest. Text inputs do not need refetching. |
| `merge` | Yes, if `raw` is present and valid | Re-runs the deterministic merger over verified raw model outputs and compares consensus/minority claims. |
| `provenance` | Optional online/offline evidence | Confirms EigenCompute evidence contains the manifest app id, image digest, commit SHA, and agent address when available. |

## Raw outputs and strict merge replay

The `/synthesize` endpoint omits raw model output by default. That keeps normal responses smaller, but the verifier cannot replay the deterministic merge without raw outputs. To make `raw_outputs` and `merge` pass in strict mode, save the response with:

```bash
curl 'http://<host>:3000/synthesize?include=raw' \
  -H 'content-type: application/json' \
  -d @request.json > response.json
```

If `raw` is `null`, offline mode reports skipped raw/merge checks and can still exit 0 as long as no check fails. `--strict` exits 1 on those skips.

## EigenCompute provenance

The verifier does not scrape verify dashboard HTML. The installed `ecloud` runbook documents the supported JSON provenance surfaces:

```bash
ecloud compute build verify <image-digest-or-build-id-or-commit> --json
ecloud compute app releases <app-id> --json --full
```

Use the online checker when `ecloud` is installed and authenticated:

```bash
npx tsx scripts/verify-manifest.ts response.json --ecloud --strict
```

The checker uses hex app IDs from the manifest. It calls `app releases` and `build verify` with `--json`, and parses `app info` text only for the EVM address because `app info` does not support `--json`.

## Saved provenance evidence

For offline review, or when `ecloud` authentication is unavailable, save relevant `ecloud` output into a JSON file and pass it to the verifier:

```bash
npx tsx scripts/verify-manifest.ts response.json \
  --provenance-json evidence.json \
  --strict
```

The evidence extractor accepts nested JSON and looks for:

- `0x...` app IDs / derived EVM addresses
- `sha256:<64 hex>` image digests
- 40-hex-character commit SHAs

Prefer explicit fields when producing evidence:

```json
{
  "appId": "0x...",
  "releases": [{ "imageDigest": "sha256:..." }],
  "buildVerify": { "commitSha": "..." },
  "appInfoText": "EVM Address: 0x..."
}
```

## Exit codes

- `0`: verification mode passed.
  - Default mode: no check failed; skipped online/raw checks are allowed.
  - Strict mode: every check passed.
- `1`: input parsing failed, at least one check failed, or strict mode saw a skipped check.
