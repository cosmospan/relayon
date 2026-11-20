import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("@relayon/config", () => {
  it("ships a strict base tsconfig", () => {
    const base = JSON.parse(readFileSync(new URL("./tsconfig.base.json", import.meta.url), "utf8"));
    expect(base.compilerOptions.strict).toBe(true);
  });
});
