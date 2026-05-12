import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { RunSynthesisDeps } from "../../src/pipeline";
import type { Sha256 } from "../../src/lib/hash";

export const FIXED_TS = "2026-04-27T12:00:00.000Z";
export const ZERO_SHA256: Sha256 = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_CLAIM = "the sky is blue";

export function structuredModelOutput(
  statement = DEFAULT_CLAIM,
  summary = "s",
  supportingSourceIndices: number[] = [0]
): string {
  return JSON.stringify({ claims: [{ statement, supportingSourceIndices }], summary });
}

export function makeRunSynthesisDeps(overrides: Partial<RunSynthesisDeps> = {}): RunSynthesisDeps {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    fetchUrl: async (url) => {
      const text = `body of ${url}`;
      return {
        kind: "url",
        url,
        contentSha256: ZERO_SHA256,
        text,
        fetchedAt: FIXED_TS,
        byteLength: Buffer.byteLength(text, "utf8"),
        error: null,
      };
    },
    callModel: async ({ provider, model }) => ({
      rawOutput: structuredModelOutput(DEFAULT_CLAIM, `${provider}/${model}`),
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
    ...overrides,
  };
}
