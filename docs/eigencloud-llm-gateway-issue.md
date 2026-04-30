# EigenCloud AI Gateway — JWT signature rejected for sepolia-prod TEE

**Filed by:** megabyte0x
**Date:** 2026-04-28
**App ID:** `0xc35c1d9555E5883Cb0915E02090A097478960734`
**Network:** sepolia
**Repo:** <https://github.com/megabyte0x/eigenisedNews>

---

## Problem

Every request from a sepolia-prod TEE through `@layr-labs/ai-gateway-provider` is rejected by both `ai-gateway-dev.eigencloud.xyz` and `ai-gateway.eigencloud.xyz` with the same response:

```json
{"error":{"code":401,"message":"invalid token: token signature is invalid: crypto/rsa: verification error","type":"unauthorized"}}
```

The JWT is freshly issued by `eigenx-kms` via the standard TEE attestation flow inside the container (`AttestClient` from `@layr-labs/ecloud-sdk/attest`). Decoding the JWT (header + payload, signature unverified) shows all claims look correct — the rejection is at signature verification, not claims validation. This indicates the KMS signing key and the gateway verification key are out of sync for sepolia-prod TEEs.

The container itself is healthy (`/healthz` returns `200`), the synthesis pipeline runs end to end, and signed manifests are produced — only the LLM gateway leg fails.

## Environment

| Field | Value |
|---|---|
| `ecloud-cli` | `@layr-labs/ecloud-cli/0.5.0` |
| Network | `sepolia` |
| Instance type | `g1-standard-4t` |
| TEE class | `GCP_INTEL_TDX` |
| GCE project | `tee-compute-sepolia-prod` |
| GCE zone | `europe-west4-a` |
| App ID | `0xc35c1d9555E5883Cb0915E02090A097478960734` |
| TEE EVM address | `0x329f35dab35220a4316ab94406ac386583eec1c5` (path `m/44'/60'/0'/0/0`, derived from injected `MNEMONIC`) |
| Image | `ghcr.io/megabyte0x/eigenised-news:0.2.2-dbg-layered` |
| Image SHA (in JWT) | `sha256:84a47a2a52334cc37959111d5d0fab0d280232819adb833f3cef1d0478671a7f` |
| `@layr-labs/ai-gateway-provider` | `^1.0.1` |
| `ai` (Vercel AI SDK) | `^6.0.168` |
| Node | `22.22.2` |
| `EIGEN_GATEWAY_URL` (when set) | `https://ai-gateway.eigencloud.xyz` |

## Sample JWT (payload, decoded; signature redacted)

```json
{
  "app_id": "0xc35c1d9555e5883cb0915e02090a097478960734",
  "aud": ["llm-proxy"],
  "exp": 1777322992,
  "iat": 1777319392,
  "iss": "eigenx-kms",
  "sub": "0xc35c1d9555e5883cb0915e02090a097478960734",
  "hardened": true,
  "secboot": true,
  "hwmodel": "GCP_INTEL_TDX",
  "submods": {
    "container": {
      "image_reference": "ghcr.io/megabyte0x/eigenised-news@sha256:84a47a2a…",
      "image_digest": "sha256:84a47a2a52334cc37959111d5d0fab0d280232819adb833f3cef1d0478671a7f",
      "image_id": "sha256:3f9686b3ff98a2228ec559d81e1521a14fb10ea51f9670f0b72868f1b2d60c95",
      "restart_policy": "Never",
      "args": ["/usr/local/bin/compute-source-env.sh", "node", "bundle.cjs"],
      "env": {
        "HOSTNAME": "tee-0xc35c1d9555e5883cb0915e02090a097478960734",
        "NODE_ENV": "production",
        "NODE_VERSION": "22.22.2",
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "USER_PERSISTENT_DATA_PATH": "/mnt/disks/userdata",
        "YARN_VERSION": "1.22.22"
      }
    },
    "gce": {
      "project_id": "tee-compute-sepolia-prod",
      "project_number": "889537417991",
      "zone": "europe-west4-a",
      "instance_name": "tee-0xc35c1d9555e5883cb0915e02090a097478960734",
      "instance_id": "5854377496555946857"
    }
  },
  "tdx": {
    "mrtd": "feb7486608382c1ff0e15b4648ddc0acea6ca974eb53e3529f4c4bd5ffbaa20bf335cb75965cea65fe473aed9647c162",
    "rtmr0": "c29b86f8cd870a5507c3a253e95fa731ba58f672ac603cfbbfca92fa4d4028996bfe3641b22a4eda3922130f86c078f2",
    "rtmr1": "56b64757cb493939ef5f254965734c4b77b71b663b17ecb3e8e7f39f7855dad126ec37c6d74bff15b165902c0cd4b594",
    "rtmr2": "81abba1efc1f82eaf55d2c4a51f5aea160e834be044c4709f9dbad9410b38e2dbe03a5d4988b792fbef93cddc01e3751",
    "rtmr3": "e78adea8cae7f84104da8fc923e1968571136275835cb90b05a1bc2386687bff57994801e7dbebfc20f0e3fa7e80380f",
    "tee_tcb_svn": "0d010800000000000000000000000000"
  }
}
```

## Gateway response (full body)

```json
{
  "error": {
    "code": 401,
    "message": "invalid token: token signature is invalid: crypto/rsa: verification error",
    "type": "unauthorized"
  }
}
```

Same body returned from `/v1/chat/completions` against:

- `https://ai-gateway-dev.eigencloud.xyz` (SDK default)
- `https://ai-gateway.eigencloud.xyz` (probed alternative)

## Steps to reproduce

1. **Deploy any minimal Node service to sepolia on `g1-standard-4t`.**

   - Public registry, `linux/amd64` image, exposes `/healthz` on `0.0.0.0:$PORT`.
   - Do not include `AGENT_PRIVATE_KEY` in the env file — let the platform inject `MNEMONIC` automatically.
   - Sample command (Path A, pre-built image):

     ```bash
     ecloud compute app deploy \
       --name <app-name> \
       --image-ref <registry>/<image>:<tag> \
       --instance-type g1-standard-4t \
       --env-file .env \
       --log-visibility public \
       --resource-usage-monitoring enable \
       --skip-profile \
       --force \
       --verbose
     ```

2. **Install the AI gateway provider in the image.**

   ```bash
   npm install @layr-labs/ai-gateway-provider ai
   ```

3. **At application boot, perform one TEE attestation and call any model.**

   ```ts
   import { generateText } from "ai";
   import { createEigenGateway } from "@layr-labs/ai-gateway-provider";
   import { AttestClient } from "@layr-labs/ecloud-sdk/attest";

   const client = new AttestClient({
     kmsServerURL: process.env.KMS_SERVER_URL!,
     kmsPublicKey: process.env.KMS_PUBLIC_KEY!,
     audience: "llm-proxy",
   });
   const jwt = await client.attest();
   const factory = createEigenGateway({
     baseURL: "https://ai-gateway.eigencloud.xyz",
     jwt,
   });

   const { text } = await generateText({
     model: factory("anthropic/claude-sonnet-4.6"),
     prompt: "Reply with the word PONG and nothing else.",
   });
   ```

4. **Observe `401` with the body shown above.** Same result against `ai-gateway-dev.eigencloud.xyz` and `ai-gateway.eigencloud.xyz`. Same result with the SDK's default `eigen(...)` factory (i.e. without manually pre-attesting).

## Diagnostics already performed

- **JWT contents verified.** Decoded header + payload show `iss: eigenx-kms`, `aud: ["llm-proxy"]`, valid `iat`/`exp`, correct `app_id`, valid TDX measurements, and `gce.project_id: tee-compute-sepolia-prod`. The 401 message specifically says signature verification failed (`crypto/rsa: verification error`), not audience/expiry/issuer.
- **TPM contention ruled out.** Initial naive use of the SDK created an independent `JwtProvider` per model and produced concurrent attestation calls that raced on `/dev/tpmrm0` (`device or resource busy`). After pre-warming a single JWT at boot and sharing it across all parallel `generateText` calls, the busy errors disappear and every model uniformly receives the same `401` from the gateway. Pre-warm code: <https://github.com/megabyte0x/eigenisedNews/blob/main/src/fanout/llmProxy.ts>.
- **Gateway URL alternatives probed.** `ai-gateway-sepolia`, `ai-gateway-prod`, `ai-gateway-mainnet`, and `llm-proxy` subdomains under `eigencloud.xyz` did not resolve. Only `ai-gateway-dev` and `ai-gateway` returned HTTP responses, both with the same signature-verification error.
- **Container env confirmed.** `KMS_SERVER_URL`, `KMS_PUBLIC_KEY`, and `MNEMONIC` are all injected by the platform and visible to the workload (verified by logging `Object.keys(process.env)` at boot).
- **Verifiable build does not change the result.** Suspecting that a verifiable-build provenance binding might be required for the gateway to accept the JWT, we re-deployed via the platform's verifiable build pipeline with `--verifiable --repo --commit`. The image was rebuilt by `cloudbuild.googleapis.com/GoogleHostedWorker` (per the build's `provenanceJson`) and pushed to `docker.io/eigenlayer/eigencloud-containers@sha256:4da0373ec058e46159931617863ec4a3bc9a3151e5b9c155bd90c4d0ba65d325`. The JWT issued for this verifiable image carries the platform-built `image_digest` and identical `tdx.mrtd` measurements, but the gateway still rejects with the same `crypto/rsa: verification error`. Build ID: `971a920a-7434-49e3-94db-9105cec1d15a` (`status: success`). Same outcome as the Path A pre-built deploy.
- **Followed the canonical pattern.** Confirmed that the failing client code matches `github.com/Layr-Labs/ecloud-inference-example` (`@layr-labs/ai-gateway-provider@^1.0.1` + `ai@^6.0.168`, `eigen('anthropic/claude-sonnet-4.6')` via `generateText`, MNEMONIC-derived account, no manual JWT injection in the default code path).

## Why this looks platform-side

| Possible cause | Evidence |
|---|---|
| KMS signs JWT with key A; gateway verifies against key B | Error message is specifically `crypto/rsa: verification error`. All claims look valid. |
| App not authorized for inference | The error type is `unauthorized` but the message points at signature, not authorization scope or audience. We have an active compute subscription. |
| Wrong audience claim | JWT carries `aud: ["llm-proxy"]` which matches what the SDK requests. The error is not about audience. |
| Network / TLS issue | TLS handshake completes; we get a structured JSON error body from the gateway. |

## Asks

1. **Confirm whether sepolia-prod TEE attestations are expected to be accepted by the public AI Gateway today**, and which gateway URL is canonical for `tee-compute-sepolia-prod` apps.
2. **If the KMS↔gateway key sync is the root cause**, please publish the rotated key or a status URL we can poll.
3. **If sepolia-prod inference requires a separate enrollment step**, document it in the LLM Proxy Quickstart so apps don't deploy and silently 401.

## Reference: app and repository

- App dashboard: <https://verify-sepolia.eigencloud.xyz/app/0xc35c1d9555E5883Cb0915E02090A097478960734>
- Source: <https://github.com/megabyte0x/eigenisedNews>
- LLM proxy client: <https://github.com/megabyte0x/eigenisedNews/blob/main/src/fanout/llmProxy.ts>
- Notes on the assumed/empirical contract: <https://github.com/megabyte0x/eigenisedNews/blob/main/docs/llm-proxy-notes.md>

The app is currently in `Stopped` state to avoid further compute billing on a non-functional deploy. Happy to restart on request and provide live logs.
