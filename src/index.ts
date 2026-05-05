import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { fetchUrl } from "./fetchers/sourceFetcher";
import { callModel } from "./fanout/llmProxy";
import { renderFrontendShell } from "./frontend/shell";
import { makeSynthesizeHandler } from "./http/synthesize";
import type { ManifestSigner } from "./manifest/sign";
import type { RunSynthesisDeps } from "./pipeline";
import type { Manifest } from "./types";
import { loadDotEnvFile } from "./lib/env";
import { isUnknownRecord } from "./lib/guards";
import { log } from "./lib/log";

loadDotEnvFile();

function readDeployment(fallbackAddress: `0x${string}`): Manifest["deployment"] {
  const env = readDeploymentEnvironment(process.env.EIGEN_ENVIRONMENT ?? (process.env.MNEMONIC ? "sepolia" : "local"));
  const h = hostname();
  const appIdFromHost = h.startsWith("tee-0x") ? h.slice(4) : null;
  return {
    appId: process.env.EIGEN_APP_ID ?? appIdFromHost ?? "local",
    agentAddress: (process.env.AGENT_ID ?? fallbackAddress).toLowerCase(),
    imageDigest: process.env.EIGEN_IMAGE_DIGEST ?? "unknown",
    commitSha: process.env.EIGEN_COMMIT_SHA ?? "unknown",
    environment: env,
  };
}

function readDeploymentEnvironment(value: string): Manifest["deployment"]["environment"] {
  if (value === "sepolia" || value === "mainnet-alpha" || value === "local") return value;
  throw new Error(`EIGEN_ENVIRONMENT invalid: ${value}`);
}

function readSigner(): { sign: ManifestSigner; address: `0x${string}` } {
  const pk = process.env.AGENT_PRIVATE_KEY?.trim();
  if (pk) {
    const hex = pk.startsWith("0x") ? pk : `0x${pk}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("AGENT_PRIVATE_KEY format invalid (need 64 hex chars)");
    const account = privateKeyToAccount(hex as `0x${string}`);
    return { sign: (h) => account.signMessage({ message: h }), address: account.address };
  }
  const mnemonic = process.env.MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Neither AGENT_PRIVATE_KEY nor MNEMONIC is set");
  // EigenCompute injects MNEMONIC; derive at m/44'/60'/0'/0/0 to match the address shown by `ecloud compute app info`.
  const account = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  return { sign: (h) => account.signMessage({ message: h }), address: account.address };
}

function buildProductionDeps(): RunSynthesisDeps {
  const { sign, address } = readSigner();
  const deployment = readDeployment(address);
  log("info", "boot", { agent: address, appId: deployment.appId, env: deployment.environment });
  return {
    fetchUrl,
    callModel: ({ provider, model, prompt }) => callModel({ provider, model, prompt }),
    now: () => new Date().toISOString(),
    deployment,
    sign,
  };
}

function assertRunSynthesisDeps(d: unknown): asserts d is RunSynthesisDeps {
  const deps = isUnknownRecord(d) ? d : {};
  const missing = [
    ["fetchUrl", typeof deps.fetchUrl === "function"],
    ["callModel", typeof deps.callModel === "function"],
    ["now", typeof deps.now === "function"],
    ["deployment", !!deps.deployment],
    ["sign", typeof deps.sign === "function"],
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`buildApp deps missing: ${missing.join(", ")}`);
}

export function buildApp(depsOverride?: RunSynthesisDeps): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  const staticDir = resolveStaticDir();
  if (staticDir) {
    app.use(express.static(staticDir, { extensions: ["js", "css"], index: false }));
  }
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/", (_req, res) => {
    res.type("html").send(renderFrontendShell());
  });

  if (depsOverride !== undefined) {
    assertRunSynthesisDeps(depsOverride);
    app.post("/synthesize", makeSynthesizeHandler(depsOverride));
  } else if (process.env.NODE_ENV !== "test") {
    app.post("/synthesize", makeSynthesizeHandler(buildProductionDeps()));
  }
  return app;
}

if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen(port, "0.0.0.0", () => {
    log("info", "listening", { port });
  });
}

function resolveStaticDir(): string | null {
  const distPath = join(process.cwd(), "dist/public");
  if (existsSync(distPath)) return distPath;
  const publicPath = join(process.cwd(), "public");
  return existsSync(publicPath) ? publicPath : null;
}
