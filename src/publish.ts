import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RigInfo } from "./rig";

interface RunnerEnvironment {
  cpu: string;
  logicalCores: number;
  architecture: string;
  platform: string;
  release: string;
  totalMemoryBytes: number;
  freeMemoryBytesAtStart: number;
  bun: string;
  node?: string;
}

interface RunnerCandidate {
  id: string;
  name: string;
  version: string;
  /** What the CLI printed for --version at run time; results from before the fleet don't have it. */
  reportedVersion?: string;
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
  smoke?: boolean;
  corpus: Record<string, unknown>;
  environment: RunnerEnvironment;
  rig?: RigInfo;
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

/** What a fleet run measured: the runner commit, the rig, and each candidate's package as bun.lock pinned it. */
export interface Provenance {
  kind: "fleet";
  commit: string;
  rig: string;
}

export interface LineupEntry {
  candidateId: string;
  package: string;
  version: string;
  integrity: string;
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
    node?: string;
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
    metrics?: Record<string, { value: number; unit: string; label?: string }>;
  }>;
  provenance?: Provenance;
  lineup?: LineupEntry[];
}

const CANDIDATE_BRANDING: Record<string, { logo?: string; homepage: string; color: string }> = {
  esbuild: { logo: "/logos/esbuild.svg", homepage: "https://esbuild.github.io", color: "#FFCF00" },
  vite: { logo: "/logos/vite.svg", homepage: "https://vite.dev", color: "#646CFF" },
  tsup: { homepage: "https://tsup.egoist.dev", color: "#EE6A00" },
  "tsup-9": { homepage: "https://tsup.egoist.dev", color: "#F7A440" },
};

/** The package.json dependency each candidate is, which the fleet's plan matches against the lineup. */
const CANDIDATE_PACKAGES: Record<string, string> = { esbuild: "esbuild", vite: "vite", tsup: "tsup", "tsup-9": "tsup-9" };

const PROCESS_MODELS: Record<string, string> = {
  "fresh process per pass, output directory cleared": "A new CLI process for every measured pass, output directory cleared between passes",
  "fresh process per pass, output directory cleared, candidates interleaved and rotated each pass":
    "A new CLI process for every measured pass, output directory cleared between passes, candidates interleaved and rotated each pass",
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

  const nodeVersion = env.node;
  const runtimeParts: string[] = [];
  if (nodeVersion) runtimeParts.push(`Node ${nodeVersion} (Vite, tsup)`);
  runtimeParts.push("esbuild native binary");
  runtimeParts.push(`Bun ${env.bun} harness`);
  const runtime = runtimeParts.join("; ");

  const rig = result.rig;
  const runFile: RunFile = {
    schemaVersion: 1,
    id: `${runDate}-${slug}`,
    label: options.label ?? `${chipLabel} (local)`,
    publishedAt,
    environment: rig
      ? { machine: options.machine ?? rig.machine, chip: rig.chip, cores: rig.cores, memory: rig.memory, os: rig.os, arch: rig.arch, runtime }
      : {
          machine: options.machine ?? chipLabel,
          chip,
          cores: `${env.logicalCores} CPU cores`,
          memory: `${memoryGb} GB`,
          os: `${osName} ${osVersion}`,
          arch: env.architecture,
          runtime,
        },
    protocol: {
      warmups: result.protocol.warmups,
      runs: result.protocol.runs,
      processModel: PROCESS_MODELS[result.protocol.processModel] ?? result.protocol.processModel,
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
      ...(c.outputBytes > 0 ? { metrics: { outputBytes: { value: c.outputBytes, unit: "bytes", label: "Output size" } } } : {}),
    })),
  };

  if (nodeVersion) runFile.environment.node = nodeVersion;
  return runFile;
}

export function updateBenchmarkRuns(benchmark: { runs: string[] }, runPath: string): void {
  if (!benchmark.runs.includes(runPath)) {
    benchmark.runs.push(runPath);
  }
}

/** Refusals for a fleet run: nothing smoke-tested, mislabelled or half-built reaches a PR. */
export function checkFleetRun(result: RunnerResult, options: { allowSmoke: boolean; commit?: string }): void {
  if (result.smoke && !options.allowSmoke) throw new Error("a fleet run can't be a smoke run (pass --allow-smoke to check the pipeline)");
  if (!options.commit || !/^[0-9a-f]{40}$/.test(options.commit)) throw new Error("--fleet needs --commit=<the runner commit's full SHA>");
  if (!result.rig) throw new Error("the results have no rig probe; they predate the fleet");
  for (const c of result.candidates) {
    if (c.reportedVersion !== c.version) throw new Error(`${c.id} reported ${c.reportedVersion ?? "nothing"} at run time but ${c.version} was installed`);
    if (c.outputBytes <= 0) throw new Error(`${c.id} wrote no bundle`);
  }
}

/** Each candidate's package, version and integrity hash as bun.lock pinned them for this run. */
export function lineupOf(result: RunnerResult, lock: string): LineupEntry[] {
  return result.candidates.map((c) => {
    const pkg = CANDIDATE_PACKAGES[c.id] ?? c.id;
    const key = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The package name can't run past its quote: a lock line's later "@scope/name" entries would match a greedy one.
    const m = new RegExp(`^\\s*"${key}": \\["((?:@[^"@/]+/)?[^"@]+)@([^"@]+)", "[^"]*", .*"(sha512-[A-Za-z0-9+/=]+)"\\],?\\r?$`, "m").exec(lock);
    if (!m) throw new Error(`bun.lock has no entry for ${pkg}`);
    if (m[2] !== c.version) throw new Error(`${c.id}: bun.lock pins ${m[2]} but the run measured ${c.version}`);
    return { candidateId: c.id, package: m[1]!, version: c.version, integrity: m[3]! };
  });
}

export interface FleetOptions {
  commit: string;
  rig: string;
  machine?: string;
  cpuShort?: string;
  osShort?: string;
  lock: string;
}

/** A fleet run: dated by the run itself, labelled with the rig instead of "(local)", and carrying what it measured. */
export function fleetRun(result: RunnerResult, options: FleetOptions): RunFile {
  const runDate = result.generatedAt.slice(0, 10);
  const rig = result.rig!;
  const cpuShort = options.cpuShort ?? rig.chip;
  const osShort = options.osShort ?? rig.os.split(" (")[0]!;
  const run = convertToRun(result, { machine: options.machine, publishedAt: runDate, label: `${cpuShort} / ${osShort}, ${runDate}` });
  run.id = `${runDate}-${options.rig}${result.smoke ? "-smoke" : ""}`;
  run.provenance = { kind: "fleet", commit: options.commit, rig: options.rig };
  run.lineup = lineupOf(result, options.lock);
  return run;
}

function detectMacOSVersion(): string | undefined {
  try {
    const proc = Bun.spawnSync({ cmd: ["sw_vers", "-productVersion"], stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch { /* not macOS */ }
  return undefined;
}

const USAGE = "Usage: bun run src/publish.ts <result.json> [--machine=<name>] [--label=<text>]\n"
  + "       bun run src/publish.ts <result.json> --fleet --commit=<sha> --rig=<slug> [--machine=<name>] [--cpu-short=<text>] [--os-short=<text>] [--allow-smoke]";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const resultPath = args.find((a) => !a.startsWith("-"));
  if (!resultPath) throw new Error(USAGE);
  const repoRoot = resolve(import.meta.dir, "..");
  const result = JSON.parse(await readFile(resolve(process.cwd(), resultPath), "utf8")) as RunnerResult;
  if (result.smoke) process.stderr.write("warning: importing a SMOKE run\n");

  if (args.includes("--fleet")) {
    // A fleet run is written but not listed: the fleet's publish job adds it to benchmark.json's fleetRuns on the PR.
    checkFleetRun(result, { allowSmoke: args.includes("--allow-smoke"), commit: flag("commit") });
    const rig = flag("rig");
    if (!rig) throw new Error("--fleet needs --rig=<the rig's slug>");
    const run = fleetRun(result, {
      commit: flag("commit")!,
      rig,
      machine: flag("machine"),
      cpuShort: flag("cpu-short"),
      osShort: flag("os-short"),
      lock: await readFile(join(repoRoot, "bun.lock"), "utf8"),
    });
    const runPath = `runs/${run.id}.json`;
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    await writeFile(join(repoRoot, runPath), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    console.log(`fleet-run: ${runPath}`);
    return;
  }

  const osVersion = result.environment.platform === "darwin" ? detectMacOSVersion() : undefined;
  const run = convertToRun(result, { machine: flag("machine"), osVersion, label: flag("label") });

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
