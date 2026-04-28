import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/main.ts",
    "src/run/index.ts",
    "src/arena/index.ts",
    "src/product/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: false, // DTS disabled: @types/lodash portability issues in src/utils/
  splitting: true,
  sourcemap: false,
  clean: true,
  target: "node20",
  outDir: "dist",
  shims: true,
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
  },
});
