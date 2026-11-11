import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { summarize, relativeSpeedup } from "./stats";
import type { RunnerOptions } from "./options";
import { rigInfo } from "./rig";

const ZOD_VERSION = "4.5.4";
const ZOD_ARCHIVE = `zod-${ZOD_VERSION}.tar.gz`;
const ZOD_URL = `https://github.com/colinhacks/zod/archive/refs/tags/v${ZOD_VERSION}.tar.gz`;

// A pass that runs this long has hung; the run fails rather than wait out the fleet's job limit.
const PASS_TIMEOUT_MS = 120_000;

const PROCESS_MODEL = "fresh process per pass, output directory cleared, candidates interleaved and rotated each pass";

const VITE_CONFIG = `export default {
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist/vite",
  },
};
`;

interface CandidateDefinition {
  id: string;
  name: string;
  version: string;
  reportedVersion: string;
  entry: string;
  command: string[];
  displayCommand: string;
  outputDir: string;
}

interface CandidateResult {
  id: string;
  name: string;
  version: string;
  reportedVersion: string;
  entry: string;
  command: string;
  exitCodes: number[];
  statistics: ReturnType<typeof summarize>;
  samplesMs: number[];
  outputBytes: number;
}

/** The sha256 that corpus/checksums.txt pins for `name` ("<sha256>  cache/<file>" lines). */
export function pinnedChecksum(checksums: string, name: string): string {
  for (const line of checksums.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)\r?$/.exec(line);
    if (match && match[2] === name) return match[1]!;
  }
  throw new Error(`corpus/checksums.txt has no entry for ${name}`);
}

/**
 * The zod source archive in corpus/cache, checked against corpus/checksums.txt. A local or CI run downloads it once;
 * the fleet stages it from the rig's cache first, so a fleet run never fetches it.
 */
async function corpusArchive(packageRoot: string): Promise<{ path: string; sha256: string }> {
  const sha256 = pinnedChecksum(await readFile(join(packageRoot, "corpus", "checksums.txt"), "utf8"), `cache/${ZOD_ARCHIVE}`);
  const path = join(packageRoot, "corpus", "cache", ZOD_ARCHIVE);
  if (!existsSync(path)) {
    process.stderr.write(`Downloading zod v${ZOD_VERSION} source\n`);
    const response = await fetch(ZOD_URL);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const got = createHash("sha256").update(buffer).digest("hex");
    if (got !== sha256) throw new Error(`${ZOD_URL} has sha256 ${got}, not the ${sha256} corpus/checksums.txt pins`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
  }
  const got = createHash("sha256").update(await readFile(path)).digest("hex");
  if (got !== sha256) throw new Error(`corpus/cache/${ZOD_ARCHIVE} has sha256 ${got}, not the ${sha256} corpus/checksums.txt pins`);
  return { path, sha256 };
}

const CACHE_MARKER = ".warefeats-verified";

/** zod's library source from the archive, minus its tests and benchmarks, extracted once per archive into tmpdir. */
async function extractCorpus(archive: { path: string; sha256: string }): Promise<string> {
  const cacheDir = join(tmpdir(), `warefeats-zod-${ZOD_VERSION}`);
  try {
    await stat(join(cacheDir, "src", "index.ts"));
    if ((await readFile(join(cacheDir, CACHE_MARKER), "utf8")).trim() === archive.sha256) return cacheDir;
  } catch { /* not extracted yet */ }

  const staging = `${cacheDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(staging, { recursive: true });
  await cp(archive.path, join(staging, "zod.tar.gz"));

  // The archive by a relative name: GNU tar (Git Bash's) reads "C:\..." as a remote host.
  const proc = Bun.spawnSync({
    cmd: ["tar", "xzf", "zod.tar.gz", "--strip-components=3", `zod-${ZOD_VERSION}/packages/zod/src/`],
    cwd: staging,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    await rm(staging, { recursive: true, force: true, maxRetries: 5 });
    throw new Error(`Tar extraction failed: ${proc.stderr.toString()}`);
  }
  await rm(join(staging, "zod.tar.gz"));

  const srcDir = join(staging, "src");
  await rm(join(srcDir, "__tests__"), { recursive: true, force: true });
  await rm(join(srcDir, "benchmarks"), { recursive: true, force: true });
  const entries = await readdir(srcDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === "tests" || entry.name === "benchmarks")) {
      await rm(join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }

  await writeFile(join(staging, CACHE_MARKER), `${archive.sha256}\n`);
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5 });
  await rename(staging, cacheDir);
  process.stderr.write(`Corpus extracted: zod ${ZOD_VERSION}\n`);
  return cacheDir;
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await typescriptFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(full);
    }
  }
  return paths.sort();
}

async function measureCorpus(srcDir: string): Promise<{ files: number; lines: number; bytes: number }> {
  const files = await typescriptFiles(srcDir);
  let bytes = 0;
  let lines = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    bytes += Buffer.byteLength(content, "utf8");
    lines += (content.match(/\n/g)?.length ?? 0);
  }
  return { files: files.length, lines, bytes };
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await directorySize(path);
      } else if (entry.isFile()) {
        total += (await stat(path)).size;
      }
    }
  } catch { /* directory absent */ }
  return total;
}

/** Clears a build's output outside the timing; Defender can hold a fresh file open for a moment on Windows. */
function clearOutput(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function measure(command: string[], cwd: string): number {
  const start = performance.now();
  const proc = Bun.spawnSync({ cmd: command, cwd, stdout: "ignore", stderr: "ignore", timeout: PASS_TIMEOUT_MS });
  const durationMs = Math.round((performance.now() - start) * 10) / 10;
  if (proc.exitCode !== 0) {
    const debug = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe", timeout: PASS_TIMEOUT_MS });
    const reason = proc.exitCode === null ? `killed after ${PASS_TIMEOUT_MS} ms` : `exit ${proc.exitCode}`;
    throw new Error(`Build failed (${reason}): ${debug.stderr.toString().slice(0, 500)}`);
  }
  return durationMs;
}

/** The candidates in a different order each pass, so each takes every place in turn and drift lands on all of them. */
export function rotated<T>(items: T[], pass: number): T[] {
  const start = pass % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** Times every candidate, interleaved: each warmup and each measured pass builds once with each, in rotated order. */
function runCandidates(defs: CandidateDefinition[], workdir: string, options: RunnerOptions): Omit<CandidateResult, "outputBytes">[] {
  process.stderr.write(`Warming up (${options.warmups} passes of ${defs.length} candidates)\n`);
  for (let pass = 0; pass < options.warmups; pass++) {
    for (const def of rotated(defs, pass)) {
      clearOutput(join(workdir, def.outputDir));
      measure(def.command, workdir);
    }
  }

  process.stderr.write(`Measuring (${options.runs} passes of ${defs.length} candidates)\n`);
  const samples = new Map(defs.map((def) => [def.id, [] as number[]]));
  for (let pass = 0; pass < options.runs; pass++) {
    for (const def of rotated(defs, pass)) {
      clearOutput(join(workdir, def.outputDir));
      samples.get(def.id)!.push(measure(def.command, workdir));
    }
  }

  return defs.map((def) => {
    const samplesMs = samples.get(def.id)!;
    return {
      id: def.id,
      name: def.name,
      version: def.version,
      reportedVersion: def.reportedVersion,
      entry: def.entry,
      command: def.displayCommand,
      exitCodes: [0],
      statistics: summarize(samplesMs),
      samplesMs,
    };
  });
}

async function installedVersion(root: string, pkg: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(root, "node_modules", pkg, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(`Cannot read version of ${pkg}`);
  return manifest.version;
}

/**
 * esbuild's own binary. On macOS and Linux its install swaps the package's launcher for this binary, which is what the
 * published run timed; on Windows it keeps a Node launcher, which would add a Node start to every pass.
 */
export function esbuildBinary(root: string, os: string = platform(), cpu: string = arch()): string {
  const pkg = join(root, "node_modules", "@esbuild", `${os}-${cpu}`);
  return os === "win32" ? join(pkg, "esbuild.exe") : join(pkg, "bin", "esbuild");
}

/** A package's command-line script, which `node` runs as the script's shebang would on macOS and Linux. */
async function binEntry(root: string, pkg: string, name: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, "node_modules", pkg, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
  if (!bin) throw new Error(`${pkg} declares no ${name} command`);
  return join(root, "node_modules", pkg, bin);
}

/** The version a CLI prints for itself: esbuild prints "0.28.2", Vite and tsup "vite/8.2.2 win32-x64 node-v24.22.2". */
export function reportedVersion(output: string): string {
  const first = output.trim().split(/\s+/)[0] ?? "";
  return first.includes("/") ? first.slice(first.indexOf("/") + 1) : first;
}

function cliVersion(command: string[], cwd: string): string {
  const proc = Bun.spawnSync({ cmd: [...command, "--version"], cwd, stdout: "pipe", stderr: "pipe", timeout: PASS_TIMEOUT_MS });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} --version failed: ${proc.stderr.toString().slice(0, 300)}`);
  return reportedVersion(proc.stdout.toString());
}

export function detectNodeVersion(): string {
  const proc = Bun.spawnSync({ cmd: ["node", "--version"], stdout: "pipe", stderr: "ignore" });
  if (proc.exitCode !== 0) throw new Error("Failed to detect node version");
  return proc.stdout.toString().trim().replace(/^v/, "");
}

export async function runBundleBenchmark(options: RunnerOptions): Promise<Record<string, unknown>> {
  const packageRoot = resolve(import.meta.dir, "..");
  const benchmark = JSON.parse(await readFile(join(packageRoot, "benchmark.json"), "utf8")) as { corpus: { files: number; lines: number; bytes: number } };

  const archive = await corpusArchive(packageRoot);
  const zodCache = await extractCorpus(archive);
  const scratch = await mkdtemp(join(tmpdir(), "warefeats-bundler-"));

  try {
    await cp(join(zodCache, "src"), join(scratch, "src"), { recursive: true });
    await writeFile(join(scratch, "package.json"), '{ "name": "corpus", "type": "module" }\n');
    await writeFile(join(scratch, "vite.config.js"), VITE_CONFIG);

    // The same files the post built, whatever tar and platform extracted them.
    const corpus = await measureCorpus(join(scratch, "src"));
    const want = benchmark.corpus;
    if (corpus.files !== want.files || corpus.lines !== want.lines || corpus.bytes !== want.bytes) {
      throw new Error(`The corpus has ${corpus.files} files, ${corpus.lines} lines and ${corpus.bytes} bytes; benchmark.json records ${want.files}, ${want.lines} and ${want.bytes}`);
    }

    const nodeVersion = detectNodeVersion();
    const esbuild = esbuildBinary(packageRoot);
    const vite = await binEntry(packageRoot, "vite", "vite");
    const entryName = (path: string) => path.slice(join(packageRoot, "node_modules").length + 1).replaceAll("\\", "/");

    const [esbuildVersion, viteVersion] = await Promise.all([
      installedVersion(packageRoot, "esbuild"),
      installedVersion(packageRoot, "vite"),
    ]);

    // One candidate per tsup release line: the package.json dependency (an npm alias past the first), its name and its
    // output folder. tsup 8 is a closed line: 8.5.1 is its last release.
    const tsupLines: { id: "tsup" | "tsup-9"; name: string; outDir: string }[] = [
      { id: "tsup", name: "tsup 8", outDir: "dist/tsup" },
      { id: "tsup-9", name: "tsup 9", outDir: "dist/tsup-9" },
    ];
    const tsups: CandidateDefinition[] = [];
    for (const line of tsupLines) {
      const script = await binEntry(packageRoot, line.id, "tsup");
      tsups.push({
        id: line.id,
        name: line.name,
        version: await installedVersion(packageRoot, line.id),
        reportedVersion: cliVersion(["node", script], scratch),
        entry: `node ${entryName(script)}`,
        command: ["node", script, "src/index.ts", "--format", "esm", "--target", "es2022", "--minify", "--outDir", line.outDir],
        displayCommand: `tsup src/index.ts --format esm --target es2022 --minify --outDir ${line.outDir}`,
        outputDir: line.outDir,
      });
    }

    const definitions: CandidateDefinition[] = [
      {
        id: "esbuild",
        name: "esbuild",
        version: esbuildVersion,
        reportedVersion: cliVersion([esbuild], scratch),
        entry: entryName(esbuild),
        command: [esbuild, "src/index.ts", "--bundle", "--format=esm", "--target=es2022", "--minify", "--outfile=dist/esbuild/index.mjs"],
        displayCommand: "esbuild src/index.ts --bundle --format=esm --target=es2022 --minify --outfile=dist/esbuild/index.mjs",
        outputDir: "dist/esbuild",
      },
      {
        id: "vite",
        name: "Vite",
        version: viteVersion,
        reportedVersion: cliVersion(["node", vite], scratch),
        entry: `node ${entryName(vite)}`,
        command: ["node", vite, "build"],
        displayCommand: "vite build (library mode via vite.config.js)",
        outputDir: "dist/vite",
      },
      ...tsups,
    ];

    const timings = runCandidates(definitions, scratch, options);
    const results: CandidateResult[] = [];
    for (const [index, def] of definitions.entries()) {
      // One more build, not timed, for the output size; every candidate must have written a bundle.
      clearOutput(join(scratch, def.outputDir));
      measure(def.command, scratch);
      const outputBytes = await directorySize(join(scratch, def.outputDir));
      if (outputBytes <= 0) throw new Error(`${def.name} exited 0 but wrote nothing to ${def.outputDir}`);
      results.push({ ...timings[index]!, outputBytes });
    }

    const sorted = [...results].sort((a, b) => a.statistics.medianMs - b.statistics.medianMs);
    const fastest = sorted[0]!;
    const slowest = sorted.at(-1)!;

    return {
      schemaVersion: 1,
      benchmark: "vite-vs-esbuild-vs-tsup-library-build",
      generatedAt: new Date().toISOString(),
      smoke: options.smoke,
      corpus: {
        name: `zod ${ZOD_VERSION} library source`,
        source: `github.com/colinhacks/zod@v${ZOD_VERSION}/src`,
        archive: { name: ZOD_ARCHIVE, sha256: archive.sha256 },
        files: corpus.files,
        lines: corpus.lines,
        bytes: corpus.bytes,
      },
      environment: {
        cpu: cpus()[0]?.model ?? "Unknown CPU",
        logicalCores: cpus().length,
        architecture: arch(),
        platform: platform(),
        release: release(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtStart: freemem(),
        bun: Bun.version,
        node: nodeVersion,
      },
      rig: await rigInfo(),
      protocol: {
        warmups: options.warmups,
        runs: options.runs,
        processModel: PROCESS_MODEL,
      },
      candidates: results,
      speedup: relativeSpeedup(slowest.statistics.medianMs, fastest.statistics.medianMs),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function writeResult(result: Record<string, unknown>, output?: string): Promise<void> {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (!output) {
    process.stdout.write(serialized);
    return;
  }
  const destination = resolve(process.cwd(), output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, serialized, "utf8");
  process.stderr.write(`Wrote ${destination}\n`);
}
