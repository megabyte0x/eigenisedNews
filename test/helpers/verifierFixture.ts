import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runArticleResearch, runSynthesis, type RunSynthesisDeps } from "../../src/pipeline";
import type { NewsResearchResponse, SynthesizeResponse } from "../../src/types";
import { makeRunSynthesisDeps, FIXED_TS } from "./synthesisFixture";

export { FIXED_TS } from "./synthesisFixture";

export async function makeGoodResponse(): Promise<SynthesizeResponse> {
  const r = await runSynthesis(makeRunSynthesisDeps(), { topic: "t", sources: [{ text: "src" }] });
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

export const clone = <T>(x: T): T => structuredClone(x);
