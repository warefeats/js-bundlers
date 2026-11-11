import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detectNodeVersion, esbuildBinary, pinnedChecksum, reportedVersion, rotated } from "../src/run";

describe("node version detection", () => {
  test("returns a semver-like version string", () => {
    const version = detectNodeVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("pinnedChecksum", () => {
  const sums = "# a comment\n3b843d6840988462fb89a8d714e286f2fc4f998a89c6468ec948c869ab417548  cache/zod-4.5.4.tar.gz\r\n";

  test("reads the archive's sha256, past comments and CRLF", () => {
    expect(pinnedChecksum(sums, "cache/zod-4.5.4.tar.gz")).toBe("3b843d6840988462fb89a8d714e286f2fc4f998a89c6468ec948c869ab417548");
  });

  test("refuses an archive it doesn't list", () => {
    expect(() => pinnedChecksum(sums, "cache/zod-4.6.0.tar.gz")).toThrow("no entry for cache/zod-4.6.0.tar.gz");
  });
});

describe("rotated", () => {
  test("starts each pass one candidate later, so each takes every place in turn", () => {
    const ids = ["esbuild", "vite", "tsup"];
    expect(rotated(ids, 0)).toEqual(["esbuild", "vite", "tsup"]);
    expect(rotated(ids, 1)).toEqual(["vite", "tsup", "esbuild"]);
    expect(rotated(ids, 2)).toEqual(["tsup", "esbuild", "vite"]);
    expect(rotated(ids, 3)).toEqual(ids);
  });
});

describe("reportedVersion", () => {
  test("reads esbuild's bare version and Vite's and tsup's name/version", () => {
    expect(reportedVersion("0.28.2\n")).toBe("0.28.2");
    expect(reportedVersion("vite/8.2.2 win32-x64 node-v24.22.2\n")).toBe("8.2.2");
    expect(reportedVersion("tsup/8.5.1 darwin-arm64 node-v24.19.0")).toBe("8.5.1");
  });
});

describe("esbuildBinary", () => {
  test("is the platform package's binary, an .exe on Windows", () => {
    expect(esbuildBinary("r", "win32", "x64")).toBe(join("r", "node_modules", "@esbuild", "win32-x64", "esbuild.exe"));
    expect(esbuildBinary("r", "darwin", "arm64")).toBe(join("r", "node_modules", "@esbuild", "darwin-arm64", "bin", "esbuild"));
  });
});
