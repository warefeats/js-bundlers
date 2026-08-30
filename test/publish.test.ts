import { describe, expect, test } from "bun:test";
import { convertToRun, rigSlug, updateBenchmarkRuns } from "../src/publish";
import type { RunnerResult } from "../src/publish";

const MOCK_RESULT: RunnerResult = {
  schemaVersion: 1,
  benchmark: "vite-vs-esbuild-vs-tsup-library-build",
  generatedAt: "2026-08-30T14:30:00.000Z",
  corpus: { name: "zod 4.5.4 library source", source: "github.com/colinhacks/zod@v4.5.4/src", files: 124, lines: 36620, bytes: 1298414 },
  environment: {
    cpu: "Apple M2 Max",
    logicalCores: 12,
    architecture: "arm64",
    platform: "darwin",
    release: "25.6.0",
    totalMemoryBytes: 103079215104,
    freeMemoryBytesAtStart: 50000000000,
    bun: "1.4.0",
    node: "24.19.0",
  },
  protocol: { warmups: 3, runs: 20, processModel: "fresh process per pass, output directory cleared" },
  candidates: [
    {
      id: "esbuild",
      name: "esbuild",
      version: "0.28.2",
      command: "esbuild src/index.ts --bundle ...",
      exitCodes: [0],
      statistics: { medianMs: 12.5, meanMs: 12.8, minMs: 11.2, maxMs: 14.1 },
      samplesMs: [12.5, 12.6],
      outputBytes: 436156,
    },
    {
      id: "vite",
      name: "Vite",
      version: "8.2.2",
      command: "vite build ...",
      exitCodes: [0],
      statistics: { medianMs: 170.0, meanMs: 172.0, minMs: 165.0, maxMs: 180.0 },
      samplesMs: [170.0, 174.0],
      outputBytes: 493218,
    },
    {
      id: "tsup",
      name: "tsup",
      version: "8.5.1",
      command: "tsup src/index.ts ...",
      exitCodes: [0],
      statistics: { medianMs: 200.0, meanMs: 205.0, minMs: 195.0, maxMs: 215.0 },
      samplesMs: [200.0, 210.0],
      outputBytes: 436156,
    },
  ],
  speedup: 16,
};

const BENCHMARK_RUN_KEYS = ["schemaVersion", "id", "label", "publishedAt", "environment", "protocol", "candidates"];
const ENVIRONMENT_KEYS = ["machine", "chip", "cores", "memory", "os", "arch", "runtime", "node"];
const PROTOCOL_KEYS = ["warmups", "runs", "processModel", "cacheState", "output"];
const STATISTICS_KEYS = ["medianMs", "meanMs", "minMs", "maxMs"];

describe("rig slug", () => {
  test("strips Apple prefix and collapses", () => {
    expect(rigSlug("Apple M2 Max")).toBe("m2max");
  });

  test("handles non-Apple chips", () => {
    expect(rigSlug("AMD Ryzen 9 7950X")).toBe("amdryzen97950x");
  });
});

describe("publish conversion", () => {
  const run = convertToRun(MOCK_RESULT, { machine: "MacBook Pro", publishedAt: "2026-08-30" });

  test("produces exactly the BenchmarkRun keys", () => {
    expect(Object.keys(run).sort()).toEqual(BENCHMARK_RUN_KEYS.sort());
  });

  test("environment has the expected keys", () => {
    expect(Object.keys(run.environment).sort()).toEqual(ENVIRONMENT_KEYS.sort());
  });

  test("protocol has exactly five keys", () => {
    expect(Object.keys(run.protocol).sort()).toEqual(PROTOCOL_KEYS.sort());
  });

  test("statistics has exactly four keys", () => {
    for (const c of run.candidates) {
      expect(Object.keys(c.statistics).sort()).toEqual(STATISTICS_KEYS.sort());
    }
  });

  test("derives id from run date and rig slug", () => {
    expect(run.id).toBe("2026-08-30-m2max");
  });

  test("derives label from chip name", () => {
    expect(run.label).toBe("M2 Max (local)");
  });

  test("accepts a label override", () => {
    const custom = convertToRun(MOCK_RESULT, { machine: "MacBook Pro", label: "Studio (cloud)" });
    expect(custom.label).toBe("Studio (cloud)");
  });

  test("maps environment fields", () => {
    expect(run.environment.machine).toBe("MacBook Pro");
    expect(run.environment.chip).toBe("Apple M2 Max");
    expect(run.environment.cores).toBe("12 CPU cores");
    expect(run.environment.memory).toBe("96 GB");
    expect(run.environment.os).toMatch(/^macOS /);
    expect(run.environment.arch).toBe("arm64");
    expect(run.environment.runtime).toBe("Node 24.19.0 (Vite, tsup); esbuild native binary; Bun 1.4.0 harness");
  });

  test("includes node version in environment", () => {
    expect(run.environment.node).toBe("24.19.0");
  });

  test("enriches protocol with cache and output descriptions", () => {
    expect(run.protocol.processModel).toBe("A new CLI process for every measured pass, output directory cleared between passes");
    expect(run.protocol.cacheState).toBe("Warm filesystem cache after 3 unmeasured passes per candidate");
    expect(run.protocol.output).toBe("Bundled output emitted to a dedicated directory per tool");
  });

  test("strips runner-only candidate fields", () => {
    for (const c of run.candidates) {
      expect(c).not.toHaveProperty("command");
      expect(c).not.toHaveProperty("exitCodes");
      expect(c).not.toHaveProperty("outputBytes");
    }
  });

  test("carries outputBytes through as metrics", () => {
    const esbuild = run.candidates.find((c) => c.id === "esbuild")!;
    expect(esbuild.metrics).toBeDefined();
    expect(esbuild.metrics!.outputBytes).toEqual({ value: 436156, unit: "bytes", label: "Output size" });
  });

  test("adds branding to known candidates", () => {
    const esbuild = run.candidates.find((c) => c.id === "esbuild");
    expect(esbuild?.logo).toBe("/logos/esbuild.svg");
    expect(esbuild?.color).toBe("#FFCF00");
    expect(esbuild?.homepage).toBe("https://esbuild.github.io");
  });

  test("preserves all three candidates", () => {
    expect(run.candidates).toHaveLength(3);
    expect(run.candidates.map((c) => c.id)).toEqual(["esbuild", "vite", "tsup"]);
  });

  test("defaults machine to chip label when not provided", () => {
    const noMachine = convertToRun(MOCK_RESULT, {});
    expect(noMachine.environment.machine).toBe("M2 Max");
  });

  test("omits node key when runner does not provide it", () => {
    const noNode: RunnerResult = {
      ...MOCK_RESULT,
      environment: { ...MOCK_RESULT.environment, node: undefined },
    };
    const run = convertToRun(noNode, { machine: "MacBook Pro" });
    expect(run.environment).not.toHaveProperty("node");
    expect(run.environment.runtime).toBe("esbuild native binary; Bun 1.4.0 harness");
  });
});

describe("benchmark.json update", () => {
  test("appends a new run path", () => {
    const benchmark = { runs: ["runs/existing.json"] };
    updateBenchmarkRuns(benchmark, "runs/new.json");
    expect(benchmark.runs).toEqual(["runs/existing.json", "runs/new.json"]);
  });

  test("does not duplicate an existing path", () => {
    const benchmark = { runs: ["runs/a.json", "runs/b.json"] };
    updateBenchmarkRuns(benchmark, "runs/b.json");
    expect(benchmark.runs).toEqual(["runs/a.json", "runs/b.json"]);
  });

  test("is idempotent across multiple calls", () => {
    const benchmark = { runs: ["runs/a.json"] };
    updateBenchmarkRuns(benchmark, "runs/b.json");
    updateBenchmarkRuns(benchmark, "runs/b.json");
    updateBenchmarkRuns(benchmark, "runs/b.json");
    expect(benchmark.runs).toEqual(["runs/a.json", "runs/b.json"]);
  });
});
