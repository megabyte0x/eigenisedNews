# LLM Proxy notes

## Empirical probe status

**Status:** deferred. The probe script (`scripts/llm-proxy-probe.ts`) is shipped but not yet executed against the live proxy because credentials are not yet provisioned.

When credentials are issued, run:

```bash
LLM_PROXY_URL=... LLM_PROXY_API_KEY=... tsx scripts/llm-proxy-probe.ts
```

Record the **actual** request URL/path, request body shape, and response body shape below in this doc.

## Assumed contract (used by `src/fanout/llmProxy.ts` until probe confirms otherwise)

This assumption matches the request body shape shown in the plan and the most common multi-provider LLM-proxy convention (OpenAI-compatible chat completions, with a `provider` field for routing).

### Request

```
POST {LLM_PROXY_URL}/v1/chat/completions
Authorization: Bearer {LLM_PROXY_API_KEY}
Content-Type: application/json

{
  "provider": "openai" | "anthropic" | "google" | "xai",
  "model":    "<provider-model-id>",
  "messages": [{ "role": "user", "content": "<prompt>" }],
  "temperature": 0
}
```

### Response (200)

```
{
  "id": "...",
  "model": "<provider-model-id>",
  "choices": [
    { "message": { "role": "assistant", "content": "<rawOutput>" }, "finish_reason": "stop" }
  ],
  "usage": { /* token counts */ }
}
```

The client extracts `choices[0].message.content` as `rawOutput`.

### Errors

- 4xx → throw `http_<status>` (no retry).
- 5xx, timeout → retry per `POLICY.LLM_RETRIES`.

## When the live probe diverges from the assumption

If the actual contract differs (e.g. provider info encoded in URL path, different response shape, or model versioning surfaced differently):

1. Update this document with the actual contract.
2. Adjust `src/fanout/llmProxy.ts` minimally — keep the `callModel({proxyUrl, apiKey, provider, model, version, prompt, signal})` signature stable.
3. Re-run the full test suite and the smoke deploy on sepolia.

The pipeline (`src/pipeline.ts`) and HTTP layer should not need to change.

## Open questions for the probe to answer

- Does the proxy accept `response_format: { type: "json_object" }` or `{ type: "json_schema", json_schema: ... }` for any provider? If so, we should opt in for stricter parsing.
- Is the model version returned in the response (e.g. `model: "gpt-4o-2024-08-06"`)? If so, we should compare it to `POLICY.MODEL_SET[i].version` and treat a mismatch as an error.
- What's the typical p95 latency? `POLICY.LLM_TIMEOUT_MS = 45_000` may need adjustment.
