import type { Sha256 } from "./lib/hash";

export type SynthesizeRequest = {
  topic: string;
  urls?: string[];
  sources?: SynthesizeSource[];
};

export type SynthesizeSource = { title?: string; url?: string; text: string };

export type InputRecord = {
  index: number;
  kind: "url" | "text";
  url?: string;
  contentSha256: Sha256 | null;
  fetchedAt?: string;
  byteLength: number;
  error: string | null;
};

export type ModelRunStatus = "ok" | "error";

export type ModelRun = {
  provider: string;
  model: string;
  version: string;
  promptHash: Sha256;
  status: ModelRunStatus;
  rawOutputSha256: Sha256 | null;
  parsedClaimCount: number;
  error: string | null;
};

export type StructuredClaim = {
  statement: string;
  supportingSourceIndices: number[];
};

export type Claim = StructuredClaim & {
  id: string;
  supportingModels: string[];
};

export type Manifest = {
  schemaVersion: "1";
  rulesetVersion: string;
  deployment: {
    appId: string;
    agentAddress: string;
    imageDigest: string;
    commitSha: string;
    environment: "mainnet-alpha" | "local";
  };
  request: { topic: string; requestHash: Sha256 };
  inputs: InputRecord[];
  models: ModelRun[];
  merge: {
    successfulModels: number;
    totalModels: number;
    thresholdMet: boolean;
    consensusThreshold: string;
    claims: Claim[];
    minorityClaims: Claim[];
  };
  brief: string;
  briefSha256: Sha256;
  timestamp: string;
  manifestSha256: Sha256;
};

export type RawModelOutput = { provider: string; model: string; rawOutput: string };

export type SynthesizeResponse = {
  manifest: Manifest;
  signature: `0x${string}`;
  raw: RawModelOutput[] | null;
};

export type NewsResearchRequest = {
  articleUrl: string;
  requestId?: string;
};

export type NewsResearchArticle = {
  url: string;
  contentSha256: Sha256 | null;
  fetchedAt?: string;
  byteLength: number;
  error: string | null;
};

export type NewsResearchAgentRole = "main" | "pro" | "contra";

export type NewsResearchPromptBinding = {
  role: NewsResearchAgentRole;
  perspective: "planner" | "supports_article" | "challenges_article";
  provider: string;
  model: string;
  systemPrompt: string;
  systemPromptSha256: Sha256;
  promptHash: Sha256;
  articleUrl: string;
  articleContentSha256: Sha256 | null;
  researchPrompt: string | null;
};

export type NewsResearchAgentRun = {
  role: NewsResearchAgentRole;
  provider: string;
  model: string;
  status: ModelRunStatus;
  promptHash: Sha256;
  rawOutputSha256: Sha256 | null;
  error: string | null;
};

export type NewsResearchVerifiableBuild = Manifest["deployment"] & {
  dashboardUrl: string | null;
  promptSourcePath: string;
  promptSourceUrl: string | null;
};

export type NewsResearchOutputHashes = {
  proPromptSha256: Sha256;
  contraPromptSha256: Sha256;
  proAnalysisSha256: Sha256;
  contraAnalysisSha256: Sha256;
  mainSummarySha256: Sha256;
  summaryAlgorithm: "composeResearchSummary/v1";
};

export type NewsResearchManifest = {
  schemaVersion: "1";
  rulesetVersion: string;
  kind: "research";
  deployment: Manifest["deployment"];
  request: { articleUrl: string; requestHash: Sha256 };
  article: NewsResearchArticle;
  promptBindings: NewsResearchPromptBinding[];
  agentRuns: NewsResearchAgentRun[];
  outputs: NewsResearchOutputHashes;
  timestamp: string;
  manifestSha256: Sha256;
};

export type NewsResearchRawAgentOutput = {
  role: NewsResearchAgentRole;
  provider: string;
  model: string;
  prompt: string;
  rawOutput: string;
};

export type NewsResearchRaw = {
  agentOutputs: NewsResearchRawAgentOutput[];
  mainSummary: string;
};

export type NewsResearchResponse = {
  article: NewsResearchArticle;
  proPrompt: string;
  contraPrompt: string;
  proAnalysis: string;
  contraAnalysis: string;
  mainSummary: string;
  promptBindings: NewsResearchPromptBinding[];
  verifiableBuild: NewsResearchVerifiableBuild;
  agentRuns: NewsResearchAgentRun[];
  manifest: NewsResearchManifest;
  signature: `0x${string}`;
  raw: NewsResearchRaw | null;
};

export type StructuredModelOutput = {
  claims: StructuredClaim[];
  summary: string;
};
