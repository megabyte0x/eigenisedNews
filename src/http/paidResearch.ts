import type { Express } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDual402, dualDiscovery, type Dual402Config, type JsonSchema } from "dual402";
import { log } from "../lib/log";
import type { RunSynthesisDeps } from "../pipeline";
import type { ResearchReportStore } from "../storage/researchStore";
import type { Manifest, ResearchStorageInfo } from "../types";
import { verifyResponse } from "../verifier/verify";
import type { CheckResult } from "../verifier/types";
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

type PaidResearchOptions = {
  researchStore?: ResearchReportStore;
};

export function mountPaidResearchApi(app: Express, deps: RunSynthesisDeps, env: NodeJS.ProcessEnv = process.env, options: PaidResearchOptions = {}): PaidResearchMountStatus {
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
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status, options.researchStore?.info);
    log("info", "paid_research_disabled", { route: PAID_RESEARCH_PATH, mode });
    return status;
  }

  if (!configResult.ok) {
    status = { ...status, missing: configResult.missing };
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status, options.researchStore?.info);
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

    app.post(PAID_RESEARCH_PATH, chargeResearch, makeResearchHandler(deps, { store: options.researchStore }));
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
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status, options.researchStore?.info);
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
    mountPaidResearchSupportRoutes(app, deps.deployment, env, status, options.researchStore?.info);
    if (mode === "enabled") throw error;
    if (shouldLogAutoDisabled(env, mode)) log("warn", "paid_research_disabled", { route: PAID_RESEARCH_PATH, mode, error: message });
    return status;
  }
}

function mountPaidResearchSupportRoutes(app: Express, deployment: Manifest["deployment"], env: NodeJS.ProcessEnv, status: PaidResearchMountStatus, storageInfo: ResearchStorageInfo | undefined): void {
  app.get("/verify", (_req, res) => {
    res.json(buildVerifyResponse(deployment, env, status, storageInfo));
  });
  app.post("/verify", async (req, res) => {
    const response = unwrapVerifyRequestBody(req.body);
    const checks = await verifyResponse(response);
    res.status(checks.some((check) => check.status === "fail") ? 422 : 200).json(buildBrowserVerifyResponse(checks));
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

function unwrapVerifyRequestBody(body: unknown): unknown {
  if (body && typeof body === "object" && "response" in body) {
    return (body as { response?: unknown }).response;
  }
  return body;
}

function buildBrowserVerifyResponse(checks: CheckResult[]): Record<string, unknown> {
  const pass = checks.filter((check) => check.status === "pass").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  const skip = checks.filter((check) => check.status === "skip").length;
  return {
    ok: fail === 0,
    mode: "browser",
    summary: {
      pass,
      fail,
      skip,
      title: fail === 0 ? "Verified in browser" : "Verification found a problem",
      explanation: fail === 0
        ? "The signed result is internally consistent. Skipped checks need live provenance or refetch evidence, but no terminal or file download is required for these browser checks."
        : "At least one integrity check failed. Treat this result as unverified until the issue is resolved.",
    },
    checks: checks.map(describeCheckForBrowser),
  };
}

function describeCheckForBrowser(check: CheckResult): Record<string, string> {
  return {
    ...check,
    label: labelForVerifyCheck(check.name),
    meaning: meaningForVerifyCheck(check.name, check.status),
  };
}

function labelForVerifyCheck(name: string): string {
  switch (name) {
    case "schema":
      return "Response shape";
    case "manifest_hash":
      return "Manifest hash";
    case "signature":
      return "Agent signature";
    case "inputs":
      return "Article binding";
    case "research_outputs":
      return "Displayed outputs";
    case "research_raw":
      return "Exact agent run";
    case "provenance":
      return "Verifiable build";
    case "raw_outputs":
      return "Raw model outputs";
    case "merge":
      return "Deterministic merge";
    default:
      return name.replace(/_/g, " ");
  }
}

function meaningForVerifyCheck(name: string, status: CheckResult["status"]): string {
  if (status === "fail") return "This check found a mismatch that needs investigation.";
  if (status === "skip") {
    if (name === "inputs") return "Live article refetch is not run from the default browser check.";
    if (name === "provenance") return "Live EigenCompute provenance is linked separately through Verify build.";
    return "This optional check needs evidence that was not part of the browser request.";
  }
  switch (name) {
    case "schema":
      return "The result has the expected signed research structure.";
    case "manifest_hash":
      return "The manifest hash recomputes to the value shown in the result.";
    case "signature":
      return "The manifest signature recovers the declared agent address.";
    case "research_outputs":
      return "The displayed pro/contra output and prompt hashes match the manifest.";
    case "research_raw":
      return "The exact planner, pro, contra, and summary prompts plus raw outputs match their hashes.";
    default:
      return "This integrity check passed.";
  }
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

function buildVerifyResponse(deployment: Manifest["deployment"], env: NodeJS.ProcessEnv, status: PaidResearchMountStatus, storageInfo: ResearchStorageInfo | undefined): Record<string, unknown> {
  const dashboardUrl = dashboardUrlForDeployment(deployment);
  const commitAvailable = isKnownMetadata(deployment.commitSha);
  const imageDigestAvailable = isKnownMetadata(deployment.imageDigest);
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
    verification: {
      purpose: [
        "This endpoint is the public verification guide for eigenisedNews.",
        "It explains the deployment, payment discovery, and how to verify a signed research package without exposing secrets.",
      ].join(" "),
      meaning: [
        "Verification does not decide which perspective is true.",
        "It proves which article bytes, prompts, model outputs, manifest hash, signer, and EigenCompute build produced the pro/contra result.",
      ].join(" "),
      researchPackage: {
        endpoint: "/research?include=raw",
        paidEndpoint: `${PAID_RESEARCH_PATH}?include=raw`,
        browserVerify: { method: "POST", endpoint: "/verify", body: "{ response: <research response> }" },
      },
      checks: [
        { name: "signed_manifest", explains: "The manifest hash is recovered from the agent signature and compared with the declared agent address." },
        { name: "article_binding", explains: "The saved article URL and content hash are checked, with optional refetch drift detection." },
        { name: "prompt_binding", explains: "The main planner, pro, and contra prompt hashes tie each displayed opinion to the exact agent instructions." },
        { name: "raw_outputs", explains: "When ?include=raw is used, the verifier checks the planner/pro/contra prompts and raw outputs against their hashes." },
        { name: "verifiable_build", explains: "EigenCompute provenance can confirm the app id, image digest, commit SHA, and agent address against verifiable-build evidence." },
      ],
      agentPerspectives: [
        { role: "main", perspective: "planner", displays: "Creates the pro and contra research prompts from the article." },
        { role: "pro", perspective: "supports_article", displays: "Runs the supporting argument with the shared article context." },
        { role: "contra", perspective: "challenges_article", displays: "Runs the challenging argument with the same article context." },
      ],
      metadataStatus: {
        commit: commitAvailable ? "available" : "missing",
        imageDigest: imageDigestAvailable ? "available" : "missing",
        guidance: commitAvailable && imageDigestAvailable
          ? "Commit and image digest are present for provenance checks."
          : "Set EIGEN_COMMIT_SHA/EIGEN_IMAGE_DIGEST, or compatible CI aliases, during deployment so responses can link to build provenance instead of reporting unknown metadata.",
      },
      storage: storageInfo ? {
        historyEndpoint: "/research/history",
        reportEndpointTemplate: "/research/history/{id}?include=raw",
        reportsPath: storageInfo.reportsPath,
        persistentDataPath: storageInfo.persistentDataPath,
        source: storageInfo.source,
        docs: storageInfo.docsUrl,
      } : null,
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

function isKnownMetadata(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "unknown" && normalized !== "unavailable" && normalized !== "null";
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
