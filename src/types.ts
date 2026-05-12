import type { Sha256 } from "./lib/hash";

export type SynthesizeRequest = {
  topic: string;
  urls?: string[];
  sources?: SynthesizeSource[];
};

type SynthesizeSource = { title?: string; url?: string; text: string };

export type InputRecord = {
  index: number;
  kind: "url" | "text";
  url?: string;
  contentSha256: Sha256 | null;
  fetchedAt?: string;
  byteLength: number;
  error: string | null;
};

type ModelRunStatus = "ok" | "error";

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
    environment: "mainnet-alpha" | "sepolia" | "local";
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

type NewsResearchArticle = {
  url: string;
  contentSha256: Sha256 | null;
  fetchedAt?: string;
  byteLength: number;
  error: string | null;
};

export type NewsResearchAgentRole = "main" | "pro" | "contra" | "main_summary";

export type NewsResearchPromptBinding = {
  role: NewsResearchAgentRole;
  perspective: "planner" | "supports_article" | "challenges_article" | "compares_perspectives";
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

type NewsResearchOutputHashes = {
  proPromptSha256: Sha256;
  contraPromptSha256: Sha256;
  proAnalysisSha256: Sha256;
  contraAnalysisSha256: Sha256;
  mainSummarySha256: Sha256;
  summaryAlgorithm: "mainAgentSummary/v1";
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

export type NewsResearchQueueJobStatus = "queued" | "running" | "succeeded" | "failed";

export type NewsResearchQueueError = {
  error: string;
  message: string;
  requestId: string;
  retryable: boolean;
  article?: NewsResearchArticle;
};

export type NewsResearchQueueJob = {
  id: string;
  requestId: string;
  articleUrl: string;
  status: NewsResearchQueueJobStatus;
  position: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: NewsResearchResponse | null;
  error: NewsResearchQueueError | null;
};

export type NewsResearchQueueSummary = {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  active: number;
  total: number;
  concurrency: number;
  maxJobs: number;
  storage: "memory" | "file";
};

export type NewsResearchQueueEnqueueResponse = {
  jobs: NewsResearchQueueJob[];
  queue: NewsResearchQueueSummary;
};

export type NewsResearchQueueListResponse = {
  jobs: NewsResearchQueueJob[];
  queue: NewsResearchQueueSummary;
};

export type ResearchHistoryEntry = {
  id: string;
  articleUrl: string;
  resolvedArticleUrl: string;
  normalizedArticleUrl: string;
  articleHost: string;
  manifestSha256: Sha256;
  articleContentSha256: Sha256 | null;
  fetchedAt: string | null;
  researchedAt: string;
  savedAt: string;
  updatedAt: string;
  byteLength: number;
  summaryPreview: string;
};

export type ResearchStorageInfo = {
  reportsPath: string;
  persistentDataPath: string;
  source: "research_storage_dir" | "user_persistent_data_path" | "eigen_default" | "local_dev";
  docsUrl: string;
};

export type ResearchHistoryResponse = {
  entries: ResearchHistoryEntry[];
  storage: ResearchStorageInfo;
};

export type StructuredModelOutput = {
  claims: StructuredClaim[];
  summary: string;
};
