/**
 * Build the @cjhyy/code-shell metapackage's tiny dist/.
 *
 * The metapackage carries no source of its own — at runtime it just
 * re-exports @cjhyy/code-shell-core (so `import { Engine } from
 * "@cjhyy/code-shell"` still works for legacy SDK users) and ships a
 * shim bin that loads @cjhyy/code-shell-tui's CLI.
 *
 * IMPORTANT: nuke dist/ first. Earlier monorepo iterations left
 * thousands of stale tsup chunks here (anthropic-*.js, chunk-*.js, ...).
 * Without the wipe, `bun run build` would ADD our three files alongside
 * those stale chunks, and `npm publish` would tarball the whole mess.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await writeFile(resolve(dist, "index.js"), 'export * from "@cjhyy/code-shell-core";\n');
await writeFile(resolve(dist, "index.d.ts"), 'export * from "@cjhyy/code-shell-core";\n');

const cliPath = resolve(dist, "cli.js");
await writeFile(cliPath, '#!/usr/bin/env node\nimport "@cjhyy/code-shell-tui/cli";\n');
await chmod(cliPath, 0o755);
