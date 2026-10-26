import { defineConfig } from "tsdown";

// Bundles src/main.ts and the TypeScript source of the @pp/* workspace packages into
// dist/main.mjs, so the runtime image needs neither TypeScript nor the workspace.
// npm dependencies stay external and are installed in the image (#11).
export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/^@pp\//] },
});
