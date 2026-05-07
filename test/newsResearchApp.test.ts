// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NewsResearchApp } from "../src/frontend/NewsResearchApp";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("NewsResearchApp", () => {
  test("renders the URL-first research flow", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-05-07T00:00:00.000Z" },
          proPrompt: "Support the article with market evidence.",
          contraPrompt: "Challenge the article with governance evidence.",
          proAnalysis: "For: revenue and stock reaction back the article.",
          contraAnalysis: "Against: insider-sale timing complicates the article.",
          agentRuns: [
            { role: "main", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok" },
            { role: "pro", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok" },
            { role: "contra", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(NewsResearchApp, { fetchImpl }));

    expect(screen.getByRole("heading", { name: /news article research/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/news article url/i), { target: { value: "https://news.example/story" } });
    fireEvent.click(screen.getByRole("button", { name: /research both sides/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/research",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ articleUrl: "https://news.example/story" }),
        })
      );
    });
    expect(await screen.findByText(/revenue and stock reaction/i)).toBeInTheDocument();
    expect(screen.getByText(/insider-sale timing/i)).toBeInTheDocument();
  });

  test("keeps the synthesis console available", () => {
    render(React.createElement(NewsResearchApp, { fetchImpl: vi.fn<typeof fetch>() }));

    fireEvent.click(screen.getByRole("button", { name: /open synthesis console/i }));

    expect(screen.getByRole("heading", { name: /compose request/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run synthesis/i })).toBeInTheDocument();
  });
});
