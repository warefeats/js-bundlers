import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { summarize, relativeSpeedup } from "./stats";
import type { RunnerOptions } from "./options";

const ZOD_VERSION = "3.24.4";
const ZOD_TARBALL_SHA256 = "d8f858db31bc9debc12ac278db107c67a726eda04e4d71250704d2c7d4c613fe";

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
  command: string[];
  displayCommand: string;
  outputDir: string;
}

interface CandidateResult {
  id: string;
  name: string;
  version: string;
  command: string;
  exitCodes: number[];
  statistics: ReturnType<typeof summarize>;
  samplesMs: number[];
  outputBytes: number;
}

async function downloadCorpus(cacheDir: string): Promise<void> {
  try {
    await stat(join(cacheDir, "src", "index.ts"));
    return;
  } catch { /* needs download */ }

  process.stderr.write(`Downloading zod v${ZOD_VERSION} source\n`);
  const url = `https://github.com/colinhacks/zod/archive/refs/tags/v${ZOD_VERSION}.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (hash !== ZOD_TARBALL_SHA256) {
    throw new Error(`SHA256 mismatch: expected ${ZOD_TARBALL_SHA256}, got ${hash}`);
  }

  await mkdir(cacheDir, { recursive: true });
  const tarball = join(cacheDir, "zod.tar.gz");
  await writeFile(tarball, buffer);

  const proc = Bun.spawnSync({
    cmd: ["tar", "xzf", tarball, "--strip-components=1", `zod-${ZOD_VERSION}/src/`],
    cwd: cacheDir,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`Tar extraction failed: ${proc.stderr.toString()}`);
  }

  await rm(tarball);

  const srcDir = join(cacheDir, "src");
  await rm(join(srcDir, "__tests__"), { recursive: true, force: true });
  await rm(join(srcDir, "benchmarks"), { recursive: true, force: true });

  process.stderr.write(`Corpus cached: zod ${ZOD_VERSION}\n`);
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

function measure(command: string[], cwd: string): { durationMs: number; exitCode: number } {
  const start = performance.now();
  const proc = Bun.spawnSync({ cmd: command, cwd, stdout: "ignore", stderr: "ignore" });
  const durationMs = Math.round((performance.now() - start) * 10) / 10;
  if (proc.exitCode !== 0) {
    const debug = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
    throw new Error(`Build failed (exit ${proc.exitCode}): ${debug.stderr.toString().slice(0, 500)}`);
  }
  return { durationMs, exitCode: proc.exitCode };
}

function runCandidate(def: CandidateDefinition, workdir: string, options: RunnerOptions): Omit<CandidateResult, "outputBytes"> {
  const outputPath = join(workdir, def.outputDir);

  process.stderr.write(`Warming ${def.name} (${options.warmups} passes)\n`);
  for (let i = 0; i < options.warmups; i++) {
    rmSync(outputPath, { recursive: true, force: true });
    measure(def.command, workdir);
  }

  process.stderr.write(`Measuring ${def.name} (${options.runs} passes)\n`);
  const samplesMs: number[] = [];
  const exitCodes = new Set<number>();
  for (let i = 0; i < options.runs; i++) {
    rmSync(outputPath, { recursive: true, force: true });
    const sample = measure(def.command, workdir);
    samplesMs.push(sample.durationMs);
    exitCodes.add(sample.exitCode);
  }

  return {
    id: def.id,
    name: def.name,
    version: def.version,
    command: def.displayCommand,
    exitCodes: [...exitCodes].sort(),
    statistics: summarize(samplesMs),
    samplesMs,
  };
}

async function installedVersion(root: string, pkg: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(root, "node_modules", pkg, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(`Cannot read version of ${pkg}`);
  return manifest.version;
}

export async function runBundleBenchmark(options: RunnerOptions): Promise<Record<string, unknown>> {
  const packageRoot = resolve(import.meta.dir, "..");

  const zodCache = join(tmpdir(), `warefeats-zod-${ZOD_VERSION}`);
  await downloadCorpus(zodCache);

  const scratch = await mkdtemp(join(tmpdir(), "warefeats-bundler-"));

  try {
    await cp(join(zodCache, "src"), join(scratch, "src"), { recursive: true });
    await writeFile(join(scratch, "package.json"), '{ "name": "corpus", "type": "module" }\n');
    await writeFile(join(scratch, "vite.config.js"), VITE_CONFIG);

    const corpus = await measureCorpus(join(scratch, "src"));

    const esbuildBin = resolve(packageRoot, "node_modules/.bin/esbuild");
    const viteBin = resolve(packageRoot, "node_modules/.bin/vite");
    const tsupBin = resolve(packageRoot, "node_modules/.bin/tsup");

    const [esbuildVersion, viteVersion, tsupVersion] = await Promise.all([
      installedVersion(packageRoot, "esbuild"),
      installedVersion(packageRoot, "vite"),
      installedVersion(packageRoot, "tsup"),
    ]);

    const definitions: CandidateDefinition[] = [
      {
        id: "esbuild",
        name: "esbuild",
        version: esbuildVersion,
        command: [esbuildBin, "src/index.ts", "--bundle", "--format=esm", "--target=es2022", "--minify", "--outfile=dist/esbuild/index.mjs"],
        displayCommand: "esbuild src/index.ts --bundle --format=esm --target=es2022 --minify --outfile=dist/esbuild/index.mjs",
        outputDir: "dist/esbuild",
      },
      {
        id: "vite",
        name: "Vite",
        version: viteVersion,
        command: [viteBin, "build"],
        displayCommand: "vite build (library mode via vite.config.js)",
        outputDir: "dist/vite",
      },
      {
        id: "tsup",
        name: "tsup",
        version: tsupVersion,
        command: [tsupBin, "src/index.ts", "--format", "esm", "--target", "es2022", "--minify", "--outDir", "dist/tsup"],
        displayCommand: "tsup src/index.ts --format esm --target es2022 --minify --outDir dist/tsup",
        outputDir: "dist/tsup",
      },
    ];

    const results: CandidateResult[] = [];
    for (const def of definitions) {
      const timing = runCandidate(def, scratch, options);

      rmSync(join(scratch, def.outputDir), { recursive: true, force: true });
      measure(def.command, scratch);
      const outputBytes = await directorySize(join(scratch, def.outputDir));

      results.push({ ...timing, outputBytes });
    }

    const sorted = [...results].sort((a, b) => a.statistics.medianMs - b.statistics.medianMs);
    const fastest = sorted[0]!;
    const slowest = sorted.at(-1)!;

    return {
      schemaVersion: 1,
      benchmark: "vite-vs-esbuild-vs-tsup-library-build",
      generatedAt: new Date().toISOString(),
      corpus: {
        name: `zod ${ZOD_VERSION} library source`,
        source: `github.com/colinhacks/zod@v${ZOD_VERSION}/src`,
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
      },
      protocol: {
        warmups: options.warmups,
        runs: options.runs,
        processModel: "fresh process per pass, output directory cleared",
      },
      candidates: results,
      speedup: relativeSpeedup(slowest.statistics.medianMs, fastest.statistics.medianMs),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
