// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OperatorConsole } from "../src/frontend/OperatorConsole";

afterEach(() => {
  cleanup();
});

describe("OperatorConsole", () => {
  test("blocks empty submissions before calling the API", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    render(React.createElement(OperatorConsole, { fetchImpl }));

    fireEvent.click(screen.getByRole("button", { name: /run synthesis/i }));

    expect(await screen.findByText(/enter a topic/i)).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("submits to /synthesize with include=raw and renders the brief", async () => {
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
            ],
            merge: {
              successfulModels: 2,
              totalModels: 4,
              thresholdMet: false,
              consensusThreshold: "ceil(2/2)=1",
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
      screen.getByText((_, element) => element?.textContent === "Successful models: 2")
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
