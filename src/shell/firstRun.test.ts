/* sparkEditor — tests for first-run flag helpers */
import { describe, expect, it, beforeEach } from "vitest";
import { isOnboarded, markOnboarded, resetOnboarding, shouldShowWelcome } from "./firstRun";

describe("firstRun", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reports not onboarded on a clean profile", () => {
    expect(isOnboarded()).toBe(false);
  });

  it("markOnboarded persists the flag", () => {
    markOnboarded();
    expect(isOnboarded()).toBe(true);
  });

  it("resetOnboarding clears the flag", () => {
    markOnboarded();
    resetOnboarding();
    expect(isOnboarded()).toBe(false);
  });

  it("shouldShowWelcome: true on a pristine first run", () => {
    expect(shouldShowWelcome({ recentsCount: 0, docsOpen: 0 })).toBe(true);
  });

  it("shouldShowWelcome: false once onboarded", () => {
    markOnboarded();
    expect(shouldShowWelcome({ recentsCount: 0, docsOpen: 0 })).toBe(false);
  });

  it("shouldShowWelcome: false when the user has recents or docs open", () => {
    expect(shouldShowWelcome({ recentsCount: 3, docsOpen: 0 })).toBe(false);
    expect(shouldShowWelcome({ recentsCount: 0, docsOpen: 2 })).toBe(false);
  });
});
