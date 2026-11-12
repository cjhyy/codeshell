import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { validateCandidateVideoArguments as validate } from "../../scripts/docker-candidate-video-argv.mjs";

function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-resource-alias-")));
  const cwd = join(root, "data/panel-tool-jobs/1f533283-e3b9-49f5-957b-cdb7b90c3948/work");
  const scope = join(
    root,
    "data/panel-data/video-studio",
    "b".repeat(24),
    "runtime/editor-v2/scopes",
    "a".repeat(64),
  );
  const bytes = "controlled immutable fixture";
  const name = `asset-${createHash("sha256").update(bytes).digest("hex")}.bin`;
  const path = join(scope, "transfers/first/resources", name),
    library = join(scope, "resources", name);
  for (const dir of [cwd, dirname(path), dirname(library)])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  linkSync(path, library);
  const args = [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov,matroska,webm,avi,mp3,wav,aiff,flac,ogg,aac",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_type,sample_rate,channels",
    "-of",
    "json",
    path,
  ];
  const alias = (id) => {
    const target = join(scope, "transfers", id, "resources", name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    linkSync(path, target);
    return target;
  };
  const check = () => validate("ffprobe", args, cwd);
  try {
    run({ root, cwd, scope, path, library, args, alias, check });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("two and four aliases and an old family after library replacement remain verifiable", () =>
  fixture((f) => {
    assert.equal(f.check(), true);
    f.alias("second");
    f.alias("third");
    assert.equal(f.check(), true);
    rmSync(f.library);
    writeFileSync(f.library, "new snapshot inode", { mode: 0o600 });
    assert.equal(f.check(), true);
  }));

test("unknown, cross-scope, differently named and job input aliases are refused", () => {
  for (const kind of ["outside", "scope", "name", "input"])
    fixture((f) => {
      const extra =
        kind === "outside"
          ? join(f.root, "unknown.bin")
          : kind === "scope"
            ? join(dirname(f.scope), "c".repeat(64), "resources", basename(f.path))
            : kind === "name"
              ? join(dirname(f.path), `asset-${"d".repeat(64)}.bin`)
              : join(f.cwd, "inputs/resource-0.bin");
      mkdirSync(dirname(extra), { recursive: true, mode: 0o700 });
      linkSync(f.path, extra);
      assert.throws(f.check, /custody refused/);
    });
});

test("each alias retains private canonical parent custody", () => {
  fixture((f) => {
    chmodSync(dirname(f.library), 0o755);
    assert.throws(f.check, /custody refused/);
  });
  fixture((f) => {
    const extra = f.alias("second");
    const dir = dirname(extra);
    rmSync(extra);
    rmSync(dir, { recursive: true });
    symlinkSync(dirname(f.path), dir);
    assert.throws(f.check, /custody refused/);
  });
});

test("a symlink cannot account for an unknown hard link", () =>
  fixture((f) => {
    const extra = join(f.root, "unknown.bin");
    linkSync(f.path, extra);
    rmSync(f.library);
    symlinkSync(extra, f.library);
    assert.throws(f.check, /custody refused/);
  }));

test("same-inode content changes cannot retain a content-addressed grant", () =>
  fixture((f) => {
    writeFileSync(f.library, "changed content");
    assert.throws(f.check, /custody refused/);
  }));

test("enumeration and hash reads remain bounded", () => {
  fixture((f) => {
    for (let i = 0; i < 63; i++) f.alias(`extra-${i}`);
    assert.throws(f.check, /custody refused/);
  });
  fixture((f) => {
    for (let i = 0; i < 64; i++)
      mkdirSync(join(f.scope, "transfers", `extra-${i}`), { mode: 0o700 });
    assert.throws(f.check, /custody refused/);
  });
  fixture((f) => {
    truncateSync(f.path, 64 * 1024 * 1024 + 1);
    assert.throws(f.check, /custody refused/);
  });
});

test("hard links in ordinary job inputs remain refused", () =>
  fixture((f) => {
    const input = join(f.cwd, "inputs/resource-0.bin");
    mkdirSync(dirname(input), { mode: 0o700 });
    linkSync(f.path, input);
    assert.throws(
      () => validate("ffprobe", f.args.slice(0, -1).concat(input), f.cwd),
      /custody refused/,
    );
  }));
