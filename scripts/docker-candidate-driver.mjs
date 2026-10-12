// Test-only native launch contracts. No browser, Docker, Server or Core import.
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { candidateProjectNames } from "./docker-candidate-adapter.mjs";

const deny = () => {
  throw new Error("Docker candidate driver argv refused");
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const disabledFeatures = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "Translate",
  "AutoDeElevate",
  "RenderDocument",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];
// Frozen Playwright 1.60.0 Chromium.defaultArgs with headless + sandbox=true.
// Changes to the locked library must be reviewed rather than admitted by prefix.
export const candidateChromiumDefaults = Object.freeze([
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-edgeupdater",
  "--disable-extensions",
  `--disable-features=${disabledFeatures.join(",")}`,
  "--enable-features=CDPScreenshotNewSurface",
  "--allow-pre-commit-input",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-service-autorun",
  "--export-tagged-pdf",
  "--disable-search-engine-choice-screen",
  "--unsafely-disable-devtools-self-xss-warnings",
  "--edge-skip-compat-layer-relaunch",
  "--disable-infobars",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--enable-unsafe-swiftshader",
  "--headless",
  "--hide-scrollbars",
  "--mute-audio",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
]);

export function validateCandidateChromiumArguments(args, { temporaryRoot, audioPath } = {}) {
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    !same(args.slice(0, candidateChromiumDefaults.length), candidateChromiumDefaults)
  )
    deny();
  const remainder = args.slice(candidateChromiumDefaults.length);
  const extras = [];
  if (remainder[0] === "--use-fake-device-for-media-stream") {
    extras.push("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream");
    if (audioPath && remainder[2] === `--use-file-for-fake-audio-capture=${audioPath}`)
      extras.push(`--use-file-for-fake-audio-capture=${audioPath}`);
  }
  const directoryArg = remainder[extras.length];
  if (typeof directoryArg !== "string" || !directoryArg.startsWith("--user-data-dir=")) deny();
  const directory = directoryArg.slice("--user-data-dir=".length);
  if (
    !same(remainder, [...extras, directoryArg, "--remote-debugging-pipe", "--no-startup-window"]) ||
    !directory.startsWith(join(temporaryRoot, "playwright_chromiumdev_profile-")) ||
    realpathSync(directory) !== directory
  )
    deny();
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    deny();
  return directory;
}

/** Driver commands never accept an environment URL or self-asserted label as authority. */
export function validateCandidateDriverDocker(
  args,
  { installationId, projects, image, helperImageId, ownedResources, offline } = {},
) {
  if (
    !Array.isArray(args) ||
    args.length > 160 ||
    args.some((arg) => typeof arg !== "string" || arg.length > 65536 || /[\0\r\n]/.test(arg))
  )
    deny();
  if (
    same(args, ["image", "inspect", image]) ||
    (helperImageId && same(args, ["image", "inspect", helperImageId]))
  )
    return { kind: "image" };
  if (helperImageId && same(args, ["image", "rm", helperImageId]))
    return { kind: "helper-image-remove" };
  const label = `io.codeshell.project-runtime.installation=${installationId}`;
  for (const kind of ["container", "network", "volume"]) {
    if (
      same(args, [
        kind,
        "ls",
        "-q",
        ...(kind === "container" ? ["-a"] : []),
        "--filter",
        `label=${label}`,
      ]) ||
      (kind === "container" && same(args, [kind, "ls", "-aq", "--filter", `label=${label}`]))
    )
      return { kind: "list", resource: kind };
  }
  for (const project of projects ?? []) {
    const names = candidateProjectNames(installationId, project);
    if (same(args, ["ps", "-q", "--filter", `volume=${names.workspace}`])) return { kind: "list" };
    for (const kind of ["container", "network", "volume"]) {
      const targets = kind === "volume" ? [names.data, names.workspace] : [names[kind]];
      for (const target of [...targets, ...(ownedResources?.get(kind) ?? [])]) {
        if (same(args, [kind, "inspect", target]))
          return { kind: "inspect", resource: kind, target };
        if (same(args, [kind, "rm", ...(kind === "container" ? ["-f"] : []), target]))
          return { kind: "remove", resource: kind, target };
      }
    }
    if (
      same(args, ["logs", names.container]) ||
      (ownedResources?.get("container")?.has(args[1]) && same(args, ["logs", args[1]]))
    )
      return { kind: "logs", target: args[1] };
    const interactive = args[1] === "-i";
    const targetIndex = interactive ? 2 : 1;
    const target = args[targetIndex];
    if (
      args[0] === "exec" &&
      (target === names.container || ownedResources?.get("container")?.has(target))
    ) {
      const command = args.slice(targetIndex + 1);
      if (
        same(command, ["node", "--input-type=module"]) ||
        (command[0] === "node" &&
          command[1] === "-e" &&
          command.length >= 3 &&
          command.length <= 5) ||
        same(command, ["/data/panel-bin/yt-dlp", "--ignore-config", "--version"]) ||
        same(command, ["cat", "/tmp/codeshell-real-speech/provider.log"]) ||
        same(command, [
          "mkdir",
          "-p",
          "/tmp/codeshell-real-speech",
          "/workspace/.code-shell/smoke-speech-runtime",
        ])
      )
        return { kind: "exec", target, targetIndex, project };
    }
  }
  if (offline && same(args, offline.args)) return { kind: "offline" };
  deny();
}
