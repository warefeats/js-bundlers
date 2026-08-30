import { describe, expect, test } from "bun:test";
import { detectNodeVersion } from "../src/run";

describe("node version detection", () => {
  test("returns a semver-like version string", () => {
    const version = detectNodeVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
