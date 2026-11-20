import { describe, expect, it } from "vitest";
import { connectorKitPackage } from "./index.js";

describe("@relayon/connector-kit", () => {
  it("is wired into the workspace", () => {
    expect(connectorKitPackage.name).toBe("@relayon/connector-kit");
  });
});
