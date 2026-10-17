import { describe, expect, it } from "vitest";
import { formatAppVersionLabel } from "../../src/renderer/src/components/app-version-label";

describe("formatAppVersionLabel", () => {
  it("shows the running build's version", () => {
    expect(formatAppVersionLabel("1.5.19")).toBe("v1.5.19");
    expect(formatAppVersionLabel("1.5.20")).toBe("v1.5.20");
  });

  it("keeps the prerelease tag so a beta build is visibly a beta", () => {
    // A beta runs against its own userData/port; hiding the tag would make it
    // look like stable while none of the stable projects are there.
    expect(formatAppVersionLabel("1.5.20-beta.0")).toBe("v1.5.20-beta.0");
  });

  it("tolerates a leading v without doubling it", () => {
    expect(formatAppVersionLabel("v1.5.19")).toBe("v1.5.19");
  });

  it("falls back to the neutral label instead of printing junk", () => {
    expect(formatAppVersionLabel("")).toBe("workspace");
    expect(formatAppVersionLabel(null)).toBe("workspace");
    expect(formatAppVersionLabel(undefined)).toBe("workspace");
    expect(formatAppVersionLabel("unknown")).toBe("workspace");
  });
});
