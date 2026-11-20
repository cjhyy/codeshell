import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { denyDocumentSmokeNetwork } from "../../../../scripts/upload-document-smoke-isolation.mjs";
import { textPdf } from "../../../../tests/fixtures/upload-documents.mjs";
import { ptyEntryPath } from "../../src/main/pty-entry.mjs";

const [role, resources, arch, receipt] = process.argv.slice(2);
assert.ok(
  process.env.CODE_SHELL_TEST_HOME &&
    process.env.CODE_SHELL_TEST_HOME === process.env.CODE_SHELL_HOME,
);
assert.equal(process.cwd(), process.env.HOME);
assert.equal(process.arch, arch);
const archive = join(resources, "app.asar");
const core = join("node_modules", "@cjhyy", "code-shell-core");
assert.equal(dirname(receipt), process.env.TMPDIR);
function phase(name) {
  writeFileSync(
    receipt + ".phase",
    JSON.stringify({ name, active: process.getActiveResourcesInfo() }),
  );
}

async function smokeTerminal() {
  // Resolve from the ASAR just like Desktop Main. A working prebuild can mask a
  // broken rebuild, so verify which binding actually serviced the terminal.
  const require = createRequire(join(archive, "package.json"));
  const windows = process.platform === "win32";
  const shell = windows ? join(process.env.SystemRoot, "System32", "cmd.exe") : "/bin/sh";
  const args = windows
    ? ["/d", "/q", "/v:on", "/s", "/c", "set /p token=READY&echo ACK-!token!&exit /b 7"]
    : ["-c", 'printf "READY\\n"; IFS= read -r token; printf "ACK-%s\\n" "$token"; exit 7'];
  const nodePty = require(ptyEntryPath(require.resolve("node-pty"), resources));
  phase("spawning shell");
  const pty = nodePty.spawn(shell, args, {
    cols: 120,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
  phase("waiting for shell output");
  const token = randomUUID();
  let output = "";
  let sent = false;
  let exited = false;
  let timer;
  try {
    await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error("Packaged PTY timed out")), 12_000);
      pty.onData((data) => {
        output += data;
        if (output.length > 64 * 1024)
          return reject(new Error("Packaged PTY output limit exceeded"));
        if (!sent && output.includes("READY")) {
          sent = true;
          phase("writing challenge to shell");
          pty.write(token + "\r");
        }
      });
      pty.onExit(({ exitCode }) => {
        exited = true;
        phase("shell exited " + exitCode);
        if (exitCode !== 7 || !output.includes("ACK-" + token)) {
          reject(new Error(`PTY command failed (exit ${exitCode}): ${JSON.stringify(output)}`));
        } else done();
      });
    });
  } finally {
    clearTimeout(timer);
    if (!exited) pty.kill();
  }
  const unpack = (path) => path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
  const binary = join(
    archive + ".unpacked",
    "node_modules/node-pty/build/Release",
    windows ? "conpty.node" : "pty.node",
  );
  assert.ok(
    Object.keys(require.cache).some((key) => unpack(key) === binary),
    `Rebuilt PTY binding was not used: ${binary}`,
  );
  return binary;
}

let result;
phase("loading " + role);
if (role === "canvas") {
  assert.equal(process.versions.electron, undefined);
  denyDocumentSmokeNetwork();
  const root = join(archive + ".unpacked", core);
  const require = createRequire(join(root, "package.json"));
  const ctx = require("@napi-rs/canvas").createCanvas(1, 1).getContext("2d");
  ctx.fillStyle = "#010203";
  ctx.fillRect(0, 0, 1, 1);
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [1, 2, 3, 255]);
  const bindings = Object.keys(require.cache).filter((path) => path.endsWith(".node"));
  assert.equal(bindings.length, 1);
  assert.ok(
    bindings[0].startsWith(archive + ".unpacked" + sep),
    `Canvas binding outside the packaged application: ${bindings[0]}`,
  );
  result = { binary: bindings[0], node: process.versions.node, arch: process.arch };
} else {
  assert.equal(role, "pty");
  assert.ok(process.versions.electron);
  const binary = await smokeTerminal();
  // The Windows ConPTY input socket and output worker belong to each shell.
  // Open a second terminal while the first worker completes its final drain.
  const sessions = process.platform === "win32" ? 2 : 1;
  if (sessions === 2) assert.equal(await smokeTerminal(), binary);
  // Windows PTY uses named pipes. Install the document guard after the shell
  // exits and before importing Core; the production parser guards its own child.
  denyDocumentSmokeNetwork();
  const documents = join(archive, core, "dist/sources/documents");
  const { parseDocumentIsolated } = await import(pathToFileURL(join(documents, "worker.js")));
  const { createManagedDocumentParserResolver } = await import(
    pathToFileURL(join(documents, "runtime.js"))
  );
  const message = "packaged native PDF";
  let parser;
  phase("parsing PDF with managed Node");
  const parsed = await parseDocumentIsolated(textPdf(message), "fixture.pdf", {
    timeoutMs: 15_000,
    resolveExecutable: createManagedDocumentParserResolver(join(resources, "runtimes")),
    onProcessExit: (evidence) => {
      parser = evidence;
    },
  });
  assert.ok(parsed.parts.some((part) => part.text.includes(message)));
  assert.ok(parser.cleanedUp && parser.outcome === "success" && !parser.runtime.electron);
  result = {
    binary,
    sessions,
    electron: process.versions.electron,
    node: process.versions.node,
    arch: process.arch,
    pdfNode: parser.runtime.node,
  };
}
writeFileSync(receipt, JSON.stringify(result), { flag: "wx", mode: 0o600 });
phase("wrote result, waiting for process exit");
