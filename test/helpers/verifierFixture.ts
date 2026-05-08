import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runArticleResearch, runSynthesis, type RunSynthesisDeps } from "../../src/pipeline";
import type { NewsResearchResponse, SynthesizeResponse } from "../../src/types";

export const FIXED_TS = "2026-04-27T12:00:00.000Z";

export async function makeGoodResponse(): Promise<SynthesizeResponse> {
  const account = privateKeyToAccount(generatePrivateKey());
  const deps: RunSynthesisDeps = {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      text: `body of ${url}`,
      fetchedAt: FIXED_TS,
      byteLength: 16,
      error: null,
    }),
    callModel: async ({ provider, model }) => ({
      rawOutput: JSON.stringify({
        claims: [{ statement: "the sky is blue", supportingSourceIndices: [0] }],
        summary: `${provider}/${model}`,
      }),
      latencyMs: 5,
    }),
    now: () => FIXED_TS,
    deployment: {
      appId: "0xapp",
      agentAddress: account.address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "local",
    },
    sign: (h) => account.signMessage({ message: h }),
  };
  const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
  if (r.status !== "ok") throw new Error("setup: synthesis did not succeed");
  return { manifest: r.manifest, signature: r.signature, raw: r.raw };
}

export async function makeGoodResearchResponse(): Promise<NewsResearchResponse> {
  const account = privateKeyToAccount(generatePrivateKey());
  let calls = 0;
  const deps: RunSynthesisDeps = {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      text: "Acme shares rose after earnings beat expectations, but executives sold stock before guidance was cut.",
      fetchedAt: FIXED_TS,
      byteLength: 94,
      error: null,
    }),
    callModel: async () => {
      calls++;
      if (calls === 1) {
        return {
          rawOutput: JSON.stringify({
            proPrompt: "Research evidence that supports the article's market optimism.",
            contraPrompt: "Research evidence that challenges the article's market optimism.",
          }),
          latencyMs: 5,
        };
      }
      if (calls === 2) return { rawOutput: "Pro: earnings beat expectations.", latencyMs: 5 };
      return { rawOutput: "Contra: executive stock sales weaken the article's framing.", latencyMs: 5 };
    },
    now: () => FIXED_TS,
    deployment: {
      appId: "0xapp",
      agentAddress: account.address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "local",
    },
    sign: (h) => account.signMessage({ message: h }),
  };
  const r = await runArticleResearch(deps, { articleUrl: "https://news.example/acme" });
  if (r.status !== "ok") throw new Error("setup: research did not succeed");
  const { status: _status, ...response } = r;
  return response;
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
