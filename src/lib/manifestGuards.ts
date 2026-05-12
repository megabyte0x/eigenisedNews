import type {
  InputRecord,
  Manifest,
  ModelRun,
  NewsResearchAgentRole,
  NewsResearchAgentRun,
  NewsResearchManifest,
  NewsResearchPromptBinding,
  NewsResearchRaw,
  NewsResearchRawAgentOutput,
  NewsResearchResponse,
  RawModelOutput,
  SynthesizeResponse,
} from "../types";
import { isUnknownRecord, type UnknownRecord } from "./guards";

export function isHexSignature(value: unknown): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x");
}

export function isSynthesizeResponse(value: unknown): value is SynthesizeResponse {
  return (
    isUnknownRecord(value) &&
    isManifest(value.manifest) &&
    isHexSignature(value.signature) &&
    (value.raw === null || (Array.isArray(value.raw) && value.raw.every(isRawModelOutput)))
  );
}

export function isNewsResearchResponse(value: unknown): value is NewsResearchResponse {
  return (
    isUnknownRecord(value) &&
    isNewsResearchResponseBody(value) &&
    isResearchManifest(value.manifest) &&
    isHexSignature(value.signature) &&
    (value.raw === null || isNewsResearchRaw(value.raw))
  );
}

export function isManifest(value: unknown): value is Manifest {
  if (!isUnknownRecord(value)) return false;
  return (
    value.schemaVersion === "1" &&
    typeof value.rulesetVersion === "string" &&
    isDeployment(value.deployment) &&
    isRequestRecord(value.request) &&
    Array.isArray(value.inputs) &&
    value.inputs.every(isInputRecord) &&
    Array.isArray(value.models) &&
    value.models.every(isModelRun) &&
    isMerge(value.merge) &&
    typeof value.brief === "string" &&
    typeof value.briefSha256 === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.manifestSha256 === "string"
  );
}

export function isResearchManifest(value: unknown): value is NewsResearchManifest {
  if (!isUnknownRecord(value)) return false;
  return (
    value.schemaVersion === "1" &&
    typeof value.rulesetVersion === "string" &&
    value.kind === "research" &&
    isDeployment(value.deployment) &&
    isResearchRequestRecord(value.request) &&
    isNewsResearchArticle(value.article) &&
    Array.isArray(value.promptBindings) &&
    value.promptBindings.every(isNewsResearchPromptBinding) &&
    Array.isArray(value.agentRuns) &&
    value.agentRuns.every(isNewsResearchAgentRun) &&
    isNewsResearchOutputHashes(value.outputs) &&
    typeof value.timestamp === "string" &&
    typeof value.manifestSha256 === "string"
  );
}

function isDeployment(value: unknown): value is Manifest["deployment"] {
  return (
    isUnknownRecord(value) &&
    typeof value.appId === "string" &&
    typeof value.agentAddress === "string" &&
    typeof value.imageDigest === "string" &&
    typeof value.commitSha === "string" &&
    isDeploymentEnvironment(value.environment)
  );
}

export function isNewsResearchRaw(value: unknown): value is NewsResearchRaw {
  return (
    isUnknownRecord(value) &&
    Array.isArray(value.agentOutputs) &&
    value.agentOutputs.every(isNewsResearchRawAgentOutput) &&
    typeof value.mainSummary === "string"
  );
}

export function isRawModelOutput(value: unknown): value is RawModelOutput {
  return isUnknownRecord(value) && typeof value.provider === "string" && typeof value.model === "string" && typeof value.rawOutput === "string";
}

function isDeploymentEnvironment(value: unknown): value is Manifest["deployment"]["environment"] {
  return value === "mainnet-alpha" || value === "local";
}

function isRequestRecord(value: unknown): value is Manifest["request"] {
  return isUnknownRecord(value) && typeof value.topic === "string" && typeof value.requestHash === "string";
}

function isResearchRequestRecord(value: unknown): value is NewsResearchManifest["request"] {
  return isUnknownRecord(value) && typeof value.articleUrl === "string" && typeof value.requestHash === "string";
}

function isInputRecord(value: unknown): value is InputRecord {
  return (
    isUnknownRecord(value) &&
    typeof value.index === "number" &&
    (value.kind === "url" || value.kind === "text") &&
    optionalString(value, "url") &&
    (typeof value.contentSha256 === "string" || value.contentSha256 === null) &&
    optionalString(value, "fetchedAt") &&
    typeof value.byteLength === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchResponseBody(value: UnknownRecord): value is UnknownRecord & Omit<NewsResearchResponse, "manifest" | "signature" | "raw"> {
  return (
    isNewsResearchArticle(value.article) &&
    typeof value.proPrompt === "string" &&
    typeof value.contraPrompt === "string" &&
    typeof value.proAnalysis === "string" &&
    typeof value.contraAnalysis === "string" &&
    typeof value.mainSummary === "string" &&
    Array.isArray(value.promptBindings) &&
    value.promptBindings.every(isNewsResearchPromptBinding) &&
    isNewsResearchVerifiableBuild(value.verifiableBuild) &&
    Array.isArray(value.agentRuns) &&
    value.agentRuns.every(isNewsResearchAgentRun)
  );
}

function isNewsResearchArticle(value: unknown): value is NewsResearchResponse["article"] {
  return (
    isUnknownRecord(value) &&
    typeof value.url === "string" &&
    (typeof value.contentSha256 === "string" || value.contentSha256 === null) &&
    optionalString(value, "fetchedAt") &&
    typeof value.byteLength === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchPromptBinding(value: unknown): value is NewsResearchPromptBinding {
  return (
    isUnknownRecord(value) &&
    isNewsResearchAgentRole(value.role) &&
    (value.perspective === "planner" || value.perspective === "supports_article" || value.perspective === "challenges_article") &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.systemPrompt === "string" &&
    typeof value.systemPromptSha256 === "string" &&
    typeof value.promptHash === "string" &&
    typeof value.articleUrl === "string" &&
    (typeof value.articleContentSha256 === "string" || value.articleContentSha256 === null) &&
    (typeof value.researchPrompt === "string" || value.researchPrompt === null)
  );
}

function isNewsResearchAgentRun(value: unknown): value is NewsResearchAgentRun {
  return (
    isUnknownRecord(value) &&
    isNewsResearchAgentRole(value.role) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    (value.status === "ok" || value.status === "error") &&
    typeof value.promptHash === "string" &&
    (typeof value.rawOutputSha256 === "string" || value.rawOutputSha256 === null) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchVerifiableBuild(value: unknown): value is NewsResearchResponse["verifiableBuild"] {
  if (!isUnknownRecord(value)) return false;
  const record = value;
  return (
    isDeployment(value) &&
    (typeof record.dashboardUrl === "string" || record.dashboardUrl === null) &&
    typeof record.promptSourcePath === "string" &&
    (typeof record.promptSourceUrl === "string" || record.promptSourceUrl === null)
  );
}

function isNewsResearchOutputHashes(value: unknown): value is NewsResearchManifest["outputs"] {
  return (
    isUnknownRecord(value) &&
    typeof value.proPromptSha256 === "string" &&
    typeof value.contraPromptSha256 === "string" &&
    typeof value.proAnalysisSha256 === "string" &&
    typeof value.contraAnalysisSha256 === "string" &&
    typeof value.mainSummarySha256 === "string" &&
    value.summaryAlgorithm === "composeResearchSummary/v1"
  );
}

function isNewsResearchRawAgentOutput(value: unknown): value is NewsResearchRawAgentOutput {
  return (
    isUnknownRecord(value) &&
    isNewsResearchAgentRole(value.role) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.prompt === "string" &&
    typeof value.rawOutput === "string"
  );
}

function isNewsResearchAgentRole(value: unknown): value is NewsResearchAgentRole {
  return value === "main" || value === "pro" || value === "contra";
}

function isModelRun(value: unknown): value is ModelRun {
  return (
    isUnknownRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.version === "string" &&
    typeof value.promptHash === "string" &&
    (value.status === "ok" || value.status === "error") &&
    (typeof value.rawOutputSha256 === "string" || value.rawOutputSha256 === null) &&
    typeof value.parsedClaimCount === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isMerge(value: unknown): value is Manifest["merge"] {
  return (
    isUnknownRecord(value) &&
    typeof value.successfulModels === "number" &&
    typeof value.totalModels === "number" &&
    typeof value.thresholdMet === "boolean" &&
    typeof value.consensusThreshold === "string" &&
    Array.isArray(value.claims) &&
    value.claims.every(isClaim) &&
    Array.isArray(value.minorityClaims) &&
    value.minorityClaims.every(isClaim)
  );
}

function isClaim(value: unknown): value is Manifest["merge"]["claims"][number] {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    typeof value.statement === "string" &&
    stringArray(value.supportingModels) &&
    numberArray(value.supportingSourceIndices)
  );
}

function optionalString(value: UnknownRecord, key: string): boolean {
  return !(key in value) || value[key] === undefined || typeof value[key] === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function numberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}
