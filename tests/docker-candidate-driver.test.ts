import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateChromiumDefaults,
  validateCandidateChromiumArguments,
  validateCandidateDriverDocker,
} from "../scripts/docker-candidate-driver.mjs";
import { candidatePrivateEnvironment } from "../scripts/docker-candidate-setup.mjs";
import {
  candidateProjectNames,
  candidateMissingContainer,
} from "../scripts/docker-candidate-adapter.mjs";
import { validateCandidateNativeArguments } from "../scripts/docker-candidate-native-argv.mjs";

test("frozen Playwright sandbox argv accepts only a real private profile and the exact capture options", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "candidate-browser-argv-")));
  const directory = join(home, "playwright_chromiumdev_profile-owned");
  mkdirSync(directory, { mode: 0o700 });
  const args = [
    ...candidateChromiumDefaults,
    `--user-data-dir=${directory}`,
    "--remote-debugging-pipe",
    "--no-startup-window",
  ];
  try {
    expect(validateCandidateChromiumArguments(args, { temporaryRoot: home })).toBe(directory);
    for (const changed of [
      [...args, "--no-sandbox"],
      args.map((arg) => (arg === "--headless" ? "--proxy-server=http://external.invalid" : arg)),
      [
        ...candidateChromiumDefaults,
        "--load-extension=/tmp/extension",
        ...args.slice(candidateChromiumDefaults.length),
      ],
      args.map((arg) => (arg === "--no-startup-window" ? "https://external.invalid/" : arg)),
    ])
      expect(() => validateCandidateChromiumArguments(changed, { temporaryRoot: home })).toThrow(
        "refused",
      );
    chmodSync(directory, 0o755);
    expect(() => validateCandidateChromiumArguments(args, { temporaryRoot: home })).toThrow(
      "refused",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("driver Docker fixture rejects arbitrary targets, shell, config, privilege and network changes", () => {
  const installationId = "7fd72c35-cf18-498b-9bb7-f06705d59cca";
  const project = { id: "a1de6837-ce16-4d5c-a320-180b9cb38b58", ownerId: "fixture", generation: 1 };
  const names = candidateProjectNames(installationId, project);
  const policy = {
    installationId,
    projects: [project],
    image: "fixture:immutable",
    ownedResources: new Map(),
  };
  expect(
    validateCandidateDriverDocker(["exec", names.container, "node", "--input-type=module"], policy)
      .kind,
  ).toBe("exec");
  for (const args of [
    ["exec", "other", "node", "--input-type=module"],
    ["exec", names.container, "sh", "-c", "exit 0"],
    ["run", "--privileged", policy.image],
    ["context", "inspect"],
    ["exec", names.container, "curl", "https://external.invalid/"],
    ["volume", "rm", "other"],
    ["exec", "--network", "host", names.container, "node", "-e", "0"],
  ])
    expect(() => validateCandidateDriverDocker(args, policy)).toThrow("refused");
});

test("private Docker environment does not inherit model, proxy, Docker registry or Node injection variables", () => {
  const env = candidatePrivateEnvironment("/private/fixture", "unix:///var/run/docker.sock");
  expect(env.HOME).toBe("/private/fixture");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "DOCKER_CONFIG",
    "DOCKER_AUTH_CONFIG",
    "NODE_OPTIONS",
  ])
    expect(key in env).toBe(false);
  expect(() =>
    candidatePrivateEnvironment("/private/fixture", "tcp://external.invalid:2375"),
  ).toThrow("refused");
});

test("missing-container cleanup accepts only exact captured names with a normal CLI exit1", () => {
  const name = "candidate-helper-captured";
  for (const prefix of ["Error: ", "Error response from daemon: "])
    for (const kind of ["container", "object"])
      expect(
        candidateMissingContainer({ code: 1, stderr: `${prefix}No such ${kind}: ${name}\n` }, name),
      ).toBe(true);
  for (const value of [
    { code: 1, stderr: "daemon context not found" },
    { code: 1, stderr: `Error: No such container: other` },
    { code: 1, stderr: `Error: No such container: ${name}\nadditional daemon failure` },
    { code: 1, killed: true, stderr: `Error: No such container: ${name}` },
    { code: null, signal: "SIGTERM", stderr: `Error: No such container: ${name}` },
  ])
    expect(candidateMissingContainer(value, name)).toBe(false);
});

test("container native argv admits fixed consumers and rejects network/protocol/postprocessor additions", () => {
  expect(() => validateCandidateNativeArguments("/usr/bin/ffmpeg", ["-version"])).not.toThrow();
  expect(() => validateCandidateNativeArguments("/usr/bin/ffprobe", ["-version"])).not.toThrow();
  expect(() =>
    validateCandidateNativeArguments("/data/panel-bin/yt-dlp", ["--ignore-config", "--version"]),
  ).not.toThrow();
  const whisper = [
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
  ];
  expect(() =>
    validateCandidateNativeArguments("/workspace/whisper-server", whisper),
  ).not.toThrow();
  for (const [program, args] of [
    ["ffmpeg", ["-i", "https://external.invalid/file", "/tmp/result"]],
    ["ffprobe", ["-version", "-i", "http://127.0.0.1:1"]],
    ["whisper-server", [...whisper, "--host", "0.0.0.0"]],
    ["yt-dlp", ["--ignore-config", "--exec", "sh", "--version"]],
  ])
    expect(() => validateCandidateNativeArguments(`/usr/bin/${program}`, args)).toThrow("refused");
});
