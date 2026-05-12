import { describe, expect, test } from "vitest";
import request from "supertest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../src/index";
import type { RunSynthesisDeps } from "../src/pipeline";
import { makeGoodResearchResponse } from "./helpers/verifierFixture";

const FIXED_TS = "2026-04-27T12:00:00.000Z";
const TEST_WALLET = "0x1111111111111111111111111111111111111111";
const TEST_TEMPO_USDC = "0x20c0000000000000000000000000000000000000";
const TEST_MPP_SECRET = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const PAYMENT_ENV: Record<string, string> = {
  PAID_RESEARCH_ENABLED: "true",
  PAID_RESEARCH_PRICE_USDC: "0.03",
  RECIPIENT_WALLET: TEST_WALLET,
  MPP_SECRET_KEY: TEST_MPP_SECRET,
  USDC_TEMPO: TEST_TEMPO_USDC,
  MPP_TESTNET: "true",
  X402_NETWORK: "eip155:84532",
  X402_FACILITATOR_URL: "https://x402.org/facilitator",
  BASE_URL: "https://paid.example",
  SERVICE_NAME: "eigenisedNews-paid-research",
};

const PAYMENT_ENV_KEYS = [
  "PAID_RESEARCH_ENABLED",
  "PAID_RESEARCH_PRICE_USDC",
  "PAID_RESEARCH_DESCRIPTION",
  "PAID_RESEARCH_WAIT_FOR_SETTLE",
  "RECIPIENT_WALLET",
  "MPP_SECRET_KEY",
  "USDC_TEMPO",
  "MPP_RECIPIENT",
  "MPP_REALM",
  "MPP_TESTNET",
  "X402_PAYEE_ADDRESS",
  "X402_NETWORK",
  "X402_FACILITATOR_URL",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "BASE_URL",
  "SERVICE_NAME",
  "SERVICE_VERSION",
  "CORS_ALLOW_ORIGINS",
];

function makeDeps(overrides: Partial<RunSynthesisDeps> = {}): RunSynthesisDeps {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      text: "A news article about earnings, market reaction, and governance concerns.",
      fetchedAt: FIXED_TS,
      byteLength: 70,
      error: null,
    }),
    callModel: async ({ prompt }) => {
      if (prompt.includes("Create two research prompts")) {
        return {
          rawOutput: JSON.stringify({
            proPrompt: "Support the article with market and earnings evidence.",
            contraPrompt: "Challenge the article with governance and timing evidence.",
          }),
          latencyMs: 5,
        };
      }
      if (prompt.includes("Support the article")) return { rawOutput: "For: earnings evidence supports the article.\nVerdict: supportive.", latencyMs: 5 };
      if (prompt.includes("Challenge the article")) return { rawOutput: "Against: governance timing challenges the article.\nVerdict: cautionary.", latencyMs: 5 };
      return { rawOutput: "Similarities: both address earnings and governance.\n\nDivergences: pro emphasizes earnings while contra emphasizes governance timing.\n\nBottom line: the article is plausible but caveated.", latencyMs: 5 };
    },
    now: () => FIXED_TS,
    deployment: {
      appId: "0xapp",
      agentAddress: account.address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "sepolia",
    },
    sign: (h) => account.signMessage({ message: h }),
    ...overrides,
  };
}

async function withPaymentEnv<T>(env: Record<string, string>, run: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of PAYMENT_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  try {
    return await run();
  } finally {
    for (const key of PAYMENT_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("dual402 paid research API", () => {
  test("unpaid POST /api/research returns a 402 payment challenge before running agents", async () => {
    await withPaymentEnv(PAYMENT_ENV, async () => {
      let fetchCalls = 0;
      let modelCalls = 0;
      const app = buildApp(makeDeps({
        fetchUrl: async (url) => {
          fetchCalls++;
          return {
            kind: "url",
            url,
            contentSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            text: "should not be fetched before payment",
            fetchedAt: FIXED_TS,
            byteLength: 36,
            error: null,
          };
        },
        callModel: async () => {
          modelCalls++;
          return { rawOutput: "should not run before payment", latencyMs: 1 };
        },
      }));

      const res = await request(app)
        .post("/api/research")
        .send({ articleUrl: "https://news.example/story" });

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();
      expect(res.headers["www-authenticate"]).toBeDefined();
      expect(fetchCalls).toBe(0);
      expect(modelCalls).toBe(0);
    });
  });

  test("publishes paid route discovery for x402 and MPP clients", async () => {
    await withPaymentEnv(PAYMENT_ENV, async () => {
      const app = buildApp(makeDeps());

      const openapi = await request(app).get("/openapi.json");
      expect(openapi.status).toBe(200);
      expect(openapi.body.paths["/api/research"].post.operationId).toBe("postPaidResearch");
      expect(openapi.body.paths["/api/research"].post["x-payment-info"].price.amount).toBe("0.03");
      expect(openapi.body.paths["/api/research"].post["x-payment-info"].protocols).toEqual([
        { x402: {} },
        { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
      ]);
      expect(openapi.body.info["x-guidance"]).toContain("Pay using either protocol");

      const x402 = await request(app).get("/.well-known/x402");
      expect(x402.status).toBe(200);
      expect(x402.body.resources).toContain("POST /api/research");
    });
  });

  test("/verify exposes public audit metadata without secrets", async () => {
    await withPaymentEnv(PAYMENT_ENV, async () => {
      const app = buildApp(makeDeps());
      const res = await request(app).get("/verify");

      expect(res.status).toBe(200);
      expect(res.body.payment.enabled).toBe(true);
      expect(res.body.payment.price).toEqual({ amount: "0.03", currency: "USDC" });
      expect(res.body.payment.x402.payee).toBe(TEST_WALLET);
      expect(res.body.payment.mpp.recipient).toBe(TEST_WALLET);
      expect(res.body.runtime.dashboardUrl).toBe("https://verify-sepolia.eigencloud.xyz/app/0xapp");
      expect(res.body.verification.meaning).toContain("does not decide which perspective is true");
      expect(res.body.verification.checks.map((check: { name: string }) => check.name)).toContain("verifiable_build");
      expect(res.body.verification.researchPackage.browserVerify).toEqual({ method: "POST", endpoint: "/verify", body: "{ response: <research response> }" });
      expect(res.body.verification.metadataStatus).toMatchObject({ commit: "available", imageDigest: "available" });
      expect(JSON.stringify(res.body)).not.toContain("verify-manifest.ts");
      expect(JSON.stringify(res.body)).not.toContain(TEST_MPP_SECRET);
    });
  });

  test("POST /verify runs browser verification without a downloaded file", async () => {
    await withPaymentEnv(PAYMENT_ENV, async () => {
      const app = buildApp(makeDeps());
      const response = await makeGoodResearchResponse();
      const res = await request(app)
        .post("/verify")
        .send({ response });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.mode).toBe("browser");
      expect(res.body.summary.title).toBe("Verified in browser");
      expect(res.body.summary.explanation).toContain("no terminal or file download");
      expect(res.body.checks.map((check: { label: string }) => check.label)).toContain("Exact agent run");
    });
  });

  test("serves the external agent skill markdown", async () => {
    await withPaymentEnv(PAYMENT_ENV, async () => {
      const res = await request(buildApp(makeDeps())).get("/skill.md");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/markdown/);
      expect(res.text).toContain("eigenisedNews Paid Research API");
      expect(res.text).toContain("https://agentskills.io/mcp");
    });
  });

  test("allowlisted CORS preflight exposes payment headers for browser-based agents", async () => {
    await withPaymentEnv({ ...PAYMENT_ENV, CORS_ALLOW_ORIGINS: "https://agent.example" }, async () => {
      const res = await request(buildApp(makeDeps()))
        .options("/api/research")
        .set("Origin", "https://agent.example")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type, payment-signature");

      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://agent.example");
      expect(res.headers["access-control-allow-headers"]).toContain("payment-signature");
      expect(res.headers["access-control-expose-headers"]).toContain("PAYMENT-REQUIRED");
      expect(res.headers["access-control-expose-headers"]).toContain("PAYMENT-RESPONSE");
    });
  });

  test("explicitly enabled paid research fails closed when payment config is incomplete", async () => {
    await withPaymentEnv({ PAID_RESEARCH_ENABLED: "true" }, async () => {
      expect(() => buildApp(makeDeps())).toThrow(/paid research payment config missing/i);
    });
  });
});
