import { describe, expect, it } from "vitest";
import { proxyPackage } from "./index.js";

describe("@relayon/proxy", () => {
  it("is wired into the workspace", () => {
    expect(proxyPackage.name).toBe("@relayon/proxy");
  });
});
