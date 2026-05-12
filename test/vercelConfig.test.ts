import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

type Rewrite = {
  source?: string;
  destination?: string;
};

describe("vercel rewrites", () => {
  test("proxies nested research endpoints used by the browser history UI", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { rewrites?: Rewrite[] };
    const rewrites = config.rewrites ?? [];

    expect(rewrites).toContainEqual({
      source: "/research/:path*",
      destination: "http://35.204.200.15:3000/research/:path*",
    });
  });
});
