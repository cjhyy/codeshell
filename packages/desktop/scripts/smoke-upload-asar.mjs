/* Real ASAR/unpacked parser closure, Electron parent and managed native Node. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const require = createRequire(join(desktop, "package.json"));
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = libRequire("@electron/asar");
const electron = require("electron");
const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const source = join(desktop, "node_modules/@cjhyy/code-shell-core");
assert.ok(
  !lstatSync(source).isSymbolicLink(),
  "run Desktop predist to materialize its production closure",
);
assert.ok(
  existsSync(join(source, "node_modules/pdfjs-dist/package.json")),
  "optional PDF dependency must survive predist",
);
const temporary = mkdtempSync(join(tmpdir(), "codeshell-upload-asar-"));
function size(path) {
  if (statSync(path).isDirectory())
    return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
  return statSync(path).size;
}
try {
  const stage = join(temporary, "stage");
  const core = join(stage, "node_modules/@cjhyy/code-shell-core");
  for (const relative of [
    "package.json",
    "dist/sources/documents",
    "dist/sources/truncate-utf8.js",
  ]) {
    mkdirSync(dirname(join(core, relative)), { recursive: true });
    cpSync(join(source, relative), join(core, relative), { recursive: true });
  }
  const packages = ["yauzl", "pend", "saxes", "xmlchars", "pdfjs-dist", "@napi-rs/canvas"];
  const napi = join(source, "node_modules/@napi-rs");
  for (const name of readdirSync(napi))
    if (name.startsWith("canvas-")) packages.push(`@napi-rs/${name}`);
  for (const name of packages) {
    mkdirSync(dirname(join(core, "node_modules", name)), { recursive: true });
    cpSync(join(source, "node_modules", name), join(core, "node_modules", name), {
      recursive: true,
    });
  }
  const archive = join(temporary, "app.asar");
  await asar.createPackageWithOptions(stage, archive, {
    unpack: `${stage}/{${manifest.build.asarUnpack.join(",")}}`,
  });
  const unpacked = `${archive}.unpacked`;
  assert.ok(
    existsSync(
      join(unpacked, "node_modules/@cjhyy/code-shell-core/dist/sources/documents/parser-entry.js"),
    ),
  );
  assert.ok(
    existsSync(
      join(
        unpacked,
        "node_modules/@cjhyy/code-shell-core/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
      ),
    ),
  );
  assert.equal(
    existsSync(
      join(unpacked, "node_modules/@cjhyy/code-shell-core/dist/sources/documents/worker.js"),
    ),
    false,
  );
  assert.equal(
    existsSync(join(unpacked, "node_modules/@cjhyy/code-shell-core/dist/engine/engine.js")),
    false,
  );
  const parent = join(temporary, "parent.mjs");
  writeFileSync(
    parent,
    `
    import assert from "node:assert/strict";
    import { parseDocumentIsolated } from ${JSON.stringify(pathToFileURL(join(archive, "node_modules/@cjhyy/code-shell-core/dist/sources/documents/worker.js")).href)};
    import { createManagedDocumentParserResolver } from ${JSON.stringify(pathToFileURL(join(repo, "packages/core/dist/sources/documents/runtime.js")).href)};
    import { officeZip, wordXml, textPdf } from ${JSON.stringify(pathToFileURL(join(repo, "tests/fixtures/upload-documents.mjs")).href)};
    const resolveExecutable = createManagedDocumentParserResolver(${JSON.stringify(join(desktop, "out/managed-runtimes"))});
    const pdf = await parseDocumentIsolated(textPdf("ASAR native PDF text"), "file.pdf", { resolveExecutable });
    assert.ok(pdf.parts[0].text.includes("ASAR native PDF text"));
    const office = await parseDocumentIsolated(officeZip({"word/document.xml":wordXml("ASAR Office 文本")}), "brief.docx");
    assert.ok(office.parts[0].text.includes("ASAR Office 文本"));
    console.log(JSON.stringify({ hostNode: process.versions.node, pdf: "asar-to-unpacked-managed-node", office: "asar-electron-child" }));
  `,
  );
  const result = spawnSync(electron, [parent], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  console.log(result.stdout.trim());
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      parserArchiveBytes: statSync(archive).size,
      unpackedParserClosureBytes: size(unpacked),
      wholeCoreProductionBytes: size(source),
      optionalPdfRetained: true,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
