import { describe, test, expect } from "vitest";
import { POLICY } from "../src/lib/policy";

describe("POLICY", () => {
  test("is frozen at top level", () => {
    expect(Object.isFrozen(POLICY)).toBe(true);
  });
  test("MODEL_SET is deep-frozen (cannot mutate inner objects)", () => {
    expect(Object.isFrozen(POLICY.MODEL_SET)).toBe(true);
    expect(Object.isFrozen(POLICY.MODEL_SET[0])).toBe(true);
  });
  test("MIN_SUCCESS_COUNT equals floor(N/2)+1 of MODEL_SET", () => {
    const n = POLICY.MODEL_SET.length;
    expect(POLICY.MIN_SUCCESS_COUNT).toBe(Math.floor(n / 2) + 1);
  });
  test("MODEL_SET has 4 entries with required fields", () => {
    expect(POLICY.MODEL_SET).toHaveLength(4);
    for (const m of POLICY.MODEL_SET) {
      expect(m.provider).toBeTruthy();
      expect(m.model).toBeTruthy();
      expect(m.version).toBeTruthy();
    }
  });
  test("RULESET_VERSION and SCHEMA_VERSION are set", () => {
    expect(POLICY.RULESET_VERSION).toBe("v1");
    expect(POLICY.SCHEMA_VERSION).toBe("1");
  });
});
