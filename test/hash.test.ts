import { describe, test, expect } from "vitest";
import { sha256Hex, sha256OfBytes } from "../src/lib/hash";

describe("sha256Hex", () => {
  test("matches known vector for empty string", () => {
    expect(sha256Hex("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  test("matches known vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("sha256OfBytes accepts Uint8Array", () => {
    expect(sha256OfBytes(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
