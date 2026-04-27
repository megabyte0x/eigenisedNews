/**
 * One-shot probe of the EigenCloud LLM Proxy for each model in POLICY.MODEL_SET.
 *
 * Run:
 *   EIGEN_GATEWAY_BASE_URL=https://ai-gateway-dev.eigencloud.xyz tsx scripts/llm-proxy-probe.ts
 *
 * Prints per-model status and latency. If a model errors, update its slug in
 * src/lib/policy.ts and bump RULESET_VERSION.
 */

import { generateText } from "ai";
import { eigen, createEigenGateway } from "@layr-labs/ai-gateway-provider";
import { POLICY } from "../src/lib/policy";

const baseURL = process.env.EIGEN_GATEWAY_BASE_URL;
const factory = baseURL ? createEigenGateway({ baseURL }) : eigen;

const PROMPT = "Reply with the literal word PONG and nothing else.";

for (const m of POLICY.MODEL_SET) {
  const id = `${m.provider}/${m.model}`;
  const t0 = Date.now();
  try {
    const { text } = await generateText({
      model: factory(id),
      prompt: PROMPT,
      temperature: 0,
    });
    console.log(`OK   ${id}  ${Date.now() - t0}ms  → ${JSON.stringify(text.slice(0, 80))}`);
  } catch (e) {
    console.error(`FAIL ${id}  ${Date.now() - t0}ms  → ${e instanceof Error ? e.message : e}`);
  }
}
