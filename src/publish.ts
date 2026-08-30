import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RunnerEnvironment {
  cpu: string;
  logicalCores: number;
  architecture: string;
  platform: string;
  release: string;
  totalMemoryBytes: number;
  freeMemoryBytesAtStart: number;
  bun: string;
}

interface RunnerCandidate {
  id: string;
  name: string;
  version: string;
  command: string;
  exitCodes: number[];
  statistics: { medianMs: number; meanMs: number; minMs: number; maxMs: number };
  samplesMs: number[];
  outputBytes: number;
}

export interface RunnerResult {
  schemaVersion: number;
  benchmark: string;
  generatedAt: string;
  corpus: Record<string, unknown>;
  environment: RunnerEnvironment;
  protocol: { warmups: number; runs: number; processModel: string };
  candidates: RunnerCandidate[];
  speedup: number;
}

export interface PublishOptions {
  machine?: string;
  osVersion?: string;
  label?: string;
  publishedAt?: string;
}

export interface RunFile {
  schemaVersion: number;
  id: string;
  label: string;
  publishedAt: string;
  environment: {
    machine: string;
    chip: string;
    cores: string;
    memory: string;
    os: string;
    arch: string;
    runtime: string;
  };
  protocol: {
    warmups: number;
    runs: number;
    processModel: string;
    cacheState: string;
    output: string;
  };
  candidates: Array<{
    id: string;
    name: string;
    version: string;
    statistics: { medianMs: number; meanMs: number; minMs: number; maxMs: number };
    samplesMs: number[];
    logo?: string;
    homepage?: string;
    color?: string;
  }>;
}

const CANDIDATE_BRANDING: Record<string, { logo: string; homepage: string; color: string }> = {
  esbuild: { logo: "/logos/esbuild.svg", homepage: "https://esbuild.github.io", color: "#FFCF00" },
  vite: { logo: "/logos/vite.svg", homepage: "https://vite.dev", color: "#646CFF" },
  tsup: { logo: "/logos/tsup.svg", homepage: "https://tsup.egoist.dev", color: "#EE6A00" },
};

export function rigSlug(chip: string): string {
  return chip.replace(/^Apple\s+/i, "").replace(/\s+/g, "").toLowerCase();
}

export function convertToRun(result: RunnerResult, options: PublishOptions): RunFile {
  const env = result.environment;
  const memoryGb = Math.round(env.totalMemoryBytes / (1024 ** 3));
  const osName = env.platform === "darwin" ? "macOS" : env.platform;
  const osVersion = options.osVersion ?? env.release;
  const chip = env.cpu;
  const chipLabel = chip.replace(/^Apple\s+/i, "");
  const slug = rigSlug(chip);
  const runDate = result.generatedAt.slice(0, 10);
  const publishedAt = options.publishedAt ?? new Date().toISOString().slice(0, 10);

  return {
    schemaVersion: 1,
    id: `${runDate}-${slug}`,
    label: options.label ?? `${chipLabel} (local)`,
    publishedAt,
    environment: {
      machine: options.machine ?? chipLabel,
      chip,
      cores: `${env.logicalCores} CPU cores`,
      memory: `${memoryGb} GB`,
      os: `${osName} ${osVersion}`,
      arch: env.architecture,
      runtime: `Bun ${env.bun}`,
    },
    protocol: {
      warmups: result.protocol.warmups,
      runs: result.protocol.runs,
      processModel: result.protocol.processModel === "fresh process per pass, output directory cleared"
        ? "A new CLI process for every measured pass, output directory cleared between passes"
        : result.protocol.processModel,
      cacheState: `Warm filesystem cache after ${result.protocol.warmups} unmeasured passes per candidate`,
      output: "Bundled output emitted to a dedicated directory per tool",
    },
    candidates: result.candidates.map((c) => ({
      id: c.id,
      name: c.name,
      version: c.version,
      statistics: c.statistics,
      samplesMs: c.samplesMs,
      ...CANDIDATE_BRANDING[c.id],
    })),
  };
}

export function updateBenchmarkRuns(benchmark: { runs: string[] }, runPath: string): void {
  if (!benchmark.runs.includes(runPath)) {
    benchmark.runs.push(runPath);
  }
}

function detectMacOSVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync({ cmd: ["sw_vers", "-productVersion"], stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch { /* not macOS */ }
  return undefined;
}

function parsePublishArgs(args: string[]): { resultPath: string; machine?: string; label?: string } {
  let resultPath: string | undefined;
  let machine: string | undefined;
  let label: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length);
    } else if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length);
    } else if (!arg.startsWith("-")) {
      resultPath = arg;
    }
  }

  if (!resultPath) {
    throw new Error("Usage: bun run src/publish.ts <result.json> [--machine=<name>] [--label=<text>]");
  }

  return { resultPath, machine, label };
}

async function main(): Promise<void> {
  const { resultPath, machine, label } = parsePublishArgs(Bun.argv.slice(2));
  const repoRoot = resolve(import.meta.dir, "..");
  const result = JSON.parse(await readFile(resolve(process.cwd(), resultPath), "utf8")) as RunnerResult;

  const osVersion = result.environment.platform === "darwin" ? detectMacOSVersion() : undefined;

  const run = convertToRun(result, { machine, osVersion, label });

  const runsDir = join(repoRoot, "runs");
  await mkdir(runsDir, { recursive: true });
  const runFilename = `runs/${run.id}.json`;
  const runPath = join(repoRoot, runFilename);
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${runPath}\n`);

  const benchmarkPath = join(repoRoot, "benchmark.json");
  const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8")) as { runs: string[] };
  updateBenchmarkRuns(benchmark, runFilename);
  await writeFile(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
  process.stderr.write(`Updated ${benchmarkPath}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Publish failed: ${message}\n`);
    process.exitCode = 1;
  });
}
