import { describe, expect, it } from "vitest";
import { dbPackage } from "./index.js";

describe("@relayon/db", () => {
  it("is wired into the workspace", () => {
    expect(dbPackage.name).toBe("@relayon/db");
  });
});
