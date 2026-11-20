import { describe, expect, it } from "vitest";
import { undoPackage } from "./index.js";

describe("@relayon/undo", () => {
  it("is wired into the workspace", () => {
    expect(undoPackage.name).toBe("@relayon/undo");
  });
});
