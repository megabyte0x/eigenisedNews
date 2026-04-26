import { describe, test, expect } from "vitest";
import { consensus, type ConsensusInput } from "../src/merger/consensus";

const input = (claims: { pm: string; c: { statement: string; supportingSourceIndices: number[] }[] }[]): ConsensusInput =>
  claims.map(({ pm, c }) => ({ providerModel: pm, claims: c }));

describe("consensus", () => {
  test("empty input → empty output", () => {
    const out = consensus([]);
    expect(out.claims).toEqual([]);
    expect(out.minorityClaims).toEqual([]);
  });

  test("groups by normalized statement and picks lex-smallest canonical", () => {
    // ASCII: "T" (0x54) < "t" (0x74), so capitalized form is lex-smallest.
    const out = consensus(
      input([
        { pm: "openai/gpt-4o",               c: [{ statement: "The Sky is Blue.",       supportingSourceIndices: [0] }] },
        { pm: "anthropic/claude-sonnet-4-6", c: [{ statement: "the sky is blue",        supportingSourceIndices: [1] }] },
      ])
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].statement).toBe("The Sky is Blue.");
    expect(out.claims[0].supportingModels).toEqual(["anthropic/claude-sonnet-4-6", "openai/gpt-4o"]);
    expect(out.claims[0].supportingSourceIndices).toEqual([0, 1]);
    expect(out.claims[0].id).toBe("c0");
  });

  test("threshold = ceil(N/2); 1 of 4 is minority", () => {
    const out = consensus(
      input([
        { pm: "a/x", c: [{ statement: "alpha", supportingSourceIndices: [] }] },
        { pm: "b/x", c: [] },
        { pm: "c/x", c: [] },
        { pm: "d/x", c: [] },
      ])
    );
    expect(out.claims).toEqual([]);
    expect(out.minorityClaims).toHaveLength(1);
    expect(out.minorityClaims[0].id).toBe("m0");
    expect(out.minorityClaims[0].statement).toBe("alpha");
  });

  test("threshold edge: 2 of 3 is consensus (ceil(3/2)=2)", () => {
    const out = consensus(
      input([
        { pm: "a/x", c: [{ statement: "x", supportingSourceIndices: [0] }] },
        { pm: "b/x", c: [{ statement: "x", supportingSourceIndices: [1] }] },
        { pm: "c/x", c: [{ statement: "y", supportingSourceIndices: [2] }] },
      ])
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].statement).toBe("x");
    expect(out.minorityClaims).toHaveLength(1);
    expect(out.minorityClaims[0].statement).toBe("y");
  });

  test("single model, single claim → consensus (ceil(1/2)=1)", () => {
    const out = consensus(input([{ pm: "a/x", c: [{ statement: "solo", supportingSourceIndices: [] }] }]));
    expect(out.claims).toHaveLength(1);
    expect(out.minorityClaims).toEqual([]);
  });

  test("order-independent", () => {
    const a = input([
      { pm: "a/x", c: [{ statement: "x", supportingSourceIndices: [0] }] },
      { pm: "b/x", c: [{ statement: "y", supportingSourceIndices: [1] }] },
      { pm: "c/x", c: [{ statement: "x", supportingSourceIndices: [2] }] },
    ]);
    const b = [...a].reverse();
    expect(consensus(a)).toEqual(consensus(b));
  });

  test("supportingSourceIndices is union, sorted, deduped", () => {
    const out = consensus(
      input([
        { pm: "a/x", c: [{ statement: "x", supportingSourceIndices: [3, 1] }] },
        { pm: "b/x", c: [{ statement: "x", supportingSourceIndices: [1, 2] }] },
      ])
    );
    expect(out.claims[0].supportingSourceIndices).toEqual([1, 2, 3]);
  });

  test("supportingModels is sorted ascending", () => {
    const out = consensus(
      input([
        { pm: "z/m", c: [{ statement: "x", supportingSourceIndices: [] }] },
        { pm: "a/m", c: [{ statement: "x", supportingSourceIndices: [] }] },
        { pm: "m/m", c: [{ statement: "x", supportingSourceIndices: [] }] },
      ])
    );
    expect(out.claims[0].supportingModels).toEqual(["a/m", "m/m", "z/m"]);
  });

  test("id ordering: descending support count, then canonical statement ascending", () => {
    const out = consensus(
      input([
        { pm: "a/x", c: [{ statement: "high", supportingSourceIndices: [] }, { statement: "alpha", supportingSourceIndices: [] }] },
        { pm: "b/x", c: [{ statement: "high", supportingSourceIndices: [] }, { statement: "beta",  supportingSourceIndices: [] }] },
        { pm: "c/x", c: [{ statement: "high", supportingSourceIndices: [] }] },
      ])
    );
    // "high" supported by 3 → consensus c0
    expect(out.claims[0].id).toBe("c0");
    expect(out.claims[0].statement).toBe("high");
    // "alpha" and "beta" each supported by 1 → minority, ordered by statement asc
    expect(out.minorityClaims[0].id).toBe("m0");
    expect(out.minorityClaims[0].statement).toBe("alpha");
    expect(out.minorityClaims[1].id).toBe("m1");
    expect(out.minorityClaims[1].statement).toBe("beta");
  });
});
