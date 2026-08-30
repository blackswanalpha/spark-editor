/* sparkEditor — tests for updater error classification */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bridge/commands", () => ({ isTauri: false }));

import {
  classifyUpdaterError,
  compareVersions,
  describeFailedInstall,
  verifyPendingUpdate,
} from "./updater";

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

describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    // "0.10.0" < "0.9.0" under string comparison — the trap this avoids.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.3.2", "0.3.10")).toBeLessThan(0);
  });

  it("treats equal versions as equal, with or without a v prefix", () => {
    expect(compareVersions("0.3.2", "0.3.2")).toBe(0);
    expect(compareVersions("v0.3.2", "0.3.2")).toBe(0);
  });

  it("pads missing components", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("sorts a pre-release below its release", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });
});

describe("describeFailedInstall", () => {
  it("names the actual remedy per install medium", () => {
    // Packaged builds all have a working installer, so the advice is
    // about why that installer did not finish — not "your format is
    // unsupported", which would be wrong for .deb and .rpm.
    expect(describeFailedInstall("deb")).toMatch(/dpkg/);
    expect(describeFailedInstall("rpm")).toMatch(/rpm/);
    expect(describeFailedInstall("appimage")).toMatch(/writable/);
    expect(describeFailedInstall("msi")).toMatch(/installer/);
    expect(describeFailedInstall("nsis")).toMatch(/installer/);
    expect(describeFailedInstall("app")).toMatch(/bundle/);
    expect(describeFailedInstall("unpackaged")).toMatch(/installer/);
    expect(describeFailedInstall("mystery")).toMatch(/Reinstall/);
  });
});

describe("verifyPendingUpdate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reports nothing when there is no receipt", async () => {
    expect(await verifyPendingUpdate()).toEqual({ status: "none" });
  });

  it("reports nothing when the runtime version is unavailable", async () => {
    // Outside Tauri getRuntimeVersion() returns null; a receipt cannot be
    // judged, so stay silent rather than cry wolf — and keep the receipt
    // for a boot that can answer.
    localStorage.setItem(
      "spark.update.pending",
      JSON.stringify({ from: "0.3.2", to: "0.3.3", at: "", installKind: "deb" }),
    );
    expect(await verifyPendingUpdate(async () => null)).toEqual({ status: "none" });
    expect(localStorage.getItem("spark.update.pending")).not.toBeNull();
  });

  it("reports 'applied' when the running version reached the promise", async () => {
    localStorage.setItem(
      "spark.update.pending",
      JSON.stringify({ from: "0.3.2", to: "0.3.3", at: "", installKind: "appimage" }),
    );
    const result = await verifyPendingUpdate(async () => "0.3.3");
    expect(result).toEqual({ status: "applied", version: "0.3.3" });
    // The receipt is consumed, so a later boot does not re-report it.
    expect(localStorage.getItem("spark.update.pending")).toBeNull();
  });

  it("treats a version newer than promised as applied", async () => {
    // Two updates in quick succession, or a manual reinstall past the
    // promised version, must not read as a failure.
    localStorage.setItem(
      "spark.update.pending",
      JSON.stringify({ from: "0.3.2", to: "0.3.3", at: "", installKind: "appimage" }),
    );
    expect(await verifyPendingUpdate(async () => "0.4.0")).toEqual({
      status: "applied",
      version: "0.4.0",
    });
  });

  it("reports 'not-applied' when still on the old version — the phantom-update case", async () => {
    localStorage.setItem(
      "spark.update.pending",
      JSON.stringify({ from: "0.3.2", to: "0.3.3", at: "", installKind: "deb" }),
    );
    expect(await verifyPendingUpdate(async () => "0.3.2")).toEqual({
      status: "not-applied",
      expected: "0.3.3",
      actual: "0.3.2",
      installKind: "deb",
    });
  });

  it("reports a failed install only once", async () => {
    localStorage.setItem(
      "spark.update.pending",
      JSON.stringify({ from: "0.3.2", to: "0.3.3", at: "", installKind: "deb" }),
    );
    expect((await verifyPendingUpdate(async () => "0.3.2")).status).toBe("not-applied");
    expect((await verifyPendingUpdate(async () => "0.3.2")).status).toBe("none");
  });

  it("clears a malformed receipt instead of throwing", async () => {
    localStorage.setItem("spark.update.pending", "{not json");
    expect(await verifyPendingUpdate()).toEqual({ status: "none" });
  });
});
