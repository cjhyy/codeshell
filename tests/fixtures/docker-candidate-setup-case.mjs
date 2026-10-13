// Controlled native Node/fake CLI custody only; no Docker, browser or Core.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDockerCandidateFixture } from "../../scripts/docker-candidate-setup.mjs";

const root = process.argv[2],
  cut = process.argv[3];
const fakeBin = join(root, "bin");
mkdirSync(fakeBin, { mode: 0o700 });
const state = join(root, "fake-cli.json"),
  socketPath = join(root, "owned.sock");
const daemon = createServer();
daemon.listen(socketPath);
await once(daemon, "listening");
const source = `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(state)},cut=${JSON.stringify(cut)},args=process.argv.slice(2);
const helper='sha256:'+'b'.repeat(64),runtime='sha256:'+'a'.repeat(64);
let state;try{state=JSON.parse(readFileSync(file))}catch{state={calls:[]}}
state.calls.push(args);
if(args[0]==='build'){
 state.nonce=args[args.indexOf('--label')+1].split('=')[1];
 writeFileSync(args[args.indexOf('--iidfile')+1],helper,{mode:0o600});
 writeFileSync(file,JSON.stringify(state));
 if(cut==='build-fails'){console.error('controlled original build failure');process.exit(3)}
}else if(args[0]==='image'&&args[1]==='inspect'){
 console.log(JSON.stringify([{Id:args[2]===helper?helper:runtime,Config:{Labels:{'io.codeshell.candidate-helper-build':state.nonce}}}]));
}else if(args[0]==='image'&&args[1]==='rm'){
 if(cut==='cleanup-fails'){writeFileSync(file,JSON.stringify(state));console.error('controlled image cleanup failure');process.exit(4)}
 state.removed=true;
}else throw new Error('unreviewed fake transport argv');
writeFileSync(file,JSON.stringify(state));
`;
const fakeDocker = join(fakeBin, "docker");
writeFileSync(fakeDocker, source, { mode: 0o700 });
process.env.PATH = fakeBin + ":" + dirname(process.execPath);
process.env.DOCKER_HOST = `unix://${socketPath}`;
const entry = join(root, "controlled-controller.mjs");
writeFileSync(entry, "console.log('controlled child ready');setInterval(()=>{},1000);", {
  mode: 0o600,
});
// Simulate only the platform dispatch. No actual Docker/kernel syscall follows.
Object.defineProperty(process, "platform", { value: "linux" });
const home = join(root, "home"),
  dataDir = join(root, "data");
mkdirSync(dataDir, { mode: 0o700 });
let closeAttempted = false;
let failed = false,
  failure,
  fixture;
try {
  fixture = await createDockerCandidateFixture({
    scratch: root,
    home,
    dataDir,
    root,
    entry,
    controllerArgs: [entry],
    image: "fixture:immutable",
    containerCore: "/opt/codeshell/packages/core/dist/index.js",
    fixtureHashes: [],
    inlinePrograms: [],
  });
  assert.throws(() => fetch("https://external.invalid/"), /Docker candidate refused/);
  assert.throws(() => spawn("sh", ["-c", "exit 0"]), /Docker candidate refused/);
  if (cut === "live-child") {
    const child = fixture.spawnController();
    let timer;
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "close").then(() => {
          throw new Error("Controlled child exited before ready");
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Controlled child ready timed out")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  closeAttempted = true;
  await fixture.close();
} catch (error) {
  failed = true;
  failure = error;
} finally {
  if (fixture && !closeAttempted) {
    try {
      await fixture.close();
    } catch (error) {
      failure = failed
        ? new AggregateError([failure, error], "Controlled setup and close failed", {
            cause: failure,
          })
        : error;
      failed = true;
    }
  }
  await new Promise((resolve, reject) =>
    daemon.close((error) => (error ? reject(error) : resolve())),
  );
}
const names = (error) =>
  error instanceof AggregateError ? error.errors.flatMap(names) : [String(error)];
const result = {
  failed,
  errors: failed ? names(failure) : [],
  cause: failure?.cause ? String(failure.cause) : undefined,
  state: JSON.parse(readFileSync(state)),
  receipt: fixture
    ? readFileSync(join(home, ".candidate/driver.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
    : [],
};
result.custodyClosed = result.receipt
  .filter((row) => row.event === "child-started")
  .every((row) =>
    result.receipt.some(
      (closed) => closed.event === "child-closed" && closed.childPid === row.childPid,
    ),
  );
console.log(JSON.stringify(result));
