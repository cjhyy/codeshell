// Frozen candidate-only native consumers; network confinement is the netns
// firewall, not this argv check. Native programs' own grandchildren are covered
// by that same namespace, not by the JavaScript child-process wrappers.
import { basename, dirname } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { validateCandidateVideoArguments } from "./docker-candidate-video-argv.mjs";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deny = () => {
  throw new Error("Docker candidate native argv refused");
};
export function validateCandidateNativeArguments(path, args, cwd) {
  const name = basename(path);
  if (validateCandidateVideoArguments(name, args, cwd)) return;
  if (["ffmpeg", "ffprobe"].includes(name) && same(args, ["-version"])) return;
  if (
    name === "ffmpeg" &&
    same(args, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=128x72:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      "/workspace/fixture/source.mp4",
    ])
  )
    return;
  if (
    name === "whisper-server" &&
    same(args, [
      "--host",
      "127.0.0.1",
      "--port",
      "18792",
      "--model",
      "/tmp/codeshell-real-speech/ggml-tiny.en.bin",
      "--inference-path",
      "/v1/audio/transcriptions",
      "--convert",
      "--no-gpu",
      "--threads",
      "2",
    ])
  )
    return;
  if (name === "yt-dlp") {
    if (same(args, ["--ignore-config", "--version"])) return;
    const prefix = [
      "--ignore-config",
      "--continue",
      "--no-overwrites",
      "--newline",
      "--progress",
      "--no-simulate",
      "--restrict-filenames",
      "--trim-filenames",
      "180",
      "--socket-timeout",
      "30",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "--progress-template",
      "download:progress:%(progress._percent_str)s",
      "--print",
      "before_dl:meta:%(title)s",
      "--output",
    ];
    const output = args[prefix.length];
    if (
      same(args.slice(0, prefix.length), prefix) &&
      typeof output === "string" &&
      /^%\(title\)\.80B_%\(id\)\.60B_best-[a-f0-9]{8}(?:_copy-[A-Za-z0-9-]{1,80})?\.%\(ext\)s$/.test(
        output,
      ) &&
      same(args.slice(prefix.length + 1, -1), [
        "--format",
        "bestvideo*+bestaudio/best",
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "--",
      ]) &&
      /^http:\/\/127\.0\.0\.1:18793\/(?:first|second)\.mp4$/.test(args.at(-1))
    )
      return;
  }
  if (name === "chromium") {
    const fixed = [
      "--headless=new",
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-breakpad",
      "--metrics-recording-only",
    ];
    const profileArg = args[fixed.length];
    if (
      !same(args.slice(0, fixed.length), fixed) ||
      args.length !== fixed.length + 2 ||
      args.at(-1) !== "about:blank" ||
      !profileArg?.startsWith("--user-data-dir=")
    )
      deny();
    const profile = profileArg.slice("--user-data-dir=".length);
    const hubJobProfile =
      /^\/data\/panel-tool-jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/work\/\.pdf-browser-[A-Za-z0-9]{6}$/.test(
        profile,
      );
    if (hubJobProfile) {
      // Managed Hub tools receive /data/panel-tool-jobs/<UUID>/work as both
      // their authorized --job-dir and cwd. Keep this new path tied to that
      // exact private job; existing workspace/home consumers keep their contract.
      if (dirname(profile) !== cwd || realpathSync(cwd) !== cwd) deny();
      const work = lstatSync(cwd);
      if (!work.isDirectory() || work.mode & 0o077 || work.uid !== process.getuid()) deny();
    }
    if (
      (!hubJobProfile &&
        !/^\/(?:workspace|data\/home)\/.+\/\.pdf-browser-[A-Za-z0-9]+$/.test(profile)) ||
      realpathSync(profile) !== profile
    )
      deny();
    const stat = lstatSync(profile);
    if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid()) deny();
    return;
  }
  deny();
}
