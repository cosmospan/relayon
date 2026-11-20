import { describe, expect, it } from "vitest";
import { sdkPackage } from "./index.js";

describe("@relayon/sdk", () => {
  it("is wired into the workspace", () => {
    expect(sdkPackage.name).toBe("@relayon/sdk");
  });
});
