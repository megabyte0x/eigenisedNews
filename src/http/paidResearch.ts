import type { Express } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDual402, dualDiscovery, type Dual402Config, type JsonSchema } from "dual402";
import { log } from "../lib/log";
import type { RunSynthesisDeps } from "../pipeline";
import type { Manifest } from "../types";
import { makeResearchHandler } from "./research";

export const PAID_RESEARCH_PATH = "/api/research";
export const PAID_RESEARCH_SKILL_PATH = "/skill.md";

const DEFAULT_SERVICE_NAME = "eigenised-news";
const DEFAULT_SERVICE_VERSION = "0.1.0";
const DEFAULT_PRICE_USDC = "0.05";
const DEFAULT_X402_NETWORK = "eip155:8453";
const DEFAULT_X402_MAINNET_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
const DEFAULT_X402_SEPOLIA_FACILITATOR = "https://x402.org/facilitator";
const SOURCE_REPOSITORY_URL = "https://github.com/megabyte0x/eigenisedNews";
const SKILL_RELATIVE_PATH = "agent-skills/eigenised-news-paid-research/SKILL.md";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type PaidResearchMode = "auto" | "enabled" | "disabled";

export type PaidResearchMountStatus = {
  enabled: boolean;
  path: typeof PAID_RESEARCH_PATH;
  priceUsd: string;
  missing: string[];
  mode: PaidResearchMode;
  error: string | null;
  payment: PublicPaymentConfig | null;
};

type PublicPaymentConfig = {
  x402: {
    network: string;
    facilitatorUrl: string;
    facilitatorHost: string;
    payee: `0x${string}`;
  };
  mpp: {
    rail: "tempo";
    currency: `0x${string}`;
    recipient: `0x${string}`;
    testnet: boolean;
    realm: string | null;
  };
  waitForSettle: boolean;
};

type ResolvedPaymentConfig = {
  dualConfig: Dual402Config;
  publicConfig: PublicPaymentConfig;
};

type PaymentConfigResult =
  | { ok: true; value: ResolvedPaymentConfig }
  | { ok: false; missing: string[] };

export function mountPaidResearchApi(app: Express, deps: RunSynthesisDeps, env: NodeJS.ProcessEnv = process.env): PaidResearchMountStatus {
  const mode = readPaidResearchMode(env.PAID_RESEARCH_ENABLED);
  const priceUsd = nonEmpty(env.PAID_RESEARCH_PRICE_USDC) ?? DEFAULT_PRICE_USDC;
  let status: PaidResearchMountStatus = {
    enabled: false,
    path: PAID_RESEARCH_PATH,
    priceUsd,
    missing: [],
    mode,
    error: null,
    payment: null,
  };

  const configResult = resolvePaymentConfig(env);
  if (mode === "disabled") {
    status = { ...status, missing: configResult.ok ? [] : configResult.missing };
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status);
    log("info", "paid_research_disabled", { route: PAID_RESEARCH_PATH, mode });
    return status;
  }

  if (!configResult.ok) {
    status = { ...status, missing: configResult.missing };
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status);
    const message = `paid research payment config missing: ${configResult.missing.join(", ")}`;
    if (mode === "enabled") throw new Error(message);
    if (shouldLogAutoDisabled(env, mode)) {
      log("warn", "paid_research_disabled", { route: PAID_RESEARCH_PATH, mode, missing: configResult.missing });
    }
    return status;
  }

  try {
    const dual = createDual402(configResult.value.dualConfig);
    const chargeResearch = dual.charge({
      amount: priceUsd,
      description: nonEmpty(env.PAID_RESEARCH_DESCRIPTION) ?? "Eigenised news article research by pro and contra AI agents.",
      waitForSettle: readBoolean(env.PAID_RESEARCH_WAIT_FOR_SETTLE),
    });

    app.post(PAID_RESEARCH_PATH, chargeResearch, makeResearchHandler(deps));
    dualDiscovery(app, dual, {
      info: {
        title: nonEmpty(env.SERVICE_NAME) ?? "eigenisedNews Paid Research API",
        version: nonEmpty(env.SERVICE_VERSION) ?? DEFAULT_SERVICE_VERSION,
        description: "Paid EigenCompute article research API that accepts either x402 (Base USDC) or MPP (Tempo USDC).",
        "x-guidance": [
          `POST ${PAID_RESEARCH_PATH} with JSON {"articleUrl":"https://..."}.`,
          "The first unpaid request returns HTTP 402 with x402 and MPP challenges.",
          "Pay using either protocol, then retry the exact same request body.",
          "Append ?include=raw when you need full planner/pro/contra prompts and raw model outputs for audit.",
        ].join(" "),
      },
      serviceInfo: {
        name: nonEmpty(env.SERVICE_NAME) ?? DEFAULT_SERVICE_NAME,
        categories: ["news", "research", "paid-api", "x402", "mpp", "eigencompute"],
        skill: PAID_RESEARCH_SKILL_PATH,
        verify: "/verify",
      },
      routes: [
        {
          method: "post",
          path: PAID_RESEARCH_PATH,
          handler: chargeResearch,
          operationId: "postPaidResearch",
          tags: ["research", "paid-api"],
          summary: "Run paid article research",
          description: "Fetch one article URL, generate pro and contra research prompts, run both agents, and return a signed research manifest.",
          requestBodySchema: paidResearchRequestSchema,
          responseSchema: paidResearchResponseSchema,
        },
      ],
    });

    const publicPayment = configResult.value.publicConfig;
    status = {
      ...status,
      enabled: true,
      payment: publicPayment,
    };
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status);
    log("info", "paid_research_enabled", {
      route: PAID_RESEARCH_PATH,
      priceUsd,
      x402Network: publicPayment.x402.network,
      x402Facilitator: publicPayment.x402.facilitatorHost,
      mppTestnet: publicPayment.mpp.testnet,
    });
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status = { ...status, error: message, payment: configResult.value.publicConfig };
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status);
    if (mode === "enabled") throw error;
    if (shouldLogAutoDisabled(env, mode)) log("warn", "paid_research_disabled", { route: PAID_RESEARCH_PATH, mode, error: message });
    return status;
  }
}

function mountPaidResearchSupportRoutes(app: Express, deployment: Manifest["deployment"], env: NodeJS.ProcessEnv, status: PaidResearchMountStatus): void {
  app.get("/verify", (_req, res) => {
    res.json(buildVerifyResponse(deployment, env, status));
  });
  app.get(PAID_RESEARCH_SKILL_PATH, (_req, res) => {
    const text = readSkillMarkdown();
    if (!text) {
      res.status(404).json({ error: "skill_not_found", path: SKILL_RELATIVE_PATH });
      return;
    }
    res.type("text/markdown; charset=utf-8").send(text);
  });
}

function resolvePaymentConfig(env: NodeJS.ProcessEnv): PaymentConfigResult {
  const missing: string[] = [];
  const sharedRecipient = nonEmpty(env.RECIPIENT_WALLET);
  const mppRecipient = nonEmpty(env.MPP_RECIPIENT) ?? sharedRecipient;
  const x402Payee = nonEmpty(env.X402_PAYEE_ADDRESS) ?? sharedRecipient;
  const mppCurrency = nonEmpty(env.USDC_TEMPO);
  const mppSecretKey = nonEmpty(env.MPP_SECRET_KEY);
  const x402Network = nonEmpty(env.X402_NETWORK) ?? DEFAULT_X402_NETWORK;
  const x402FacilitatorUrl = nonEmpty(env.X402_FACILITATOR_URL) ?? defaultFacilitatorForNetwork(x402Network);
  const cdpApiKeyId = nonEmpty(env.CDP_API_KEY_ID);
  const cdpApiKeySecret = nonEmpty(env.CDP_API_KEY_SECRET);

  requireEvmAddress(missing, "MPP_RECIPIENT or RECIPIENT_WALLET", mppRecipient);
  requireEvmAddress(missing, "X402_PAYEE_ADDRESS or RECIPIENT_WALLET", x402Payee);
  requireEvmAddress(missing, "USDC_TEMPO", mppCurrency);
  if (!mppSecretKey) missing.push("MPP_SECRET_KEY");
  if (usesCdpFacilitator(x402FacilitatorUrl) && x402Network === DEFAULT_X402_NETWORK) {
    if (!cdpApiKeyId) missing.push("CDP_API_KEY_ID");
    if (!cdpApiKeySecret) missing.push("CDP_API_KEY_SECRET");
  }

  if (missing.length > 0 || !mppRecipient || !x402Payee || !mppCurrency || !mppSecretKey) {
    return { ok: false, missing };
  }

  const resolvedMppRecipient = mppRecipient as `0x${string}`;
  const resolvedX402Payee = x402Payee as `0x${string}`;
  const resolvedMppCurrency = mppCurrency as `0x${string}`;
  const waitForSettle = readBoolean(env.PAID_RESEARCH_WAIT_FOR_SETTLE);
  const mppTestnet = readBoolean(env.MPP_TESTNET);
  const mppRealm = nonEmpty(env.MPP_REALM);
  const dualConfig: Dual402Config = {
    mpp: {
      currency: resolvedMppCurrency,
      recipient: resolvedMppRecipient,
      secretKey: mppSecretKey,
      ...(mppRealm ? { realm: mppRealm } : {}),
      ...(mppTestnet ? { testnet: true } : {}),
    },
    x402: {
      payTo: resolvedX402Payee,
      network: x402Network,
      facilitatorUrl: x402FacilitatorUrl,
      ...(cdpApiKeyId && cdpApiKeySecret ? { cdpAuth: { apiKeyId: cdpApiKeyId, apiKeySecret: cdpApiKeySecret } } : {}),
    },
  };

  return {
    ok: true,
    value: {
      dualConfig,
      publicConfig: {
        x402: {
          network: x402Network,
          facilitatorUrl: x402FacilitatorUrl,
          facilitatorHost: safeUrlHost(x402FacilitatorUrl),
          payee: resolvedX402Payee,
        },
        mpp: {
          rail: "tempo",
          currency: resolvedMppCurrency,
          recipient: resolvedMppRecipient,
          testnet: mppTestnet,
          realm: mppRealm ?? null,
        },
        waitForSettle,
      },
    },
  };
}

function buildVerifyResponse(deployment: Manifest["deployment"], env: NodeJS.ProcessEnv, status: PaidResearchMountStatus): Record<string, unknown> {
  const dashboardUrl = dashboardUrlForDeployment(deployment);
  return {
    service: {
      name: nonEmpty(env.SERVICE_NAME) ?? DEFAULT_SERVICE_NAME,
      version: nonEmpty(env.SERVICE_VERSION) ?? DEFAULT_SERVICE_VERSION,
      paidResearchPath: PAID_RESEARCH_PATH,
    },
    code: {
      commit: deployment.commitSha,
      imageDigest: deployment.imageDigest,
      repo: nonEmpty(env.REPO_URL) ?? SOURCE_REPOSITORY_URL,
    },
    runtime: {
      appId: deployment.appId,
      agentAddress: deployment.agentAddress,
      environment: deployment.environment,
      dashboardUrl,
    },
    payment: {
      enabled: status.enabled,
      mode: status.mode,
      price: { amount: status.priceUsd, currency: "USDC" },
      missing: status.missing,
      error: status.error,
      x402: status.payment?.x402 ?? null,
      mpp: status.payment?.mpp ?? null,
    },
    discovery: {
      openapi: status.enabled ? "/openapi.json" : null,
      x402: status.enabled ? "/.well-known/x402" : null,
      skill: PAID_RESEARCH_SKILL_PATH,
    },
    framework: {
      name: "dual402",
      npm: "https://www.npmjs.com/package/dual402",
      source: "https://github.com/mmurrs/dual402",
    },
  };
}

function readSkillMarkdown(): string | null {
  const path = join(process.cwd(), SKILL_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function dashboardUrlForDeployment(deployment: Manifest["deployment"]): string | null {
  if (deployment.appId === "local" || deployment.appId === "unknown") return null;
  if (deployment.environment === "mainnet-alpha") return `https://verify.eigencloud.xyz/app/${deployment.appId}`;
  if (deployment.environment === "sepolia") return `https://verify-sepolia.eigencloud.xyz/app/${deployment.appId}`;
  return null;
}

function requireEvmAddress(missing: string[], name: string, value: string | undefined): void {
  if (!value) {
    missing.push(name);
    return;
  }
  if (!EVM_ADDRESS_RE.test(value)) missing.push(`${name} (must be 0x + 40 hex chars)`);
}

function readPaidResearchMode(value: string | undefined): PaidResearchMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "off" || normalized === "disabled") return "disabled";
  if (normalized === "true" || normalized === "1" || normalized === "on" || normalized === "enabled") return "enabled";
  return "auto";
}

function defaultFacilitatorForNetwork(network: string): string {
  return network === "eip155:84532" ? DEFAULT_X402_SEPOLIA_FACILITATOR : DEFAULT_X402_MAINNET_FACILITATOR;
}

function usesCdpFacilitator(value: string): boolean {
  return safeUrlHost(value) === "api.cdp.coinbase.com";
}

function safeUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function readBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function shouldLogAutoDisabled(env: NodeJS.ProcessEnv, mode: PaidResearchMode): boolean {
  return mode !== "auto" || (env.NODE_ENV !== "test" && env.VITEST !== "true");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const paidResearchRequestSchema: JsonSchema = {
  type: "object",
  properties: {
    articleUrl: {
      type: "string",
      format: "uri",
      description: "HTTP(S) URL of the news article to research.",
    },
  },
  required: ["articleUrl"],
  additionalProperties: false,
};

const paidResearchResponseSchema: JsonSchema = {
  type: "object",
  properties: {
    article: { type: "object" },
    proPrompt: { type: "string" },
    contraPrompt: { type: "string" },
    proAnalysis: { type: "string" },
    contraAnalysis: { type: "string" },
    mainSummary: { type: "string" },
    promptBindings: { type: "array", items: { type: "object" } },
    verifiableBuild: { type: "object" },
    agentRuns: { type: "array", items: { type: "object" } },
    manifest: { type: "object" },
    signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
    raw: {
      anyOf: [
        { type: "object" },
        { type: "null" },
      ],
    },
  },
  required: [
    "article",
    "proPrompt",
    "contraPrompt",
    "proAnalysis",
    "contraAnalysis",
    "mainSummary",
    "promptBindings",
    "verifiableBuild",
    "agentRuns",
    "manifest",
    "signature",
    "raw",
  ],
};
