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
            { role: "main", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:main-full", rawOutputSha256: "sha256:main-raw", error: null },
            { role: "pro", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:pro-full", rawOutputSha256: "sha256:pro-raw", error: null },
            { role: "contra", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:contra-full", rawOutputSha256: "sha256:contra-raw", error: null },
          ],
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            kind: "research",
            deployment: {
              appId: "0xapp",
              agentAddress: "0xagent",
              imageDigest: "sha256:image",
              commitSha: "abc123",
              environment: "mainnet-alpha",
            },
            request: { articleUrl: "https://news.example/story", requestHash: "sha256:request" },
            article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-05-07T00:00:00.000Z", byteLength: 1200, error: null },
            promptBindings: [],
            agentRuns: [],
            outputs: {
              proPromptSha256: "sha256:pro-prompt",
              contraPromptSha256: "sha256:contra-prompt",
              proAnalysisSha256: "sha256:pro-raw",
              contraAnalysisSha256: "sha256:contra-raw",
              mainSummarySha256: "sha256:summary",
              summaryAlgorithm: "composeResearchSummary/v1",
            },
            timestamp: "2026-05-07T00:00:00.000Z",
            manifestSha256: "sha256:researchmanifest000000000000000000000000000000000000000000000000",
          },
          signature: "0xsigned",
          raw: {
            agentOutputs: [
              { role: "main", provider: "anthropic", model: "claude-sonnet-4.6", prompt: "planner", rawOutput: "{}" },
              { role: "pro", provider: "anthropic", model: "claude-sonnet-4.6", prompt: "pro", rawOutput: "- Revenue accelerated." },
              { role: "contra", provider: "anthropic", model: "claude-sonnet-4.6", prompt: "contra", rawOutput: "- Insider-sale timing complicates the article." },
            ],
            mainSummary: "For the article:\n- Revenue accelerated.\n\nAgainst the article:\n- Insider-sale timing complicates the article.",
          },
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
        "/research?include=raw",
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
    expect(screen.getByRole("link", { name: /verify research/i })).toHaveAttribute("download", expect.stringMatching(/^research-/));
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

  test("renders markdown emphasis in research output instead of raw markers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-05-07T00:00:00.000Z", byteLength: 1200, error: null },
          proPrompt: "Support the article.",
          contraPrompt: "Challenge the article.",
          proAnalysis: "## Supporting Evidence\n\n- **Price spike confirmed:** Brent rose **3%**.\n\n---\n\n**Verdict:** Material disruption.",
          contraAnalysis: "- **Negotiations are ongoing:** Talks complicate the framing.",
          mainSummary: "",
          promptBindings: [],
          verifiableBuild: {
            appId: "0xapp",
            agentAddress: "0xagent",
            imageDigest: "sha256:image",
            commitSha: "abc123",
            environment: "mainnet-alpha",
            promptSourcePath: "src/pipeline.ts",
          },
          agentRuns: [],
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            kind: "research",
            deployment: {
              appId: "0xapp",
              agentAddress: "0xagent",
              imageDigest: "sha256:image",
              commitSha: "abc123",
              environment: "mainnet-alpha",
            },
            request: { articleUrl: "https://news.example/story", requestHash: "sha256:request" },
            article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-05-07T00:00:00.000Z", byteLength: 1200, error: null },
            promptBindings: [],
            agentRuns: [],
            outputs: {
              proPromptSha256: "sha256:pro-prompt",
              contraPromptSha256: "sha256:contra-prompt",
              proAnalysisSha256: "sha256:pro-raw",
              contraAnalysisSha256: "sha256:contra-raw",
              mainSummarySha256: "sha256:summary",
              summaryAlgorithm: "composeResearchSummary/v1",
            },
            timestamp: "2026-05-07T00:00:00.000Z",
            manifestSha256: "sha256:researchmanifest000000000000000000000000000000000000000000000000",
          },
          signature: "0xsigned",
          raw: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const { container } = render(React.createElement(NewsResearchApp, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/news article url/i), { target: { value: "https://news.example/story" } });
    fireEvent.click(screen.getByRole("button", { name: /research both sides/i }));

    expect(await screen.findByRole("heading", { name: /supporting evidence/i })).toBeInTheDocument();
    const strongLabels = Array.from(container.querySelectorAll(".reading-block strong")).map((node) => node.textContent);
    expect(strongLabels).toContain("Price spike confirmed:");
    expect(strongLabels).toContain("3%");
    expect(strongLabels).toContain("Verdict:");
    expect(strongLabels).toContain("Negotiations are ongoing:");
    expect(container.querySelector(".reading-block__divider")).toBeInTheDocument();
    expect(container.textContent).not.toContain("**Price spike confirmed:**");
    expect(container.textContent).not.toContain("## Supporting Evidence");
  });

  test("does not expose the synthesis console from the research UI", () => {
    render(React.createElement(NewsResearchApp, { fetchImpl: vi.fn<typeof fetch>() }));

    expect(screen.queryByRole("button", { name: /open synthesis console/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /compose request/i })).not.toBeInTheDocument();
  });
});
