import { describe, expect, it } from "vitest";
import { NAV } from "./nav";

describe("dashboard nav", () => {
  it("has unique routes", () => {
    const hrefs = NAV.map((n) => n.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
