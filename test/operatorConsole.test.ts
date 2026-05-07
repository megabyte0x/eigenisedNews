// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OperatorConsole } from "../src/frontend/OperatorConsole";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function setRuntimeConfig(config: { apiBaseUrl?: string }) {
  const script = document.createElement("script");
  script.id = "frontend-runtime-config";
  script.type = "application/json";
  script.textContent = JSON.stringify(config);
  document.body.appendChild(script);
}

function setRuntimeConfigText(text: string) {
  const script = document.createElement("script");
  script.id = "frontend-runtime-config";
  script.type = "application/json";
  script.textContent = text;
  document.body.appendChild(script);
}

describe("OperatorConsole", () => {
  test("blocks empty submissions before calling the API", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    render(React.createElement(OperatorConsole, { fetchImpl }));

    expect(screen.getByText((_, element) => element?.textContent === "2 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    expect(await screen.findByText(/enter a topic/i)).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("submits to /synthesize by default and renders the brief", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            deployment: {
              appId: "local",
              agentAddress: "0xabc",
              imageDigest: "sha256:img",
              commitSha: "abc",
              environment: "local",
            },
            request: { topic: "EigenLayer", requestHash: "sha256:req" },
            inputs: [],
            models: [
              {
                provider: "openai",
                model: "gpt-4o",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "ok",
                rawOutputSha256: "sha256:raw",
                parsedClaimCount: 1,
                error: null,
              },
            ],
            merge: {
              successfulModels: 1,
              totalModels: 1,
              thresholdMet: true,
              consensusThreshold: "ceil(1/1)=1",
              claims: [
                {
                  id: "c0",
                  statement: "EigenLayer launched a new release.",
                  supportingModels: ["openai/gpt-4o"],
                  supportingSourceIndices: [0],
                },
              ],
              minorityClaims: [],
            },
            brief: "Consensus claims:\n- EigenLayer launched a new release.\n\nMinority perspectives:\n(none)",
            briefSha256: "sha256:brief",
            timestamp: "2026-05-05T00:00:00.000Z",
            manifestSha256: "sha256:manifest",
          },
          signature: "0xsigned",
          raw: [{ provider: "openai", model: "gpt-4o", rawOutput: "{\"claims\":[]}" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/synthesize",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );
    });
    expect((await screen.findAllByText(/EigenLayer launched a new release\./i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/0xsigned/i)).toBeInTheDocument();
  });

  test("submits to /synthesize?include=raw when raw output is requested", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            deployment: {
              appId: "local",
              agentAddress: "0xabc",
              imageDigest: "sha256:img",
              commitSha: "abc",
              environment: "local",
            },
            request: { topic: "EigenLayer", requestHash: "sha256:req" },
            inputs: [],
            models: [
              {
                provider: "openai",
                model: "gpt-4o",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "ok",
                rawOutputSha256: "sha256:raw",
                parsedClaimCount: 1,
                error: null,
              },
            ],
            merge: {
              successfulModels: 1,
              totalModels: 1,
              thresholdMet: true,
              consensusThreshold: "ceil(1/1)=1",
              claims: [
                {
                  id: "c0",
                  statement: "EigenLayer launched a new release.",
                  supportingModels: ["openai/gpt-4o"],
                  supportingSourceIndices: [0],
                },
              ],
              minorityClaims: [],
            },
            brief: "Consensus claims:\n- EigenLayer launched a new release.\n\nMinority perspectives:\n(none)",
            briefSha256: "sha256:brief",
            timestamp: "2026-05-05T00:00:00.000Z",
            manifestSha256: "sha256:manifest",
          },
          signature: "0xsigned",
          raw: [{ provider: "openai", model: "gpt-4o", rawOutput: "{\"claims\":[]}" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByLabelText(/include raw model outputs/i));
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/synthesize?include=raw",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );
    });
    expect((await screen.findAllByText(/EigenLayer launched a new release\./i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/0xsigned/i)).toBeInTheDocument();
  });

  test("submits to the configured api base url with an absolute path", async () => {
    setRuntimeConfig({ apiBaseUrl: "https://api.example.com/v1" });

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            deployment: {
              appId: "local",
              agentAddress: "0xabc",
              imageDigest: "sha256:img",
              commitSha: "abc",
              environment: "local",
            },
            request: { topic: "EigenLayer", requestHash: "sha256:req" },
            inputs: [],
            models: [
              {
                provider: "openai",
                model: "gpt-4o",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "ok",
                rawOutputSha256: "sha256:raw",
                parsedClaimCount: 1,
                error: null,
              },
            ],
            merge: {
              successfulModels: 1,
              totalModels: 1,
              thresholdMet: true,
              consensusThreshold: "ceil(1/1)=1",
              claims: [
                {
                  id: "c0",
                  statement: "EigenLayer launched a new release.",
                  supportingModels: ["openai/gpt-4o"],
                  supportingSourceIndices: [0],
                },
              ],
              minorityClaims: [],
            },
            brief: "Consensus claims:\n- EigenLayer launched a new release.\n\nMinority perspectives:\n(none)",
            briefSha256: "sha256:brief",
            timestamp: "2026-05-05T00:00:00.000Z",
            manifestSha256: "sha256:manifest",
          },
          signature: "0xsigned",
          raw: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.example.com/v1/synthesize",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );
    });
  });

  test("submits absolute include=raw requests through the configured api base url", async () => {
    setRuntimeConfig({ apiBaseUrl: "http://34.30.150.229:3000" });

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            deployment: {
              appId: "local",
              agentAddress: "0xabc",
              imageDigest: "sha256:img",
              commitSha: "abc",
              environment: "local",
            },
            request: { topic: "EigenLayer", requestHash: "sha256:req" },
            inputs: [],
            models: [
              {
                provider: "openai",
                model: "gpt-4o",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "ok",
                rawOutputSha256: "sha256:raw",
                parsedClaimCount: 1,
                error: null,
              },
            ],
            merge: {
              successfulModels: 1,
              totalModels: 1,
              thresholdMet: true,
              consensusThreshold: "ceil(1/1)=1",
              claims: [
                {
                  id: "c0",
                  statement: "EigenLayer launched a new release.",
                  supportingModels: ["openai/gpt-4o"],
                  supportingSourceIndices: [0],
                },
              ],
              minorityClaims: [],
            },
            brief: "Consensus claims:\n- EigenLayer launched a new release.\n\nMinority perspectives:\n(none)",
            briefSha256: "sha256:brief",
            timestamp: "2026-05-05T00:00:00.000Z",
            manifestSha256: "sha256:manifest",
          },
          signature: "0xsigned",
          raw: [{ provider: "openai", model: "gpt-4o", rawOutput: "{\"claims\":[]}" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByLabelText(/include raw model outputs/i));
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://34.30.150.229:3000/synthesize?include=raw",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );
    });
  });

  test("falls back to same-origin synthesis when runtime config is malformed", async () => {
    setRuntimeConfigText("{not-json");

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            deployment: {
              appId: "local",
              agentAddress: "0xabc",
              imageDigest: "sha256:img",
              commitSha: "abc",
              environment: "local",
            },
            request: { topic: "EigenLayer", requestHash: "sha256:req" },
            inputs: [],
            models: [],
            merge: {
              successfulModels: 0,
              totalModels: 0,
              thresholdMet: false,
              consensusThreshold: "ceil(0/0)=0",
              claims: [],
              minorityClaims: [],
            },
            brief: "",
            briefSha256: "sha256:brief",
            timestamp: "2026-05-05T00:00:00.000Z",
            manifestSha256: "sha256:manifest",
          },
          signature: "0xpartial",
          raw: null,
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith(
        "/synthesize",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        })
      );
    });
  });

  test("renders partial manifest details when the API returns threshold failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "min_model_success_not_met",
          manifest: {
            schemaVersion: "1",
            rulesetVersion: "v1",
            deployment: {
              appId: "local",
              agentAddress: "0xabc",
              imageDigest: "sha256:img",
              commitSha: "abc",
              environment: "local",
            },
            request: { topic: "EigenLayer", requestHash: "sha256:req" },
            inputs: [],
            models: [
              {
                provider: "openai",
                model: "gpt-4o",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "ok",
                rawOutputSha256: "sha256:raw",
                parsedClaimCount: 0,
                error: null,
              },
              {
                provider: "google",
                model: "gemini-2.5-pro",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "error",
                rawOutputSha256: null,
                parsedClaimCount: 0,
                error: "timeout",
              },
              {
                provider: "anthropic",
                model: "claude-sonnet-4.6",
                version: "v1",
                promptHash: "sha256:prompt",
                status: "error",
                rawOutputSha256: null,
                parsedClaimCount: 0,
                error: "timeout",
              },
            ],
            merge: {
              successfulModels: 1,
              totalModels: 3,
              thresholdMet: false,
              consensusThreshold: "ceil(1/2)=1",
              claims: [],
              minorityClaims: [],
            },
            brief: "",
            briefSha256: "sha256:brief",
            timestamp: "2026-05-05T00:00:00.000Z",
            manifestSha256: "sha256:manifest",
          },
          signature: "0xpartial",
          raw: null,
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      )
    );

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    expect(await screen.findByText(/min_model_success_not_met/i)).toBeInTheDocument();
    expect(screen.getByText(/0xpartial/i)).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent === "Successful models: 1")
    ).toBeInTheDocument();
  });

  test("surfaces transport failures as an API error state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "EigenLayer" } });
    fireEvent.change(screen.getByLabelText(/source text/i), { target: { value: "Release notes text" } });
    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
  });
});
