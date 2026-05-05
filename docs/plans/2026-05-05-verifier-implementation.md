# Verifier Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the manifest verifier so a saved `/synthesize` response can be independently checked for manifest integrity, signer authenticity, input drift, raw model-output integrity, deterministic merge reproducibility, and EigenCompute provenance.

**Architecture:** Keep verifier logic in `src/verifier/` and keep `scripts/verify-manifest.ts` as a thin CLI wrapper. Verification returns structured `CheckResult[]`; each check is independent and deterministic except explicitly-online provenance/input refetch checks. Use dependency injection for network fetchers so tests stay fast and do not depend on EigenCloud uptime.

**Tech Stack:** TypeScript, Vitest, Node `fetch`, existing hash/canonicalization/signature helpers, existing source fetcher, existing deterministic merger.

## Current State / Gaps

- `src/verifier/verify.ts` already verifies manifest hash, EVM signature, optional URL refetch, and merge replay from `response.raw`.
- Provenance is currently a hard skip even when `dashboardBase` is supplied.
- Merge verification can pass with incomplete or mismatched raw payloads because raw hashes, parsed claim counts, missing successful-model raw output, and extra raw output are not checked independently.
- CLI only supports `--refetch` and `--dashboard`; there is no strict mode to fail on skipped checks.
- README claims four independent verifier checks, but the implementation currently treats some checks as skipped/offline.

## Updates from installed `ecloud` skill

Use the installed `ecloud` skill/runbook for EigenCompute provenance assumptions and CLI behavior. Key implications for this plan:

- Prefer the `ecloud` CLI as the online provenance source instead of scraping the verify dashboard. The skill documents `ecloud compute build verify <image-digest-or-build-id-or-commit> --json` as the supported verifiable-build check.
- Use `ecloud compute app releases <app-id> --json --full` for release/image history. The skill notes this JSON schema includes `appId`, `imageDigest`, `registryUrl`, public/encrypted env metadata, and timestamps.
- Use hex app IDs (`0x...`) for all `ecloud` calls; name lookup is unreliable.
- Do not pass `--json` to `ecloud compute app info`; if agent-address verification needs live app info, parse plain text or keep it as saved evidence.
- Treat dashboard APIs as optional/future. The skill notes public runtime attestation is not fully surfaced externally yet; dashboard “Attestations” may be incomplete.

## Target Verifier Behavior

Checks to produce, in this order:

1. `schema` — response has a manifest, signature, and `raw` is `null` or an array.
2. `manifest_hash` — recompute hash with `manifestSha256: "sha256:"` placeholder.
3. `signature` — recover signer over `manifestSha256` and compare to `deployment.agentAddress`.
4. `raw_outputs` — if raw is present, verify one raw output per successful model, no extras, hash matches `ModelRun.rawOutputSha256`, and parsed claim count matches `ModelRun.parsedClaimCount`.
5. `inputs` — if enabled, refetch URL inputs and compare `contentSha256`.
6. `merge` — if raw is present and valid enough to parse, re-run deterministic merge and compare consensus/minority claims.
7. `provenance` — if enabled and environment is not `local`, check EigenCompute evidence from the `ecloud` CLI or a saved evidence JSON file and confirm the manifest's app id, image digest, commit SHA, release history, and agent address where available.

CLI pass modes:

- Default/offline mode: exits 1 on any `fail`, allows `skip` for online-only checks.
- `--strict`: exits 1 on any `fail` or `skip`.
- `--refetch`: enables URL input refetch.
- `--ecloud`: enables online provenance lookup by invoking `ecloud compute build verify` and `ecloud compute app releases`.
- `--provenance-json <path>` enables provenance verification from a saved CLI/dashboard fixture for offline review or environments without `ecloud` auth.
- `--dashboard <base>` is deferred unless a stable public JSON API is discovered; do not scrape rendered dashboard HTML in the verifier.

---

### Task 1: Add verifier fixtures and result helpers

**Files:**
- Modify: `test/verify.test.ts`
- Create: `test/helpers/verifierFixture.ts`
- Modify: `src/verifier/verify.ts`

**Step 1: Extract the good response fixture helper**

Move the repeated synthesis setup from `test/verify.test.ts` into `test/helpers/verifierFixture.ts`:

```ts
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runSynthesis, type RunSynthesisDeps } from "../../src/pipeline";
import type { SynthesizeResponse } from "../../src/types";

export const FIXED_TS = "2026-04-27T12:00:00.000Z";

export async function makeGoodResponse(): Promise<SynthesizeResponse> {
  const account = privateKeyToAccount(generatePrivateKey());
  const deps: RunSynthesisDeps = {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      text: `body of ${url}`,
      fetchedAt: FIXED_TS,
      byteLength: 16,
      error: null,
    }),
    callModel: async ({ provider, model }) => ({
      rawOutput: JSON.stringify({
        claims: [{ statement: "the sky is blue", supportingSourceIndices: [0] }],
        summary: `${provider}/${model}`,
      }),
      latencyMs: 5,
    }),
    now: () => FIXED_TS,
    deployment: {
      appId: "0xapp",
      agentAddress: account.address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "local",
    },
    sign: (h) => account.signMessage({ message: h }),
  };
  const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
  if (r.status !== "ok") throw new Error("setup: synthesis did not succeed");
  return { manifest: r.manifest, signature: r.signature, raw: r.raw };
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
```

**Step 2: Add strict-pass helper tests**

In `test/verify.test.ts`, add tests before implementation:

```ts
import { isAllPass, isStrictPass } from "../src/verifier/verify";

test("isAllPass allows skips but rejects failures", () => {
  expect(isAllPass([{ name: "x", status: "skip", detail: "offline" }])).toBe(true);
  expect(isAllPass([{ name: "x", status: "fail", detail: "bad" }])).toBe(false);
});

test("isStrictPass rejects skips and failures", () => {
  expect(isStrictPass([{ name: "x", status: "pass", detail: "ok" }])).toBe(true);
  expect(isStrictPass([{ name: "x", status: "skip", detail: "offline" }])).toBe(false);
  expect(isStrictPass([{ name: "x", status: "fail", detail: "bad" }])).toBe(false);
});
```

**Step 3: Run test to verify it fails**

Run:

```bash
npm test -- test/verify.test.ts
```

Expected: fail because `isStrictPass` is not exported.

**Step 4: Implement `isStrictPass`**

In `src/verifier/verify.ts`:

```ts
export function isStrictPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status === "pass");
}
```

Keep existing `isAllPass` semantics.

**Step 5: Run test to verify it passes**

Run:

```bash
npm test -- test/verify.test.ts
```

Expected: verifier tests pass.

**Step 6: Commit**

```bash
git add src/verifier/verify.ts test/verify.test.ts test/helpers/verifierFixture.ts
git commit -m "test: extract verifier fixtures and strict pass helper"
```

---

### Task 2: Add schema check and safe failure behavior

**Files:**
- Modify: `src/verifier/verify.ts`
- Modify: `test/verify.test.ts`

**Step 1: Write failing tests for malformed responses**

Add:

```ts
test("schema check fails instead of throwing on malformed response", async () => {
  const results = await verifyResponse({} as any);
  expect(results.find((r) => r.name === "schema")?.status).toBe("fail");
  expect(isAllPass(results)).toBe(false);
});

test("schema check passes for good response", async () => {
  const results = await verifyResponse(goodResponse);
  expect(results[0]).toMatchObject({ name: "schema", status: "pass" });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- test/verify.test.ts
```

Expected: first test throws because `verifyResponse` dereferences `response.manifest`.

**Step 3: Implement minimal schema guard**

In `src/verifier/verify.ts`, add:

```ts
function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object";
}

function checkSchema(response: unknown): CheckResult {
  if (!isRecord(response)) return { name: "schema", status: "fail", detail: "response is not an object" };
  if (!isRecord(response.manifest)) return { name: "schema", status: "fail", detail: "manifest missing or not an object" };
  if (typeof response.signature !== "string" || !response.signature.startsWith("0x")) {
    return { name: "schema", status: "fail", detail: "signature missing or invalid" };
  }
  if (response.raw !== null && !Array.isArray(response.raw)) {
    return { name: "schema", status: "fail", detail: "raw must be null or an array" };
  }
  return { name: "schema", status: "pass", detail: "response shape is valid" };
}
```

Update `verifyResponse`:

```ts
export async function verifyResponse(response: SynthesizeResponse, opts: VerifyOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const schema = checkSchema(response);
  out.push(schema);
  if (schema.status === "fail") return out;
  const m = response.manifest;
  // existing checks...
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- test/verify.test.ts
```

Expected: tests pass.

**Step 5: Commit**

```bash
git add src/verifier/verify.ts test/verify.test.ts
git commit -m "feat: add verifier schema check"
```

---

### Task 3: Verify raw model outputs before merge replay

**Files:**
- Modify: `src/verifier/verify.ts`
- Modify: `test/verify.test.ts`

**Step 1: Write failing tests for raw-output integrity**

Add tests:

```ts
test("raw_outputs fails when a successful model raw output is missing", async () => {
  const tampered = clone(goodResponse);
  tampered.raw = tampered.raw!.slice(1);
  const results = await verifyResponse(tampered);
  expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
});

test("raw_outputs fails when raw hash does not match manifest", async () => {
  const tampered = clone(goodResponse);
  tampered.raw![0].rawOutput = JSON.stringify({
    claims: [{ statement: "the sky is green", supportingSourceIndices: [0] }],
    summary: "changed",
  });
  const results = await verifyResponse(tampered);
  expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
});

test("raw_outputs fails on extra raw output from non-successful model", async () => {
  const tampered = clone(goodResponse);
  tampered.raw!.push({ provider: "extra", model: "bogus", rawOutput: "{}" });
  const results = await verifyResponse(tampered);
  expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- test/verify.test.ts
```

Expected: tests fail because `raw_outputs` check does not exist.

**Step 3: Implement `verifyRawOutputs`**

In `src/verifier/verify.ts`, import `sha256Hex`:

```ts
import { sha256OfBytes, sha256Hex } from "../lib/hash";
```

Add:

```ts
function verifyRawOutputs(m: SynthesizeResponse["manifest"], raw: SynthesizeResponse["raw"]): CheckResult {
  if (!raw) return { name: "raw_outputs", status: "skip", detail: "no raw outputs in response" };

  const okModels = m.models.filter((mm) => mm.status === "ok");
  const expectedKeys = new Set(okModels.map((mm) => providerModelKey(mm)));
  const rawByKey = new Map(raw.map((r) => [providerModelKey(r), r]));

  for (const r of raw) {
    const key = providerModelKey(r);
    if (!expectedKeys.has(key)) return { name: "raw_outputs", status: "fail", detail: `unexpected raw output for ${key}` };
  }

  for (const model of okModels) {
    const key = providerModelKey(model);
    const r = rawByKey.get(key);
    if (!r) return { name: "raw_outputs", status: "fail", detail: `missing raw output for ${key}` };
    const actualHash = sha256Hex(r.rawOutput);
    if (actualHash !== model.rawOutputSha256) {
      return { name: "raw_outputs", status: "fail", detail: `raw hash mismatch for ${key}` };
    }
    try {
      const parsed = parseStructuredOutput(r.rawOutput);
      if (parsed.claims.length !== model.parsedClaimCount) {
        return { name: "raw_outputs", status: "fail", detail: `parsed claim count mismatch for ${key}` };
      }
    } catch (e) {
      return { name: "raw_outputs", status: "fail", detail: `failed to parse raw output for ${key}: ${e instanceof Error ? e.message : e}` };
    }
  }

  return { name: "raw_outputs", status: "pass", detail: `${okModels.length} successful model raw outputs verified` };
}
```

Call it before `verifyMerge`:

```ts
out.push(verifyRawOutputs(m, response.raw));
out.push(verifyMerge(m, response.raw));
```

**Step 4: Run test to verify it passes**

```bash
npm test -- test/verify.test.ts
```

Expected: tests pass.

**Step 5: Commit**

```bash
git add src/verifier/verify.ts test/verify.test.ts
git commit -m "feat: verify raw model output integrity"
```

---

### Task 4: Make merge replay depend on complete verified raw outputs

**Files:**
- Modify: `src/verifier/verify.ts`
- Modify: `test/verify.test.ts`

**Step 1: Write failing test for raw=null strict behavior**

Add:

```ts
test("merge skips when raw outputs are omitted", async () => {
  const response = clone(goodResponse);
  response.raw = null;
  const results = await verifyResponse(response);
  expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("skip");
  expect(results.find((r) => r.name === "merge")?.status).toBe("skip");
  expect(isAllPass(results)).toBe(true);
  expect(isStrictPass(results)).toBe(false);
});
```

**Step 2: Run test**

```bash
npm test -- test/verify.test.ts
```

Expected: may already pass except for `raw_outputs`; keep this test as contract documentation.

**Step 3: Prevent misleading merge pass if raw is incomplete**

Change `verifyResponse` so the merge check can see the raw-output check result:

```ts
const rawCheck = verifyRawOutputs(m, response.raw);
out.push(rawCheck);
out.push(rawCheck.status === "fail" ? { name: "merge", status: "skip", detail: "raw_outputs failed" } : verifyMerge(m, response.raw));
```

This avoids duplicate/follow-on failures where merge parsing obscures the root raw-output issue.

**Step 4: Run tests**

```bash
npm test -- test/verify.test.ts
```

Expected: tests pass.

**Step 5: Commit**

```bash
git add src/verifier/verify.ts test/verify.test.ts
git commit -m "fix: gate merge replay on raw output verification"
```

---

### Task 5: Add provenance verification abstraction and fake-evidence tests

**Files:**
- Create: `src/verifier/provenance.ts`
- Modify: `src/verifier/verify.ts`
- Modify: `test/verify.test.ts`

**Step 1: Write failing tests using injected provenance evidence**

Extend `VerifyOptions` to accept a provenance checker; write tests first:

```ts
test("provenance passes when injected evidence matches deployment", async () => {
  const response = clone(goodResponse);
  response.manifest.deployment = {
    ...response.manifest.deployment,
    environment: "sepolia",
    appId: "0xabc",
    imageDigest: "sha256:image",
    commitSha: "commit123",
    agentAddress: response.manifest.deployment.agentAddress,
  };

  const results = await verifyResponse(response, {
    provenance: async () => ({
      appId: "0xabc",
      imageDigests: ["sha256:image"],
      commitShas: ["commit123"],
      derivedAddresses: [response.manifest.deployment.agentAddress],
    }),
  });

  expect(results.find((r) => r.name === "provenance")?.status).toBe("pass");
});

test("provenance fails when image digest is absent from evidence", async () => {
  const response = clone(goodResponse);
  response.manifest.deployment = {
    ...response.manifest.deployment,
    environment: "sepolia",
    appId: "0xabc",
    imageDigest: "sha256:expected",
    commitSha: "commit123",
  };

  const results = await verifyResponse(response, {
    provenance: async () => ({
      appId: "0xabc",
      imageDigests: ["sha256:other"],
      commitShas: ["commit123"],
      derivedAddresses: [response.manifest.deployment.agentAddress],
    }),
  });

  expect(results.find((r) => r.name === "provenance")?.status).toBe("fail");
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- test/verify.test.ts
```

Expected: fails because `VerifyOptions.provenance` does not exist and provenance still skips.

**Step 3: Create provenance types and matcher**

Create `src/verifier/provenance.ts`:

```ts
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
```

**Step 4: Wire into `verifyResponse`**

In `src/verifier/verify.ts`:

```ts
import { matchProvenance, type ProvenanceChecker } from "./provenance";

export type VerifyOptions = {
  refetchInputs?: boolean;
  fetchUrl?: (url: string) => Promise<FetchUrlResult>;
  dashboardBase?: string;
  provenance?: ProvenanceChecker;
};

async function verifyProvenance(m: SynthesizeResponse["manifest"], opts: VerifyOptions): Promise<CheckResult> {
  if (m.deployment.environment === "local") return { name: "provenance", status: "skip", detail: "local deployment" };
  if (!opts.provenance) return { name: "provenance", status: "skip", detail: "no provenance checker configured" };
  try {
    return matchProvenance(m.deployment, await opts.provenance(m.deployment));
  } catch (e) {
    return { name: "provenance", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}
```

Call at the end:

```ts
out.push(await verifyProvenance(m, opts));
```

**Step 5: Run tests**

```bash
npm test -- test/verify.test.ts
```

Expected: tests pass.

**Step 6: Commit**

```bash
git add src/verifier/verify.ts src/verifier/provenance.ts test/verify.test.ts
git commit -m "feat: add provenance evidence matcher"
```

---

### Task 6: Implement `ecloud` / saved-provenance adapters

**Files:**
- Modify: `src/verifier/provenance.ts`
- Modify: `scripts/verify-manifest.ts`
- Create: `test/provenance.test.ts`

**Step 1: Write failing tests for saved JSON extraction**

Create `test/provenance.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { evidenceFromUnknownJson } from "../src/verifier/provenance";

describe("provenance evidence extraction", () => {
  test("extracts evidence from app releases + build verify shaped JSON", () => {
    const evidence = evidenceFromUnknownJson({
      appId: "0xabc0000000000000000000000000000000000000",
      releases: [
        {
          imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          registryUrl: "docker.io/eigenlayer/eigencloud-containers@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      provenance: {
        commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
      appInfoText: "EVM Address: 0xdef0000000000000000000000000000000000000",
    });

    expect(evidence.appId.toLowerCase()).toBe("0xabc0000000000000000000000000000000000000");
    expect(evidence.imageDigests).toContain("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(evidence.commitShas).toContain("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(evidence.derivedAddresses.map((a) => a.toLowerCase())).toContain("0xdef0000000000000000000000000000000000000");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- test/provenance.test.ts
```

Expected: fail because `evidenceFromUnknownJson` does not exist.

**Step 3: Implement saved JSON extraction**

In `src/verifier/provenance.ts`, add an extractor that handles both explicit fields and nested CLI JSON:

```ts
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
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

  const explicit = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const appId = typeof explicit.appId === "string" ? explicit.appId : addresses[0] ?? "";

  return { appId, imageDigests, commitShas, derivedAddresses: addresses };
}
```

**Step 4: Implement an `ecloud` CLI checker**

Still in `src/verifier/provenance.ts`, add a checker factory. Use `child_process.execFile` (not shell) so arguments are safe and testable:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecFileLike = (file: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

export function makeEcloudProvenanceChecker(opts: { execFile?: ExecFileLike; timeoutMs?: number } = {}): ProvenanceChecker {
  const run = opts.execFile ?? ((file, args, runOpts) => execFileAsync(file, args, runOpts));
  const timeout = opts.timeoutMs ?? 30_000;

  return async (deployment) => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(deployment.appId)) throw new Error("ecloud_app_id_must_be_hex");

    const releases = await run("ecloud", ["compute", "app", "releases", deployment.appId, "--json", "--full"], { timeout });
    const verify = await run("ecloud", ["compute", "build", "verify", deployment.imageDigest, "--json"], { timeout });

    // `app info` has no --json per the ecloud skill. Parse text only for EVM Address when available.
    let appInfoText = "";
    try {
      const info = await run("ecloud", ["compute", "app", "info", deployment.appId], { timeout });
      appInfoText = info.stdout;
    } catch {
      // App info is useful but not mandatory for build provenance.
    }

    return evidenceFromUnknownJson({
      appId: deployment.appId,
      releases: JSON.parse(releases.stdout),
      buildVerify: JSON.parse(verify.stdout),
      appInfoText,
    });
  };
}
```

**Step 5: Write tests for `makeEcloudProvenanceChecker`**

Add to `test/provenance.test.ts`:

```ts
test("ecloud checker calls supported JSON commands with hex app id", async () => {
  const calls: string[][] = [];
  const checker = makeEcloudProvenanceChecker({
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes("releases")) {
        return { stdout: JSON.stringify({ releases: [{ imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }), stderr: "" };
      }
      if (args.includes("verify")) {
        return { stdout: JSON.stringify({ commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }), stderr: "" };
      }
      return { stdout: "EVM Address: 0xdef0000000000000000000000000000000000000", stderr: "" };
    },
  });

  const evidence = await checker({
    appId: "0xabc0000000000000000000000000000000000000",
    agentAddress: "0xdef0000000000000000000000000000000000000",
    imageDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    environment: "sepolia",
  });

  expect(calls).toContainEqual(["ecloud", "compute", "app", "releases", "0xabc0000000000000000000000000000000000000", "--json", "--full"]);
  expect(calls).toContainEqual(["ecloud", "compute", "build", "verify", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--json"]);
  expect(evidence.derivedAddresses.map((a) => a.toLowerCase())).toContain("0xdef0000000000000000000000000000000000000");
});
```

**Step 6: Wire CLI options**

In `scripts/verify-manifest.ts`, parse:

```ts
--strict
--ecloud
--provenance-json <path>
```

Create the checker:

```ts
const provenance = provenanceJsonPath
  ? async () => evidenceFromUnknownJson(JSON.parse(readFileSync(provenanceJsonPath, "utf8")))
  : useEcloud
    ? makeEcloudProvenanceChecker()
    : undefined;

const results = await verifyResponse(response, { refetchInputs: refetch, provenance });
```

Exit:

```ts
const ok = strict ? isStrictPass(results) : isAllPass(results);
```

**Step 7: Run tests**

```bash
npm test -- test/verify.test.ts test/provenance.test.ts
```

Expected: tests pass.

**Step 8: Commit**

```bash
git add src/verifier/provenance.ts scripts/verify-manifest.ts test/verify.test.ts test/provenance.test.ts
git commit -m "feat: add ecloud provenance adapters"
```

---


### Task 7: Add CLI integration tests

**Files:**
- Create: `test/verifyManifestCli.test.ts`
- Modify: `package.json` only if a helper script is desired

**Step 1: Write failing CLI tests**

Use a temp file and `node:child_process`:

```ts
import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeGoodResponse } from "./helpers/verifierFixture";

describe("verify-manifest CLI", () => {
  test("offline mode exits 0 for valid response with skipped online checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const responsePath = join(dir, "response.json");
    writeFileSync(responsePath, JSON.stringify(await makeGoodResponse()));

    const r = spawnSync("npx", ["tsx", "scripts/verify-manifest.ts", responsePath], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ALL RUNNABLE CHECKS PASSED");
  });

  test("strict mode exits 1 when online checks skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const responsePath = join(dir, "response.json");
    writeFileSync(responsePath, JSON.stringify(await makeGoodResponse()));

    const r = spawnSync("npx", ["tsx", "scripts/verify-manifest.ts", responsePath, "--strict"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("VERIFICATION FAILED");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- test/verifyManifestCli.test.ts
```

Expected: strict test fails until CLI supports `--strict`.

**Step 3: Implement missing CLI behavior from Task 6 if needed**

Ensure usage text says:

```txt
usage: verify-manifest.ts <response.json> [--refetch] [--ecloud] [--provenance-json <path>] [--strict]
```

**Step 4: Run CLI tests**

```bash
npm test -- test/verifyManifestCli.test.ts
```

Expected: tests pass.

**Step 5: Commit**

```bash
git add scripts/verify-manifest.ts test/verifyManifestCli.test.ts
git commit -m "test: cover manifest verifier CLI modes"
```

---

### Task 8: Update verifier documentation

**Files:**
- Modify: `README.md`
- Create: `docs/verifier.md`

**Step 1: Write docs that match actual behavior**

Update `README.md` Manifest verification section:

````md
## Manifest verification

Offline integrity/signature/merge check:

```bash
npx tsx scripts/verify-manifest.ts response.json
```

Full strict verification with URL refetch and EigenCompute provenance through the `ecloud` CLI:

```bash
npx tsx scripts/verify-manifest.ts response.json \
  --refetch \
  --ecloud \
  --strict
```

Use `?include=raw` when saving `/synthesize` responses if you want merge replay to pass in strict mode. Use `--provenance-json evidence.json` for offline review from saved `ecloud`/dashboard evidence.
````

Create `docs/verifier.md` covering:

- What each check proves.
- Which checks are offline vs online.
- Why raw model outputs are optional by default but required for strict merge replay.
- How `--ecloud` uses `ecloud compute build verify ... --json` and `ecloud compute app releases ... --json --full`.
- How `--provenance-json` should be generated/used when `ecloud` auth is unavailable.
- Why the verifier does not scrape dashboard HTML.
- Exit code semantics.

**Step 2: Run docs-adjacent smoke commands**

```bash
npm run typecheck
npm test -- test/verify.test.ts test/verifyManifestCli.test.ts
```

Expected: typecheck and tests pass.

**Step 3: Commit**

```bash
git add README.md docs/verifier.md
git commit -m "docs: document manifest verifier modes"
```

---

### Task 9: Full verification and cleanup

**Files:**
- Modify if needed: `.gitignore`

**Step 1: Run full verification**

```bash
npm run typecheck
npm test
npm run build
```

Expected:

- `npm run typecheck`: exit 0.
- `npm test`: all Vitest files pass. If run inside a restricted sandbox, local-port tests may fail with `EPERM listen`; rerun outside the sandbox because existing tests bind localhost.
- `npm run build`: exit 0.

**Step 2: Check git status**

```bash
git status -sb
```

Expected: only intended files modified. If `.omx/` is still untracked tooling state, add it to `.gitignore` in a separate cleanup commit:

```bash
echo ".omx/" >> .gitignore
git add .gitignore
git commit -m "chore: ignore omx workspace state"
```

**Step 3: Final commit if needed**

If any formatting/test cleanup changes remain:

```bash
git add <changed-files>
git commit -m "chore: finalize verifier implementation"
```

## Done Criteria

- `verifyResponse` never throws on malformed user input; it returns a `schema` failure.
- Good responses pass offline mode.
- Strict mode fails when raw outputs, provenance, or refetched inputs are unavailable.
- Raw outputs are independently checked against manifest hashes and parsed claim counts.
- Merge replay is reproduced only from verified raw outputs.
- Provenance check can pass from injected/fetched evidence and fails on image/commit/address mismatches.
- CLI exposes documented `--strict`, `--refetch`, `--dashboard`, and `--provenance-json` behavior.
- README and `docs/verifier.md` describe what is actually implemented.
- Fresh `npm run typecheck`, `npm test`, and `npm run build` pass in an environment allowed to bind localhost.
