import express, { type Express } from "express";
import { fetchUrl } from "./fetchers/sourceFetcher";
import { callModel } from "./fanout/llmProxy";
import { makeSynthesizeHandler } from "./http/synthesize";
import { makeManifestSigner } from "./manifest/sign";
import type { RunSynthesisDeps } from "./pipeline";
import type { Manifest } from "./types";
import { log } from "./lib/log";

function readDeployment(): Manifest["deployment"] {
  const env = (process.env.EIGEN_ENVIRONMENT ?? "local") as Manifest["deployment"]["environment"];
  return {
    appId: process.env.EIGEN_APP_ID ?? "local",
    agentAddress: process.env.AGENT_ID ?? "local",
    imageDigest: process.env.EIGEN_IMAGE_DIGEST ?? "local",
    commitSha: process.env.EIGEN_COMMIT_SHA ?? "local",
    environment: env,
  };
}

function readPrivateKey(): `0x${string}` {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("AGENT_PRIVATE_KEY not set or invalid");
  }
  return pk as `0x${string}`;
}

function buildProductionDeps(): RunSynthesisDeps {
  const { sign, address } = makeManifestSigner(readPrivateKey());
  const deployment = readDeployment();
  if (deployment.agentAddress === "local") deployment.agentAddress = address;
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
