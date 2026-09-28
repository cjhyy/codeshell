// Test-only model custody. Production images and user model configuration stay unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function loadSpeechFixture(directory) {
  const root = resolve(directory);
  const hashes = {};
  for (const name of ["whisper-server", "ggml-tiny.en.bin", "jfk.wav", "REVISION"]) {
    const path = join(root, name);
    assert.ok((await lstat(path)).isFile(), `Speech fixture must be a regular file: ${name}`);
    hashes[name] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  const revision = (await readFile(join(root, "REVISION"), "utf8")).trim();
  assert.equal(revision, "927cfce34f31707e17f2bff35c349632fb9e2c3a");
  assert.equal(
    hashes["ggml-tiny.en.bin"],
    "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  );
  assert.equal(
    hashes["jfk.wav"],
    "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
  );
  return { root, revision, hashes, audioPath: join(root, "jfk.wav") };
}

export async function installSpeechFixture(docker, container, fixture) {
  await docker([
    "exec",
    container,
    "mkdir",
    "-p",
    "/tmp/codeshell-real-speech",
    "/workspace/.code-shell/smoke-speech-runtime",
  ]);
  for (const name of ["whisper-server", "ggml-tiny.en.bin"]) {
    // Docker's archive API cannot reliably access a running tmpfs mount. Write
    // through the container's existing non-root process and retain its limits.
    await docker(
      [
        "exec",
        "-i",
        container,
        "node",
        "-e",
        "const fs=require('node:fs'); process.stdin.pipe(fs.createWriteStream(process.argv[1],{flags:'wx',mode:Number(process.argv[2])}));",
        name === "whisper-server"
          ? `/workspace/.code-shell/smoke-speech-runtime/${name}`
          : `/tmp/codeshell-real-speech/${name}`,
        String(name === "whisper-server" ? 0o755 : 0o644),
      ],
      { input: await readFile(join(fixture.root, name)) },
    );
  }
  await docker(["exec", "-i", container, "node", "--input-type=module"], {
    input: `
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      import {readFileSync,openSync} from 'node:fs';
      import {spawn} from 'node:child_process';
      const root='/tmp/codeshell-real-speech';
      const binary='/workspace/.code-shell/smoke-speech-runtime/whisper-server';
      const expected=${JSON.stringify(fixture.hashes)};
      for(const name of ['whisper-server','ggml-tiny.en.bin'])
        assert.equal(createHash('sha256').update(readFileSync(name==='whisper-server'?binary:root+'/'+name)).digest('hex'),expected[name]);
      const output=openSync('/tmp/codeshell-real-speech/provider.log','a');
      const child=spawn(binary,[
        '--host','127.0.0.1','--port','18792','--model',root+'/ggml-tiny.en.bin',
        '--inference-path','/v1/audio/transcriptions','--convert','--no-gpu','--threads','2'
      ],{cwd:root,detached:true,stdio:['ignore',output,output]});
      let failure;
      child.on('error',error=>{failure=error;});
      child.unref();
      let ready=false;
      for(let i=0;i<150;i++){
        if(failure)throw failure;
        if(child.exitCode!==null||child.signalCode!==null)throw new Error('Real speech provider exited');
        try{ready=(await fetch('http://127.0.0.1:18792/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
        if(ready)break;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      assert.ok(ready,'real speech model must be ready inside project container');
      console.log('Real CPU speech provider ready inside isolated project');
    `,
  });
  console.log(
    `PASS: pinned real speech fixture verified in project container (source ${fixture.revision}, model ${fixture.hashes["ggml-tiny.en.bin"]}, binary ${fixture.hashes["whisper-server"]})`,
  );
}
