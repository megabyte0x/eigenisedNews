import express, { type Express } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { fetchUrl } from "./fetchers/sourceFetcher";
import { callModel } from "./fanout/llmProxy";
import { makeSynthesizeHandler } from "./http/synthesize";
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

export function buildApp(depsOverride?: Partial<RunSynthesisDeps>): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Deps: real adapters by default; tests inject mocks via depsOverride.
  let deps: RunSynthesisDeps;
  if (depsOverride && depsOverride.fetchUrl && depsOverride.callModel && depsOverride.now && depsOverride.deployment && depsOverride.signerPrivateKey) {
    deps = depsOverride as RunSynthesisDeps;
  } else if (process.env.NODE_ENV !== "test") {
    const proxyUrl = process.env.LLM_PROXY_URL;
    const apiKey = process.env.LLM_PROXY_API_KEY;
    if (!proxyUrl || !apiKey) throw new Error("LLM_PROXY_URL or LLM_PROXY_API_KEY missing");
    const pk = readPrivateKey();
    const deployment = readDeployment();
    if (deployment.agentAddress === "local") {
      deployment.agentAddress = privateKeyToAccount(pk).address;
    }
    deps = {
      fetchUrl,
      callModel: async ({ provider, model, version, prompt }) =>
        callModel({ proxyUrl, apiKey, provider, model, version, prompt }),
      now: () => new Date().toISOString(),
      deployment,
      signerPrivateKey: pk,
    };
  } else {
    // In tests with no override, /synthesize is not wired.
    return app;
  }

  app.post("/synthesize", makeSynthesizeHandler(deps));
  return app;
}

if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen(port, "0.0.0.0", () => {
    log("info", "listening", { port });
  });
}
