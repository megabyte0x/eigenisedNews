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

const TEST_STORAGE_INFO = {
  reportsPath: "/tmp/eigenised-news-test/research-reports",
  persistentDataPath: "/tmp/eigenised-news-test",
  source: "local_dev",
  docsUrl: "https://docs.eigencloud.xyz/eigencompute/howto/build/persistent_storage",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function historyResponse(entries: unknown[] = []): unknown {
  return { entries, storage: TEST_STORAGE_INFO };
}

describe("NewsResearchApp", () => {
  test("renders the URL-first research flow", async () => {
    const researchResponse = {
          article: { url: "https://news.example/story", contentSha256: "sha256:article", fetchedAt: "2026-05-07T00:00:00.000Z", byteLength: 1200, error: null },
          proPrompt: "Support the article with market evidence.",
          contraPrompt: "Challenge the article with governance evidence.",
          proAnalysis: "- Revenue accelerated.\n- Stock reaction backed the article.",
          contraAnalysis: "- Insider-sale timing complicates the article.",
          mainSummary: "## Similarities\n\n- Both perspectives discuss the revenue acceleration.\n\n## Divergences\n\n- Pro trusts the market signal while contra flags insider-sale timing.\n\n## Bottom line\n\nThe article is directionally supported but needs governance caveats.",
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
            {
              role: "main_summary",
              perspective: "compares_perspectives",
              provider: "anthropic",
              model: "claude-sonnet-4.6",
              systemPrompt: "You are the main news research agent generating a final reader-facing summary.",
              systemPromptSha256: "sha256:summary-system",
              promptHash: "sha256:summary-full",
              articleUrl: "https://news.example/story",
              articleContentSha256: "sha256:article",
              researchPrompt: null,
            },
          ],
          verifiableBuild: {
            appId: "0xapp",
            agentAddress: "0xagent",
            imageDigest: "sha256:image",
            commitSha: "abc123",
            environment: "sepolia",
            dashboardUrl: "https://verify-sepolia.eigencloud.xyz/app/0xapp",
            promptSourcePath: "src/pipeline.ts",
            promptSourceUrl: "https://github.com/megabyte0x/eigenisedNews/blob/abc123/src/pipeline.ts",
          },
          agentRuns: [
            { role: "main", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:main-full", rawOutputSha256: "sha256:main-raw", error: null },
            { role: "pro", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:pro-full", rawOutputSha256: "sha256:pro-raw", error: null },
            { role: "contra", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:contra-full", rawOutputSha256: "sha256:contra-raw", error: null },
            { role: "main_summary", provider: "anthropic", model: "claude-sonnet-4.6", status: "ok", promptHash: "sha256:summary-full", rawOutputSha256: "sha256:summary", error: null },
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
              environment: "sepolia",
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
              summaryAlgorithm: "mainAgentSummary/v1",
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
              { role: "main_summary", provider: "anthropic", model: "claude-sonnet-4.6", prompt: "summary", rawOutput: "## Similarities\n\n- Both perspectives discuss the revenue acceleration.\n\n## Divergences\n\n- Pro trusts the market signal while contra flags insider-sale timing.\n\n## Bottom line\n\nThe article is directionally supported but needs governance caveats." },
            ],
            mainSummary: "## Similarities\n\n- Both perspectives discuss the revenue acceleration.\n\n## Divergences\n\n- Pro trusts the market signal while contra flags insider-sale timing.\n\n## Bottom line\n\nThe article is directionally supported but needs governance caveats.",
          },
        };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/verify")) {
        return jsonResponse({
          ok: true,
          mode: "browser",
          summary: { pass: 5, fail: 0, skip: 2, title: "Verified in browser", explanation: "No terminal or file download is required." },
          checks: [
            { name: "signature", label: "Agent signature", status: "pass", detail: "ok", meaning: "The manifest signature recovers the declared agent address." },
            { name: "research_raw", label: "Exact agent run", status: "pass", detail: "ok", meaning: "The exact planner, pro, contra, and summary prompts plus raw outputs match their hashes." },
          ],
        });
      }
      return url.includes("/research/history")
        ? jsonResponse(historyResponse())
        : jsonResponse(researchResponse);
    });

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
    expect(screen.getByText(/Main agent summary/i)).toBeInTheDocument();
    expect(screen.getByText(/Where the pro and contra takes meet/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /similarities/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /divergences/i })).toBeInTheDocument();
    expect(screen.getByText(/Research docket/i)).toBeInTheDocument();
    expect(screen.getByText(/One article\. Two adversarial readings\./i)).toBeInTheDocument();
    expect(screen.getByText(/source article/i)).toBeInTheDocument();
    expect(screen.getByText(/Source locked/i)).toBeInTheDocument();
    expect(screen.getByText(/What the proof means/i)).toBeInTheDocument();
    expect(screen.getByText(/Verification does not choose a winner/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Exact prompt sent to this agent/i)).not.toHaveLength(0);
    expect(screen.getByText(/No terminal command or file download needed/i)).toBeInTheDocument();
    expect(screen.getByText(/Supporting lens/i)).toBeInTheDocument();
    expect(screen.getByText(/Challenging lens/i)).toBeInTheDocument();
    expect(screen.getByText(/System prompts bound to the verifiable build/i)).toBeInTheDocument();
    expect(screen.getAllByText(/You are the pro news research agent/i)).not.toHaveLength(0);
    const verifyBuildLinks = screen.getAllByRole("link", { name: /verify build/i });
    expect(verifyBuildLinks[0]).toHaveAttribute("href", "https://verify-sepolia.eigencloud.xyz/app/0xapp");
    expect(verifyBuildLinks[0]).toHaveClass("build-strip__verify");
    expect(screen.getByRole("button", { name: /verify this result/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /verify research/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/npx tsx/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /verify this result/i }));
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/verify",
        expect.objectContaining({ method: "POST", headers: { "content-type": "application/json" } })
      );
    });
    expect(await screen.findByText(/Verified in browser/i)).toBeInTheDocument();
    expect(screen.getByText(/Exact agent run/i)).toBeInTheDocument();
  });

  test("opens a previously researched article from persistent history", async () => {
    const storedReport = {
      article: { url: "https://stored.example/report", contentSha256: "sha256:storedarticle", fetchedAt: "2026-05-08T00:00:00.000Z", byteLength: 900, error: null },
      proPrompt: "Support the stored report.",
      contraPrompt: "Challenge the stored report.",
      proAnalysis: "- Stored pro evidence is ready.",
      contraAnalysis: "- Stored contra evidence is ready.",
      mainSummary: "## Similarities\n\nStored pro evidence is ready.\n\n## Divergences\n\nStored contra evidence is ready.",
      promptBindings: [],
      verifiableBuild: {
        appId: "0xapp",
        agentAddress: "0xagent",
        imageDigest: "sha256:image",
        commitSha: "abc123",
        environment: "sepolia",
        dashboardUrl: "https://verify-sepolia.eigencloud.xyz/app/0xapp",
        promptSourcePath: "src/pipeline.ts",
        promptSourceUrl: "https://github.com/megabyte0x/eigenisedNews/blob/abc123/src/pipeline.ts",
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
          environment: "sepolia",
        },
        request: { articleUrl: "https://stored.example/report", requestHash: "sha256:request" },
        article: { url: "https://stored.example/report", contentSha256: "sha256:storedarticle", fetchedAt: "2026-05-08T00:00:00.000Z", byteLength: 900, error: null },
        promptBindings: [],
        agentRuns: [],
        outputs: {
          proPromptSha256: "sha256:pro-prompt",
          contraPromptSha256: "sha256:contra-prompt",
          proAnalysisSha256: "sha256:pro-raw",
          contraAnalysisSha256: "sha256:contra-raw",
          mainSummarySha256: "sha256:summary",
          summaryAlgorithm: "mainAgentSummary/v1",
        },
        timestamp: "2026-05-08T00:00:00.000Z",
        manifestSha256: "sha256:storedmanifest000000000000000000000000000000000000000000000000",
      },
      signature: "0xsigned",
      raw: null,
    };
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(`/research/history/${id}`)) return jsonResponse(storedReport);
      return jsonResponse(historyResponse([
        {
          id,
          articleUrl: "https://stored.example/report",
          resolvedArticleUrl: "https://stored.example/report",
          normalizedArticleUrl: "https://stored.example/report",
          articleHost: "stored.example",
          manifestSha256: "sha256:storedmanifest000000000000000000000000000000000000000000000000",
          articleContentSha256: "sha256:storedarticle",
          fetchedAt: "2026-05-08T00:00:00.000Z",
          researchedAt: "2026-05-08T00:00:00.000Z",
          savedAt: "2026-05-08T00:00:00.000Z",
          updatedAt: "2026-05-08T00:00:00.000Z",
          byteLength: 900,
          summaryPreview: "Stored pro evidence is ready.",
        },
      ]));
    });

    render(React.createElement(NewsResearchApp, { fetchImpl }));

    fireEvent.click(await screen.findByRole("button", { name: /stored\.example/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(`/research/history/${id}?include=raw`);
    });
    expect(await screen.findAllByText(/Stored pro evidence is ready/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/Stored contra evidence is ready/i)).not.toHaveLength(0);
  });

  test("surfaces structured API errors with request IDs", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("/research/history")) return jsonResponse(historyResponse());
      return jsonResponse({
          error: "research_agent_failed",
          message: "A research agent failed before both perspectives were completed.",
          requestId: "req-123",
          retryable: true,
        }, 502);
    });

    render(React.createElement(NewsResearchApp, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/news article url/i), { target: { value: "https://news.example/story" } });
    fireEvent.click(screen.getByRole("button", { name: /research both sides/i }));

    expect(await screen.findByText(/research_agent_failed/i)).toBeInTheDocument();
    expect(screen.getByText(/req-123/i)).toBeInTheDocument();
    expect(screen.getByText(/retryable/i)).toBeInTheDocument();
  });

  test("renders markdown emphasis in research output instead of raw markers", async () => {
    const researchResponse = {
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
            imageDigest: "unknown",
            commitSha: "unknown",
            environment: "mainnet-alpha",
            dashboardUrl: null,
            promptSourcePath: "src/pipeline.ts",
            promptSourceUrl: null,
          },
          agentRuns: [],
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            kind: "research",
            deployment: {
              appId: "0xapp",
              agentAddress: "0xagent",
              imageDigest: "unknown",
              commitSha: "unknown",
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
              summaryAlgorithm: "mainAgentSummary/v1",
            },
            timestamp: "2026-05-07T00:00:00.000Z",
            manifestSha256: "sha256:researchmanifest000000000000000000000000000000000000000000000000",
          },
          signature: "0xsigned",
          raw: null,
        };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => (
      String(input).includes("/research/history")
        ? jsonResponse(historyResponse())
        : jsonResponse(researchResponse)
    ));

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
    expect(screen.getAllByText(/Commit not provided/i)).not.toHaveLength(0);
    expect(screen.getAllByText(/Image not provided/i)).not.toHaveLength(0);
    expect(container.textContent).not.toContain("Commit unknown");
    expect(container.textContent).not.toContain("Image unknown");
    expect(container.textContent).not.toContain("**Price spike confirmed:**");
    expect(container.textContent).not.toContain("## Supporting Evidence");
  });

  test("does not expose the synthesis console from the research UI", () => {
    render(React.createElement(NewsResearchApp, { fetchImpl: vi.fn<typeof fetch>() }));

    expect(screen.queryByRole("button", { name: /open synthesis console/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /compose request/i })).not.toBeInTheDocument();
  });
});
