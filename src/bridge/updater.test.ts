/* sparkEditor — tests for updater error classification */
import { describe, expect, it, vi } from "vitest";

vi.mock("@bridge/commands", () => ({ isTauri: false }));

import { classifyUpdaterError } from "./updater";

describe("classifyUpdaterError", () => {
  it("classifies 404 / not-found as no-release", () => {
    expect(classifyUpdaterError("error sending request: 404 Not Found")).toBe("no-release");
    expect(classifyUpdaterError("Could not fetch latest.json: not found")).toBe("no-release");
  });

  it("classifies the missing-platform error as no-platform", () => {
    const tauriMsg =
      'None of the fallback platforms `["linux-x86_64"]` were found in the response `platforms` object';
    expect(classifyUpdaterError(tauriMsg)).toBe("no-platform");
  });

  it("classifies platform-object variants as no-platform", () => {
    expect(classifyUpdaterError("platform `linux-x86_64` was not found in the response platforms object")).toBe(
      "no-platform",
    );
    expect(classifyUpdaterError("were found in the response platforms object")).toBe("no-platform");
  });

  it("classifies everything else as error", () => {
    expect(classifyUpdaterError("signature verification failed")).toBe("error");
    expect(classifyUpdaterError("network timeout")).toBe("error");
  });
});
