import type { Manifest } from "../types";
import type { CheckResult } from "./verify";

export type ProvenanceEvidence = {
  appId: string;
  imageDigests: string[];
  commitShas: string[];
  derivedAddresses: string[];
};

export type ProvenanceChecker = (deployment: Manifest["deployment"]) => Promise<ProvenanceEvidence>;

const lower = (s: string) => s.toLowerCase();

export function matchProvenance(deployment: Manifest["deployment"], evidence: ProvenanceEvidence): CheckResult {
  if (lower(evidence.appId) !== lower(deployment.appId)) {
    return { name: "provenance", status: "fail", detail: `appId mismatch: ${evidence.appId}` };
  }
  if (!evidence.imageDigests.includes(deployment.imageDigest)) {
    return { name: "provenance", status: "fail", detail: `imageDigest not found: ${deployment.imageDigest}` };
  }
  if (!evidence.commitShas.includes(deployment.commitSha)) {
    return { name: "provenance", status: "fail", detail: `commitSha not found: ${deployment.commitSha}` };
  }
  if (!evidence.derivedAddresses.map(lower).includes(lower(deployment.agentAddress))) {
    return { name: "provenance", status: "fail", detail: `agentAddress not found: ${deployment.agentAddress}` };
  }
  return { name: "provenance", status: "pass", detail: "deployment evidence matches manifest" };
}
