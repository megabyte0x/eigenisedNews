import { describe, test, expect } from "vitest";
import { canonicalize } from "../src/lib/canonicalize";

const enc = (v: unknown) => new TextDecoder().decode(canonicalize(v));

describe("canonicalize", () => {
  test("primitives", () => {
    expect(enc(null)).toBe("null");
    expect(enc(true)).toBe("true");
    expect(enc(false)).toBe("false");
    expect(enc(0)).toBe("0");
    expect(enc(-0)).toBe("0");
    expect(enc(1.5)).toBe("1.5");
    expect(enc("hi")).toBe('"hi"');
  });
  test("rejects non-finite numbers", () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });
  test("string escapes", () => {
    expect(enc('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(enc("\n\t")).toBe('"\\u000a\\u0009"');
  });
  test("array order preserved, no whitespace", () => {
    expect(enc([3, 1, 2])).toBe("[3,1,2]");
  });
  test("object keys sorted lexicographically", () => {
    expect(enc({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });
  test("nested", () => {
    expect(enc({ z: [1, { y: 2, x: 1 }], a: null })).toBe('{"a":null,"z":[1,{"x":1,"y":2}]}');
  });
  test("undefined is rejected", () => {
    expect(() => canonicalize(undefined as any)).toThrow();
    expect(() => canonicalize({ a: undefined } as any)).toThrow();
  });
});
