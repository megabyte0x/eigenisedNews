import type { Sha256 } from "./lib/hash";

export type SynthesizeRequest = {
  topic: string;
  urls?: string[];
  sources?: { title?: string; url?: string; text: string }[];
};

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

export type Claim = {
  id: string;
  statement: string;
  supportingModels: string[];
  supportingSourceIndices: number[];
};

export type Manifest = {
  schemaVersion: "1";
  rulesetVersion: string;
  deployment: {
    appId: string;
    agentAddress: string;
    imageDigest: string;
    commitSha: string;
    environment: "sepolia" | "mainnet-alpha" | "local";
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

export type SynthesizeResponse = {
  manifest: Manifest;
  signature: `0x${string}`;
  raw: { provider: string; model: string; rawOutput: string }[] | null;
};

export type StructuredModelOutput = {
  claims: { statement: string; supportingSourceIndices: number[] }[];
  summary: string;
};
