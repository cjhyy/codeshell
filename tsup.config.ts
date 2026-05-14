import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/main.ts",
    "src/run/index.ts",
    "src/arena/index.ts",
    "src/product/index.ts",
  ],
  // ESM-only — node >=20.10 (enforced by preinstall) has native ESM, and
  // the CJS twin doubled dist size while serving no real consumer. Anyone
  // still on require() can use Node 22+'s native `require(esm)`.
  format: ["esm"],
  dts: false, // DTS disabled: @types/lodash portability issues in src/utils/
  splitting: true,
  sourcemap: false,
  clean: true,
  target: "node20",
  outDir: "dist",
  shims: true,
  // Production optimizations — applied to every build (no separate
  // "release" mode):
  //   minify     — ~60% smaller chunks
  //   treeshake  — removes unused exports across the dependency graph
  //   keepNames  — preserves class/function names so error stacks stay
  //                debuggable (cheap win, high value when users report crashes)
  minify: true,
  treeshake: true,
  keepNames: true,
  // Mark Bun builtins and optional cloud SDKs as external so esbuild skips them
  external: [
    "bun:bundle",
    "@anthropic-ai/bedrock-sdk",
    "@anthropic-ai/foundry-sdk",
    "@anthropic-ai/vertex-sdk",
    "@aws-sdk/client-bedrock",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-sts",
    "@aws-sdk/credential-provider-node",
    "@azure/identity",
    "@smithy/core",
    "@smithy/node-http-handler",
    "google-auth-library",
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
    // Inline .md files as text strings (prompt sections)
    options.loader = { ...options.loader, ".md": "text" };
    // Strip "/*! ... */" license comments embedded in transitive deps.
    // A CLI bundle isn't a redistributable that needs to surface them
    // inline — node_modules retains the originals for downstream users
    // and we still ship LICENSE.
    options.legalComments = "none";
  },
});
