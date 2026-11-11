# js-bundlers

The reproducible local benchmark runner behind the [warefeats.com "Vite vs esbuild vs tsup" comparison](https://warefeats.com/posts/2026-08-30-js-bundlers-vite-vs-esbuild-vs-tsup/).

It takes zod's TypeScript source from a pinned GitHub tag archive (sha256 in `corpus/checksums.txt`), then runs a cold production build with each bundler against the same corpus, collecting per-pass timing and summary statistics. Results live in this repo as `benchmark.json` (editorial metadata) plus one file per run under `runs/`.

"Cold" means no incremental build state and a fresh CLI process for every measured pass. The filesystem cache is warm after unmeasured warmup passes. Each pass builds once with every candidate, in an order that rotates from pass to pass, so drift during a run lands on all three. esbuild runs as its native binary, and Vite and tsup as `node` on their CLI scripts, which is what the published run's `node_modules/.bin` links started on macOS; on Windows those links are launchers that would add a process to every pass. Each CLI's `--version` is recorded beside the installed version.

## Corpus

zod 4.5.4 library source, vendored from [github.com/colinhacks/zod@v4.5.4](https://github.com/colinhacks/zod/tree/v4.5.4/packages/zod/src). 124 TypeScript files, 36,620 lines, 1,298,414 bytes. Zero dependencies. The npm package ships only compiled JavaScript, so the runner downloads the source tarball from GitHub once into `corpus/cache/` (gitignored) and checks it against `corpus/checksums.txt` before every run. The tarball is a monorepo; the runner extracts `packages/zod/src/`, strips test/benchmark directories, and refuses to run unless the result has the file, line and byte counts `benchmark.json` records.

## Configuration equivalence

Every candidate builds the same entry point (`src/index.ts`) with equivalent settings. Declaration files (.d.ts) are disabled for all — tsup's `dts` option is off by default; enabling it invokes the TypeScript compiler and is outside the scope of this comparison.

| Setting | esbuild | Vite | tsup |
|---|---|---|---|
| Entry | `src/index.ts` | `src/index.ts` | `src/index.ts` |
| Format | `--format=esm` | `formats: ["es"]` | `--format esm` |
| Target | `--target=es2022` | `target: "es2022"` | `--target es2022` |
| Bundle | `--bundle` | implicit (library mode) | implicit |
| Minify | `--minify` | `minify: "esbuild"` | `--minify` |
| Sourcemap | off (default) | `sourcemap: false` | off (default) |
| DTS | N/A | N/A | off (default) |

Minification is ON because production builds are the real use case. All three tools use esbuild's minifier, but not identically: esbuild bundles and minifies natively in Go; Vite delegates bundling to Rolldown (Rust), then runs esbuild for minification — but for ES-format library builds, Vite deliberately disables whitespace minification to preserve `/* @__PURE__ */` annotations for downstream tree-shaking; tsup wraps esbuild for both steps.

The Vite config written at runtime:

```js
export default {
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist/vite",
  },
};
```

esbuild and tsup use CLI flags only (see the configuration table above).

## Requirements

- [Bun](https://bun.sh/) 1.4+
- Node, which Vite and tsup run on; `.node-version` pins the one fleet runs use
- Internet access on first run (to download the zod source tarball; cached afterward)

## Setup

```sh
bun install
```

## Usage

Full benchmark (3 warmup passes, 20 measured passes):

```sh
bun run benchmark
```

Quick smoke test (1 warmup, 3 passes):

```sh
bun run smoke
```

Write results to a file instead of stdout:

```sh
bun run benchmark -- --output=results/run.json
```

### Flags

- `--quick` — shorthand for `--runs=3 --warmups=1`, and marks the results as a smoke run
- `--runs=N` — number of measured passes (default: 20)
- `--warmups=N` — number of warmup passes (default: 3)
- `--output=PATH` — write JSON to a file instead of stdout

## Publishing results

Convert a completed benchmark result into a run file and update `benchmark.json`:

```sh
bun run benchmark -- --output=results/run.json
just publish results/run.json
```

The publish step maps the runner's raw output into the site's `BenchmarkRun` shape, writes `runs/<date>-<rig>.json`, and appends it to `benchmark.json.runs` (idempotent — re-publishing the same run replaces it).

Optional flags: `--machine="MacBook Pro"` (display name for the machine; defaults to the chip label) and `--label="M2 Max (local)"` (toggle text shown on the page; defaults to chip name + "(local)").

### Updating the site

1. Merge the new run file and `benchmark.json` update here.
2. In [warefeats/warefeats.com](https://github.com/warefeats/warefeats.com): bump this slug's `ref` in `web/data/registry.json` to the merge commit SHA, run `bun run sync`, commit registry + cache together, PR, merge.

## Fleet runs

The warefeats fleet measures `main` on its Windows rig when a run is dispatched or a candidate's pinned release changes, on the Node `.node-version` pins and with the archive staged from the rig's cache. It imports the results with `bun run src/publish.ts <results.json> --fleet --commit=<sha> --rig=<slug>`, which refuses a smoke run, a CLI that reported another version than the installed one, and a build that wrote nothing; records the commit, the rig and each candidate's integrity hash from `bun.lock`; and writes `runs/<date>-<rig>.json` without touching `benchmark.json`. The fleet's PR then lists the run in `fleetRuns`. Fleet runs appear on the site's matchup, never on the post, whose verdict was written from its own run on an M2 Max. `sectionSamples: "repeats"` says each sample is one fresh-process build of the whole corpus, so the fleet's verdict check reads a new leader inside twice the standard error of the difference as a tie.

## Type checking and tests

```sh
bun run check   # tsc
bun run test     # bun test
```

## Repository

[github.com/warefeats/js-bundlers](https://github.com/warefeats/js-bundlers)
