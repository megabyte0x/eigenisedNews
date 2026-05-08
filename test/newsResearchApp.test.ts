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
          article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-05-07T00:00:00.000Z", byteLength: 1200, error: null },
          proPrompt: "Support the article with market evidence.",
          contraPrompt: "Challenge the article with governance evidence.",
          proAnalysis: "- Revenue accelerated.\n- Stock reaction backed the article.",
          contraAnalysis: "- Insider-sale timing complicates the article.",
          mainSummary: "For the article:\n- Revenue accelerated.\n\nAgainst the article:\n- Insider-sale timing complicates the article.",
          promptBindings: [
            {
              role: "main",
              perspective: "planner",
              provider: "anthropic",
              model: "claude-sonnet-4.6",
              systemPrompt: "You are the main news research agent for eigenisedNews.",
              systemPromptSha256: "sha256:main",
              promptHash: "sha256:main-full",
              articleUrl: "https://news.example/story",
              articleContentSha256: "sha256:article",
              researchPrompt: null,
            },
            {
              role: "pro",
              perspective: "supports_article",
              provider: "anthropic",
              model: "claude-sonnet-4.6",
              systemPrompt: "You are the pro news research agent.",
              systemPromptSha256: "sha256:pro",
              promptHash: "sha256:pro-full",
              articleUrl: "https://news.example/story",
              articleContentSha256: "sha256:article",
              researchPrompt: "Support the article with market evidence.",
            },
            {
              role: "contra",
              perspective: "challenges_article",
              provider: "anthropic",
              model: "claude-sonnet-4.6",
              systemPrompt: "You are the contra news research agent.",
              systemPromptSha256: "sha256:contra",
              promptHash: "sha256:contra-full",
              articleUrl: "https://news.example/story",
              articleContentSha256: "sha256:article",
              researchPrompt: "Challenge the article with governance evidence.",
            },
          ],
          verifiableBuild: {
            appId: "0xapp",
            agentAddress: "0xagent",
            imageDigest: "sha256:image",
            commitSha: "abc123",
            environment: "mainnet-alpha",
            dashboardUrl: "https://verify.eigencloud.xyz/app/0xapp",
            promptSourcePath: "src/pipeline.ts",
            promptSourceUrl: "https://github.com/megabyte0x/eigenisedNews/blob/abc123/src/pipeline.ts",
          },
          agentRuns: [
            { role: "main", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:main-full" },
            { role: "pro", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:pro-full" },
            { role: "contra", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:contra-full" },
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
    expect(await screen.findAllByText(/Revenue accelerated/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/insider-sale timing/i)).not.toHaveLength(0);
    expect(screen.getByText(/Research docket/i)).toBeInTheDocument();
    expect(screen.getByText(/One article\. Two adversarial readings\./i)).toBeInTheDocument();
    expect(screen.getByText(/source article/i)).toBeInTheDocument();
    expect(screen.getByText(/Source locked/i)).toBeInTheDocument();
    expect(screen.getByText(/Supporting lens/i)).toBeInTheDocument();
    expect(screen.getByText(/Challenging lens/i)).toBeInTheDocument();
    expect(screen.getByText(/System prompts bound to the verifiable build/i)).toBeInTheDocument();
    expect(screen.getAllByText(/You are the pro news research agent/i)).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: /verify build/i })).toHaveAttribute("href", "https://verify.eigencloud.xyz/app/0xapp");
  });

  test("surfaces structured API errors with request IDs", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "research_agent_failed",
          message: "A research agent failed before both perspectives were completed.",
          requestId: "req-123",
          retryable: true,
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(NewsResearchApp, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/news article url/i), { target: { value: "https://news.example/story" } });
    fireEvent.click(screen.getByRole("button", { name: /research both sides/i }));

    expect(await screen.findByText(/research_agent_failed/i)).toBeInTheDocument();
    expect(screen.getByText(/req-123/i)).toBeInTheDocument();
    expect(screen.getByText(/retryable/i)).toBeInTheDocument();
  });

  test("keeps the synthesis console available", () => {
    render(React.createElement(NewsResearchApp, { fetchImpl: vi.fn<typeof fetch>() }));

    fireEvent.click(screen.getByRole("button", { name: /open synthesis console/i }));

    expect(screen.getByRole("heading", { name: /compose request/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run synthesis/i })).toBeInTheDocument();
  });
});
