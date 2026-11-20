import { describe, expect, it } from "vitest";
import { ledgerPackage } from "./index.js";

describe("@relayon/ledger", () => {
  it("is wired into the workspace", () => {
    expect(ledgerPackage.name).toBe("@relayon/ledger");
  });
});
