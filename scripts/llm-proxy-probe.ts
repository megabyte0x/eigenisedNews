/**
 * One-shot probe to determine the empirical contract of the EigenCloud LLM Proxy.
 *
 * Run:
 *   LLM_PROXY_URL=... LLM_PROXY_API_KEY=... tsx scripts/llm-proxy-probe.ts
 *
 * Prints the HTTP status, headers, and raw body for one call to each model in POLICY.MODEL_SET.
 * Use the output to update docs/llm-proxy-notes.md and verify src/fanout/llmProxy.ts
 * matches the actual contract.
 */

import { POLICY } from "../src/lib/policy";

const url = process.env.LLM_PROXY_URL;
const apiKey = process.env.LLM_PROXY_API_KEY;

if (!url || !apiKey) {
  console.error("Set LLM_PROXY_URL and LLM_PROXY_API_KEY env vars before running.");
  process.exit(1);
}

const PROMPT = "Reply with the literal word PONG and nothing else.";

for (const m of POLICY.MODEL_SET) {
  console.log("---");
  console.log(`probe ${m.provider}/${m.model}@${m.version}`);
  const body = {
    provider: m.provider,
    model: m.model,
    messages: [{ role: "user", content: PROMPT }],
    temperature: 0,
  };
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`network error after ${Date.now() - t0}ms:`, e);
    continue;
  }
  const ms = Date.now() - t0;
  const text = await res.text();
  console.log(`status: ${res.status} (${ms}ms)`);
  console.log("headers:", Object.fromEntries(res.headers));
  console.log("body:", text);
}
