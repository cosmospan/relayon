import { describe, expect, it } from "vitest";
import { policyPackage } from "./index.js";

describe("@relayon/policy", () => {
  it("is wired into the workspace", () => {
    expect(policyPackage.name).toBe("@relayon/policy");
  });
});
