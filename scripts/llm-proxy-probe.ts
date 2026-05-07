/**
 * One-shot probe of the EigenCloud LLM Proxy for each model in POLICY.MODEL_SET.
 *
 * Run:
 *   EIGEN_GATEWAY_URL=https://ai-gateway.eigencloud.xyz tsx scripts/llm-proxy-probe.ts
 *
 * Prints per-model status and latency. If a model errors, update its slug in
 * src/lib/policy.ts and bump RULESET_VERSION.
 */

import { eigen, createEigenGateway } from "@layr-labs/ai-gateway-provider";
import { callModel, extractCallErrorDebugInfo } from "../src/fanout/llmProxy";
import { resolveEigenGatewayUrl } from "../src/lib/eigenGateway";
import { POLICY, providerModelKey } from "../src/lib/policy";

const baseURL = (process.env.EIGEN_GATEWAY_URL || process.env.EIGEN_GATEWAY_BASE_URL) ? resolveEigenGatewayUrl() : null;
const factory = baseURL ? createEigenGateway({ baseURL }) : eigen;

const PROMPT = "Reply with the literal word PONG and nothing else.";

for (const m of POLICY.MODEL_SET) {
  const id = providerModelKey(m);
  const t0 = Date.now();
  try {
    const { rawOutput } = await callModel({
      provider: m.provider,
      model: m.model,
      prompt: PROMPT,
      retries: 0,
      modelFactory: factory,
    });
    console.log(`OK   ${id}  ${Date.now() - t0}ms  → ${JSON.stringify(rawOutput.slice(0, 80))}`);
  } catch (e) {
    console.error(`FAIL ${id}  ${Date.now() - t0}ms  → ${e instanceof Error ? e.message : e}`);
    const debug = extractCallErrorDebugInfo(e);
    if (debug) {
      console.error(`DEBUG ${id}  ${JSON.stringify(debug)}`);
    }
  }
}
