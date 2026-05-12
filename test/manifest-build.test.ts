import { describe, test, expect } from "vitest";
import { buildManifest, buildResearchManifest, type BuildManifestInput, type BuildResearchManifestInput } from "../src/manifest/build";

const baseInput = (): BuildManifestInput => ({
  deployment: { appId: "0xapp", agentAddress: "0xagent", imageDigest: "sha256:img", commitSha: "abc", environment: "local" },
  request: { topic: "x", requestHash: "sha256:req" },
  inputs: [],
  models: [],
  merge: { successfulModels: 0, totalModels: 0, thresholdMet: false, consensusThreshold: "ceil(N_success/2)", claims: [], minorityClaims: [] },
  brief: "",
  briefSha256: "sha256:b",
  timestamp: "2026-04-27T12:00:00.000Z",
});

const baseResearchInput = (): BuildResearchManifestInput => ({
  deployment: { appId: "0xapp", agentAddress: "0xagent", imageDigest: "sha256:img", commitSha: "abc", environment: "local" },
  request: { articleUrl: "https://news.example/story", requestHash: "sha256:req" },
  article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-04-27T12:00:00.000Z", byteLength: 100, error: null },
  promptBindings: [],
  agentRuns: [],
  outputs: {
    proPromptSha256: "sha256:pro-prompt",
    contraPromptSha256: "sha256:contra-prompt",
    proAnalysisSha256: "sha256:pro",
    contraAnalysisSha256: "sha256:contra",
    mainSummarySha256: "sha256:summary",
    summaryAlgorithm: "mainAgentSummary/v1",
  },
  timestamp: "2026-04-27T12:00:00.000Z",
});

describe("buildManifest", () => {
  test("populates manifestSha256 deterministically", () => {
    const m1 = buildManifest(baseInput());
    const m2 = buildManifest(baseInput());
    expect(m1.manifestSha256).toBe(m2.manifestSha256);
    expect(m1.manifestSha256.startsWith("sha256:")).toBe(true);
  });

  test("manifestSha256 changes when any field changes", () => {
    const a = buildManifest(baseInput());
    const b = buildManifest({ ...baseInput(), brief: "different" });
    expect(a.manifestSha256).not.toBe(b.manifestSha256);
  });

  test("schemaVersion = '1' and rulesetVersion = POLICY.RULESET_VERSION", async () => {
    const { POLICY } = await import("../src/lib/policy");
    const m = buildManifest(baseInput());
    expect(m.schemaVersion).toBe("1");
    expect(m.rulesetVersion).toBe(POLICY.RULESET_VERSION);
  });

  test("preserves all input fields verbatim", () => {
    const input = baseInput();
    const m = buildManifest(input);
    expect(m.deployment).toEqual(input.deployment);
    expect(m.request).toEqual(input.request);
    expect(m.brief).toBe(input.brief);
    expect(m.timestamp).toBe(input.timestamp);
  });
});

describe("buildResearchManifest", () => {
  test("populates kind and manifestSha256 deterministically", () => {
    const m1 = buildResearchManifest(baseResearchInput());
    const m2 = buildResearchManifest(baseResearchInput());
    expect(m1.kind).toBe("research");
    expect(m1.manifestSha256).toBe(m2.manifestSha256);
    expect(m1.manifestSha256.startsWith("sha256:")).toBe(true);
  });

  test("manifestSha256 changes when research output hashes change", () => {
    const a = buildResearchManifest(baseResearchInput());
    const b = buildResearchManifest({
      ...baseResearchInput(),
      outputs: { ...baseResearchInput().outputs, mainSummarySha256: "sha256:different" },
    });
    expect(a.manifestSha256).not.toBe(b.manifestSha256);
  });
});
