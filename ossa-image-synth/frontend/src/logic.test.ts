import { describe, expect, it } from "vitest";
import { ApiError, errText } from "./api";
import { DEFAULT_POS, DEPENDENCIES } from "./components/Canvas";

describe("canvas wiring", () => {
  it("every dependency cable connects two known modules", () => {
    const keys = Object.keys(DEFAULT_POS);
    expect(keys).toHaveLength(9);
    for (const [s, t] of DEPENDENCIES) {
      expect(keys).toContain(s);
      expect(keys).toContain(t);
      expect(s).not.toBe(t);
    }
  });
  it("execution path reaches output", () => {
    const has = (s: string, t: string) => DEPENDENCIES.some(([a, b]) => a === s && b === t);
    expect(has("N04", "N07")).toBe(true);
    expect(has("N07", "N08")).toBe(true);
    expect(has("N05", "N08")).toBe(true);
  });
});

describe("error text", () => {
  it("formats blocked-approval details", () => {
    expect(errText(new ApiError(409, { message: "Approval blocked", failed: ["a", "b"] }))).toBe("Approval blocked: a; b");
    expect(errText(new ApiError(400, "plain"))).toBe("plain");
  });
});
