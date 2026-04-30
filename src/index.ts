import express, { type Express } from "express";
import { hostname } from "node:os";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { fetchUrl } from "./fetchers/sourceFetcher";
import { callModel } from "./fanout/llmProxy";
import { makeSynthesizeHandler } from "./http/synthesize";
import type { ManifestSigner } from "./manifest/sign";
import type { RunSynthesisDeps } from "./pipeline";
import type { Manifest } from "./types";
import { log } from "./lib/log";

function readDeployment(fallbackAddress: `0x${string}`): Manifest["deployment"] {
  const env = (process.env.EIGEN_ENVIRONMENT ?? (process.env.MNEMONIC ? "sepolia" : "local")) as Manifest["deployment"]["environment"];
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

function isCompleteDeps(d?: Partial<RunSynthesisDeps>): d is RunSynthesisDeps {
  return !!(d && d.fetchUrl && d.callModel && d.now && d.deployment && d.sign);
}

export function buildApp(depsOverride?: Partial<RunSynthesisDeps>): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  if (isCompleteDeps(depsOverride)) {
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
