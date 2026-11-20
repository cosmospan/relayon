import { describe, expect, it } from "vitest";
import { cryptoPackage } from "./index.js";

describe("@relayon/crypto", () => {
  it("is wired into the workspace", () => {
    expect(cryptoPackage.name).toBe("@relayon/crypto");
  });
});
