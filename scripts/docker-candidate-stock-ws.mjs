// Test-only, reviewed stock ws provenance. This module never loads Core or a provider.
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { realpathSync } from "node:fs";
import { candidateFile, candidateHash } from "./docker-candidate-guard.mjs";

const refuse = () => {
  throw new Error("Docker candidate stock WebSocket source refused");
};
// Full published JavaScript closure, including both CJS and ESM entrypoints.
// The two reviewed patch releases retain the same private stock TCP connector.
const source8210 = {
  "package.json": "584ce6e7516587ba249dc910b0c04e2753f6b3f451fc3a5bc324f7735bdacc71",
  "index.js": "924564d5be26d59b9682c4263f68320e48dde7240bd2d1ad17ec305537429dd2",
  "wrapper.mjs": "fe154662301fd558f935f9c217fccbe7a7dac02ff39e648a000589403ff27c7f",
  "browser.js": "010da44addea1d88b2b732540c3f1fd0cbcb28926b96623d4c64222e0ead2d0e",
  "lib/buffer-util.js": "8b0a45739132f82e25ea13163780abf547ccfe989267f3eb7abb475beec92da3",
  "lib/constants.js": "391e823142b8b370e55a2fd32b022deaf03b8415c56000009674ebc86a0b4f86",
  "lib/event-target.js": "c45d3c6e12d170c860c0c3f1a050aa0f864d9806632b609a1e607d675aba128c",
  "lib/extension.js": "852564f0f6b460287043803eae732666fb5610f676874354fc89f06aa4e986ed",
  "lib/limiter.js": "e0469d4b83f6ba764b15f80e1766b75c136fbff68f048f4c050f0b1c7f065f69",
  "lib/permessage-deflate.js": "02c31796f0132a335d4efe7b7adcebadbb69543a1ce65ae04aaccc3530e27ab9",
  "lib/receiver.js": "4879edbf8e48d04d09783cf9c04b5e25f5a448247bb01279438ded2899747220",
  "lib/sender.js": "d0791d30c3defd44dcabbddb879a901c757993fea2c00a7ffea01d53b23b4b77",
  "lib/stream.js": "a56fcb6e2b152097ee820b6f5410b1f71e59819b45d08d9f8bda588fe39070ec",
  "lib/subprotocol.js": "be3f6323d6f549568577dcba9004c1479d95c65a7abb0fe0c582875b9fac0b7c",
  "lib/validation.js": "41ce8e83d0d434132e1704895fedb91f6703a701b42d91c80954ab29b2845593",
  "lib/websocket-server.js": "29029a4d346800c792300df153df2007e9805d9d7b67b0883f9730b64f25b1c8",
  "lib/websocket.js": "48fdb0f54c1f8ce580d3cfa2908fe7d96fe18f06f9d82306950441cb09b5db26",
};
const sources = {
  "8.21.0": source8210,
  "8.21.3": {
    ...source8210,
    ...{
      "package.json": "a56a3fd55945a3ce177e3ca165dafae6f7eb03b7aefd58c092ac723d5741a6fb",
      "lib/permessage-deflate.js":
        "16a91536988a53c23047ee5882392068728a839a244178c3b09b8c54982f58b0",
      "lib/receiver.js": "a6ada33c9a2d54eaf595824b821ea89ca2c6395f89aa06755c52142148274884",
      "lib/websocket-server.js": "6d8dd89a841748c80445fd5fcdb5ba8005369b53cc3525135e11304c8b9c55e5",
      "lib/websocket.js": "de5add831db49e159d3ee0adb1c5e042eba3af13166374c5584f4fc520d1e734",
    },
  },
};
const loaded = new Map();
const sourceHash = (files) => candidateHash(JSON.stringify(files));

function verified(pin) {
  if (
    !pin ||
    pin.version !== 1 ||
    typeof pin.packageRoot !== "string" ||
    !isAbsolute(pin.packageRoot) ||
    realpathSync(pin.packageRoot) !== pin.packageRoot ||
    Object.keys(pin).sort().join(",") !== "packageRoot,packageVersion,sourceHash,version"
  )
    refuse();
  const files =
    typeof pin.packageVersion === "string" && Object.hasOwn(sources, pin.packageVersion)
      ? sources[pin.packageVersion]
      : undefined;
  if (!files || sourceHash(files) !== pin.sourceHash) refuse();
  for (const [name, expected] of Object.entries(files))
    if (candidateFile(join(pin.packageRoot, name)).sha256 !== expected) refuse();
  const manifest = JSON.parse(candidateFile(join(pin.packageRoot, "package.json")).bytes);
  if (
    manifest.name !== "ws" ||
    manifest.version !== pin.packageVersion ||
    manifest.main !== "index.js" ||
    manifest.exports?.["."]?.require !== "./index.js" ||
    manifest.exports?.["."]?.import !== "./wrapper.mjs"
  )
    refuse();
  return pin;
}

export function pinCandidateStockWebSocket(anchor) {
  if (typeof anchor !== "string" || !isAbsolute(anchor)) refuse();
  candidateFile(realpathSync(anchor));
  const manifestPath = realpathSync(createRequire(anchor).resolve("ws/package.json"));
  const packageRoot = dirname(manifestPath);
  if (manifestPath !== join(packageRoot, "package.json")) refuse();
  const manifest = JSON.parse(candidateFile(join(packageRoot, "package.json")).bytes);
  const files =
    typeof manifest.version === "string" && Object.hasOwn(sources, manifest.version)
      ? sources[manifest.version]
      : undefined;
  if (!files) refuse();
  return verified({
    version: 1,
    packageRoot,
    packageVersion: manifest.version,
    sourceHash: sourceHash(files),
  });
}

// Called only by trusted setup/preload during guard initialization. The caller
// cannot supply a constructor, connector, source text or module resolver.
export function loadCandidateStockWebSocket(pin) {
  verified(pin);
  const require = createRequire(join(pin.packageRoot, "package.json"));
  // The first constructor must originate in these verified bytes, rather than a
  // prepopulated CommonJS cache. Later consumers reuse this loader's identity.
  if (
    !loaded.has(pin.packageRoot) &&
    Object.keys(sources[pin.packageVersion]).some(
      (name) => require.cache[join(pin.packageRoot, name)],
    )
  )
    refuse();
  // The trusted driver/preload performs the first load after guard installation.
  // Disable optional native acceleration while initializing the pinned closure.
  const keys = ["WS_NO_BUFFER_UTIL", "WS_NO_UTF_8_VALIDATE"];
  const before = keys.map((key) => process.env[key]);
  let Constructor;
  try {
    for (const key of keys) process.env[key] = "1";
    Constructor = require(join(pin.packageRoot, "index.js"));
    if (
      typeof Constructor !== "function" ||
      Constructor !== Constructor.WebSocket ||
      Constructor !== require(join(pin.packageRoot, "lib/websocket.js"))
    )
      refuse();
  } finally {
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    });
  }
  verified(pin);
  if (loaded.has(pin.packageRoot) && loaded.get(pin.packageRoot) !== Constructor) refuse();
  loaded.set(pin.packageRoot, Constructor);
  return Constructor;
}
