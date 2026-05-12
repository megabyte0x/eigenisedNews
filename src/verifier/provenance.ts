import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUnknownRecord } from "../lib/guards";
import { parseUnknownJson } from "../lib/json";
import type { Manifest } from "../types";
import type { CheckResult } from "./types";

export type ProvenanceEvidence = {
  appId: string;
  imageDigests: string[];
  commitShas: string[];
  derivedAddresses: string[];
};

export type ProvenanceChecker = (deployment: Manifest["deployment"]) => Promise<ProvenanceEvidence>;
export type ExecFileLike = (file: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

const lower = (s: string) => s.toLowerCase();
const execFileAsync = promisify(execFile);

export function matchProvenance(deployment: Manifest["deployment"], evidence: ProvenanceEvidence): CheckResult {
  if (lower(evidence.appId) !== lower(deployment.appId)) {
    return { name: "provenance", status: "fail", detail: `appId mismatch: ${evidence.appId}` };
  }
  if (!evidence.imageDigests.map(lower).includes(lower(deployment.imageDigest))) {
    return { name: "provenance", status: "fail", detail: `imageDigest not found: ${deployment.imageDigest}` };
  }
  if (!evidence.commitShas.map(lower).includes(lower(deployment.commitSha))) {
    return { name: "provenance", status: "fail", detail: `commitSha not found: ${deployment.commitSha}` };
  }
  if (!evidence.derivedAddresses.map(lower).includes(lower(deployment.agentAddress))) {
    return { name: "provenance", status: "fail", detail: `agentAddress not found: ${deployment.agentAddress}` };
  }
  return { name: "provenance", status: "pass", detail: "deployment evidence matches manifest" };
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isUnknownRecord(value)) for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function evidenceFromUnknownJson(value: unknown): ProvenanceEvidence {
  const strings = collectStrings(value);
  const allText = strings.join("\n");
  const addresses = uniq([...allText.matchAll(/0x[a-fA-F0-9]{40}/g)].map((m) => m[0]));
  const imageDigests = uniq([...allText.matchAll(/sha256:[a-fA-F0-9]{64}/g)].map((m) => m[0].toLowerCase()));
  const commitShas = uniq([...allText.matchAll(/\b[a-fA-F0-9]{40}\b/g)].map((m) => m[0].toLowerCase()));

  const explicit = isUnknownRecord(value) ? value : {};
  const appId = typeof explicit.appId === "string" ? explicit.appId : addresses[0] ?? "";

  return { appId, imageDigests, commitShas, derivedAddresses: addresses };
}

export function makeEcloudProvenanceChecker(opts: { execFile?: ExecFileLike; timeoutMs?: number } = {}): ProvenanceChecker {
  const run =
    opts.execFile ??
    (async (file, args, runOpts) => {
      const { stdout, stderr } = await execFileAsync(file, args, { ...runOpts, encoding: "utf8" });
      return { stdout: String(stdout), stderr: String(stderr) };
    });
  const timeout = opts.timeoutMs ?? 30_000;

  return async (deployment) => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(deployment.appId)) throw new Error("ecloud_app_id_must_be_hex");

    const releases = await run("ecloud", ["compute", "app", "releases", deployment.appId, "--json", "--full"], { timeout });
    const verify = await run("ecloud", ["compute", "build", "verify", deployment.imageDigest, "--json"], { timeout });

    let appInfoText = "";
    try {
      const info = await run("ecloud", ["compute", "app", "info", deployment.appId], { timeout });
      appInfoText = info.stdout;
    } catch {
      // App info is useful but not mandatory for build provenance.
    }

    return evidenceFromUnknownJson({
      appId: deployment.appId,
      releases: parseUnknownJson(releases.stdout),
      buildVerify: parseUnknownJson(verify.stdout),
      appInfoText,
    });
  };
}
