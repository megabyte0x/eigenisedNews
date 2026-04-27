# LLM Proxy notes

## Source

Eigen Labs LLM Proxy Quickstart (Notion):
<https://eigen-labs.notion.site/LLM-Proxy-Quickstart-34c13c11c3e080ed84bada70ef9ef3a6>

NPM package: [`@layr-labs/ai-gateway-provider`](https://www.npmjs.com/package/@layr-labs/ai-gateway-provider) (v1.0.1).

## Contract

Not raw HTTP. The proxy is consumed via the **Vercel AI SDK** with a custom provider:

```ts
import { eigen } from "@layr-labs/ai-gateway-provider";
import { generateText } from "ai";

const { text } = await generateText({
  model: eigen("anthropic/claude-sonnet-4.6"),
  prompt: "Hello",
  temperature: 0,
});
```

Key properties:

- **No API keys.** Auth is automatic via JWT issued by the EigenCompute KMS based on TEE attestation. When deployed, `KMS_SERVER_URL` and `KMS_PUBLIC_KEY` are set by the platform.
- **Pay-per-call by the agent's account.** Inference is billed against the agent's wallet, not the operator's.
- **Anthropic via Bedrock; everything else via Vercel AI Gateway.**
- **OpenAI-compatible underneath**, but consumers should always go through `eigen()` rather than HTTP — the provider handles auth, base URL discovery, and JWT refresh.
- **Model namespace: `provider/model`** with dot-version slugs (e.g. `claude-sonnet-4.6`, not `claude-sonnet-4-6`).

## Model set used by this agent

From `src/lib/policy.ts`:

| provider/model | source |
|---|---|
| `anthropic/claude-sonnet-4.6` | confirmed in Notion + npm README |
| `anthropic/claude-opus-4.7` | confirmed in Notion |
| `openai/gpt-4o` | confirmed in npm README ("Using Multiple Models" example) |
| `google/gemini-2.5-pro` | inferred from "OpenAI-compatible passthrough via Vercel AI Gateway" |

`MIN_SUCCESS_COUNT = 3`. If the `google/gemini-2.5-pro` slug turns out to be wrong, the threshold is still met by the three confirmed models.

## Local dev (no TEE)

The SDK does TEE attestation on EigenCompute. For local dev / tests, use `createEigenGateway({ baseURL, fetch })` to bypass JWT and optionally inject a mock fetch. Tests in `test/llmProxy.test.ts` use a local HTTP mock server with this pattern.

## Probe

`scripts/llm-proxy-probe.ts` exercises one model end-to-end against the dev gateway. Run after credentials/env are provisioned:

```bash
EIGEN_GATEWAY_BASE_URL=https://ai-gateway-dev.eigencloud.xyz \
  tsx scripts/llm-proxy-probe.ts
```

If any model in `POLICY.MODEL_SET` returns an error, update the slug here and in `policy.ts`, then bump `RULESET_VERSION`.
