/**
 * Standalone manifest verifier.
 *
 * Run:
 *   tsx scripts/verify-manifest.ts <path-to-saved-response.json> [--refetch] [--ecloud] [--provenance-json <path>] [--strict]
 *
 * Exit codes:
 *   0 = all runnable checks passed
 *   1 = at least one check failed (or input parsing failed)
 */

import { readFileSync } from "node:fs";
import { isUnknownRecord, type UnknownRecord } from "../src/lib/guards";
import { verifyResponse, isAllPass, isStrictPass } from "../src/verifier/verify";
import { evidenceFromUnknownJson, makeEcloudProvenanceChecker } from "../src/verifier/provenance";

function usage(): string {
  return "usage: verify-manifest.ts <response.json> [--refetch] [--ecloud] [--provenance-json <path>] [--strict]";
}

function parseArgs(argv: string[]): { path: string; refetch: boolean; strict: boolean; useEcloud: boolean; provenanceJsonPath?: string } {
  const positional: string[] = [];
  let refetch = false;
  let strict = false;
  let useEcloud = false;
  let provenanceJsonPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refetch") refetch = true;
    else if (a === "--strict") strict = true;
    else if (a === "--ecloud") useEcloud = true;
    else if (a === "--provenance-json") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        console.error(usage());
        process.exit(1);
      }
      provenanceJsonPath = value;
    }
    else positional.push(a);
  }
  if (positional.length !== 1 || provenanceJsonPath === "") {
    console.error(usage());
    process.exit(1);
  }
  return { path: positional[0], refetch, strict, useEcloud, provenanceJsonPath };
}

const { path, refetch, strict, useEcloud, provenanceJsonPath } = parseArgs(process.argv.slice(2));
let response: unknown;
try {
  response = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error("failed to read/parse response JSON:", e);
  process.exit(1);
}

const provenance = provenanceJsonPath
  ? async () => evidenceFromUnknownJson(JSON.parse(readFileSync(provenanceJsonPath, "utf8")))
  : useEcloud
    ? makeEcloudProvenanceChecker()
    : undefined;

const results = await verifyResponse(response, { refetchInputs: refetch, provenance });
const summary = manifestSummary(response);

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
console.log(`\nVerification report for ${summary.appId} (${summary.environment})`);
console.log(`commit: ${summary.commitSha}  image: ${summary.imageDigest}`);
console.log("");
for (const r of results) {
  const sym = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "·";
  console.log(`${sym} ${pad(r.name, 18)} ${pad(r.status, 6)} ${r.detail}`);
}
console.log("");
const ok = strict ? isStrictPass(results) : isAllPass(results);
if (ok) {
  console.log("ALL RUNNABLE CHECKS PASSED");
  process.exit(0);
} else {
  console.log("VERIFICATION FAILED");
  process.exit(1);
}

function manifestSummary(value: unknown): { appId: string; environment: string; commitSha: string; imageDigest: string } {
  const manifest = isUnknownRecord(value) && isUnknownRecord(value.manifest) ? value.manifest : null;
  const deployment = manifest && isUnknownRecord(manifest.deployment) ? manifest.deployment : null;
  return {
    appId: stringField(deployment, "appId", "<invalid manifest>"),
    environment: stringField(deployment, "environment", "unknown"),
    commitSha: stringField(deployment, "commitSha", "unknown"),
    imageDigest: stringField(deployment, "imageDigest", "unknown"),
  };
}

function stringField(value: UnknownRecord | null, key: string, fallback: string): string {
  if (!value) return fallback;
  const field = value[key];
  return typeof field === "string" ? field : fallback;
}
