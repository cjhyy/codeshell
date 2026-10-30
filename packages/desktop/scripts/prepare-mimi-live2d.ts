import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = join(desktop, "resources/mimi-live2d");
const destination = join(desktop, "out/mimi-live2d");
const manifest = JSON.parse(await readFile(join(metadata, "source.json"), "utf8")) as {
  sampleBase: string;
  files: { path: string; sha256: string; bytes: number }[];
};
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--sdk")) {
  throw new Error("Usage: bun scripts/prepare-mimi-live2d.ts [--sdk /path/to/extracted-sdk]");
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
for (const file of manifest.files) {
  const target = join(destination, file.path);
  const existing = await readFile(target).catch(() => null);
  if (existing && existing.length === file.bytes && sha256(existing) === file.sha256) continue;
  const response = await fetch(new URL(file.path.replace(/^Hiyori\//u, ""), manifest.sampleBase), {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Official sample download failed: ${file.path} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new Error(`Official sample checksum mismatch: ${file.path}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
await copyFile(join(metadata, "NOTICE.txt"), join(destination, "NOTICE.txt"));
if (args[0] === "--sdk") {
  const core = join(resolve(args[1]!), "Core/live2dcubismcore.min.js");
  const info = await stat(core);
  if (!info.isFile() || info.size > 10_000_000 || info.size < 1000)
    throw new Error("Invalid SDK Core file.");
  const bytes = await readFile(core);
  if (!bytes.includes(Buffer.from("Live2DCubismCore")))
    throw new Error("The selected file is not Cubism Core.");
  await mkdir(join(destination, "Core"), { recursive: true });
  await copyFile(core, join(destination, "Core/live2dcubismcore.min.js"));
  await writeFile(
    join(destination, "Core/receipt.json"),
    JSON.stringify({ sha256: sha256(bytes), bytes: bytes.length }, null, 2) + "\n",
  );
  console.log("Copied Core from the supplied SDK. Retain its license agreements with your SDK.");
} else {
  console.log(
    "Model ready. Core is optional and must be supplied from an SDK you obtained under its agreements.",
  );
}
console.log(destination);
