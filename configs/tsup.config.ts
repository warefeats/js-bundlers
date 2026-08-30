import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  minify: true,
  dts: false,
  sourcemap: false,
  outDir: "dist/tsup",
  clean: false,
});
