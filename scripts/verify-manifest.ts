/**
 * Standalone manifest verifier.
 *
 * Run:
 *   tsx scripts/verify-manifest.ts <path-to-saved-response.json> [--refetch] [--dashboard <base>]
 *
 * Exit codes:
 *   0 = all runnable checks passed
 *   1 = at least one check failed (or input parsing failed)
 */

import { readFileSync } from "node:fs";
import { verifyResponse, isAllPass } from "../src/verifier/verify";
import type { SynthesizeResponse } from "../src/types";

function parseArgs(argv: string[]): { path: string; refetch: boolean; dashboardBase?: string } {
  const positional: string[] = [];
  let refetch = false;
  let dashboardBase: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refetch") refetch = true;
    else if (a === "--dashboard") dashboardBase = argv[++i];
    else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error("usage: verify-manifest.ts <response.json> [--refetch] [--dashboard <base>]");
    process.exit(1);
  }
  return { path: positional[0], refetch, dashboardBase };
}

const { path, refetch, dashboardBase } = parseArgs(process.argv.slice(2));
let response: SynthesizeResponse;
try {
  response = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error("failed to read/parse response JSON:", e);
  process.exit(1);
}

const results = await verifyResponse(response, { refetchInputs: refetch, dashboardBase });

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
console.log(`\nVerification report for ${response.manifest.deployment.appId} (${response.manifest.deployment.environment})`);
console.log(`commit: ${response.manifest.deployment.commitSha}  image: ${response.manifest.deployment.imageDigest}`);
console.log("");
for (const r of results) {
  const sym = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "·";
  console.log(`${sym} ${pad(r.name, 18)} ${pad(r.status, 6)} ${r.detail}`);
}
console.log("");
if (isAllPass(results)) {
  console.log("ALL RUNNABLE CHECKS PASSED");
  process.exit(0);
} else {
  console.log("VERIFICATION FAILED");
  process.exit(1);
}
