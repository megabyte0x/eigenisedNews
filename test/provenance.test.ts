import { describe, expect, test } from "vitest";
import { evidenceFromUnknownJson, makeEcloudProvenanceChecker } from "../src/verifier/provenance";

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
});
