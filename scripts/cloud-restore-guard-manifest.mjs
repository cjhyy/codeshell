// Builtin-only candidate setup. This manifest admits test helpers, never Host/Core source.
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { candidateFile, candidateHash } from "./docker-candidate-guard.mjs";

const modules = [
  "docker-candidate-guard.mjs",
  "docker-candidate-controller.mjs",
  "docker-candidate-adapter.mjs",
  "docker-candidate-netns.mjs",
  "docker-candidate-preload.mjs",
  "docker-candidate-barrier.mjs",
  "docker-candidate-runtime-child.mjs",
  "docker-candidate-ack-writer.mjs",
  "docker-candidate-native-argv.mjs",
  "docker-candidate-video-argv.mjs",
];
const helperInputs = [
  "docker-candidate-netns.mjs",
  "fixtures/docker-candidate-netns-entry.mjs",
  "fixtures/Dockerfile.candidate-netns",
];
const refuse = () => {
  throw new Error("Cloud restore guard manifest custody refused");
};

/** The caller has already verified this checkout's source provenance. No command runs here. */
export function cloudRestoreGuardManifest({
  hostScripts,
  hostHead,
  dockerPath,
  dockerEndpoint,
  runtimeImage,
  containerCore = "/opt/codeshell/node_modules/@cjhyy/code-shell-core/dist/index.js",
}) {
  if (
    !/^[a-f0-9]{40}$/.test(hostHead) ||
    !/^sha256:[a-f0-9]{64}$/.test(runtimeImage) ||
    !/^unix:\/\/\/[^?#\0\r\n]+$/.test(dockerEndpoint) ||
    !/^\/opt\/codeshell\/(?:packages\/core\/dist|node_modules\/@cjhyy\/code-shell-core\/dist)\/index\.js$/.test(
      containerCore,
    ) ||
    /[\s,\0\r\n]/.test(hostScripts) ||
    realpathSync(hostScripts) !== hostScripts ||
    realpathSync(dockerPath) !== dockerPath
  )
    refuse();
  const socket = realpathSync(dockerEndpoint.slice("unix://".length));
  if (!lstatSync(socket).isSocket()) refuse();
  const hashes = (names) =>
    Object.fromEntries(names.map((name) => [name, candidateFile(join(hostScripts, name)).sha256]));
  return {
    version: 1,
    hostHead,
    hostScripts,
    modules: hashes(modules),
    helperInputs: hashes(helperInputs),
    docker: {
      path: dockerPath,
      sha256: candidateFile(dockerPath, { maximum: 128 * 1024 * 1024 }).sha256,
      endpoint: `unix://${socket}`,
    },
    runtime: { imageId: runtimeImage, containerCore },
  };
}

/** Publish a new private input; the restore fixture creates and owns its own firewall image. */
export function writeCloudRestoreGuardManifest(destination, options) {
  const parent = dirname(destination),
    stat = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !stat.isDirectory() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    refuse();
  const manifest = cloudRestoreGuardManifest(options);
  const bytes = JSON.stringify(manifest) + "\n";
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  const file = candidateFile(destination, { privateFile: true });
  if (file.sha256 !== candidateHash(bytes)) refuse();
  return { path: destination, sha256: file.sha256, manifest };
}
