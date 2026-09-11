import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer } from "node:net";

export interface HyperframesProgress {
  phase: "inspect" | "check" | "render" | "preview" | "cache";
  message: string;
  progress?: number;
}
export interface HyperframesContext {
  signal?: AbortSignal;
  onProgress?: (event: HyperframesProgress) => void | Promise<void>;
}
export interface HyperframesRuntimeOptions {
  projectDir?: string;
  cliPath?: string;
  nodePath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}
export interface HyperframesRuntime {
  available: boolean;
  version?: string;
  nodeVersion?: string;
  cliPath?: string;
  nodePath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  browserPath?: string;
  checks: { name: string; ok: boolean; detail: string }[];
}
export interface HyperframesSceneParams {
  kind: "chapter" | "explainer";
  title: string;
  subtitle?: string;
  eyebrow?: string;
  bullets?: string[];
  durationSeconds?: number;
  width?: number;
  height?: number;
  palette?: { background: string; foreground: string; accent: string };
}
export interface HyperframesSource {
  projectDir: string;
  sourcePath: string;
  paramsPath: string;
  contentHash: string;
  kind: "generated" | "imported";
  width?: number;
  height?: number;
  durationSeconds?: number;
  pinnedVersion?: string;
  externalUrls: string[];
  packageDependencies: string[];
}
export interface HyperframesRenderResult extends HyperframesSource {
  artifactPath: string;
  cached: boolean;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  format: "mp4";
  rendererVersion: string;
}
export interface HyperframesPreview {
  url: string;
  stop(): Promise<void>;
}
export interface HyperframesAdapterOptions extends HyperframesRuntimeOptions {
  workspaceRoot: string;
  cacheRoot: string;
}

const TEMPLATE_VERSION = 1;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_SOURCE_FILES = 10_000;
const MAX_LOG_BYTES = 1024 * 1024;
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hyperframes",
  "renders",
  "snapshots",
  ".debug",
]);
const META_NAME = ".codeshell-hyperframes.json";

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("HyperFrames operation cancelled", "AbortError");
}
function report(ctx: HyperframesContext, event: HyperframesProgress): void {
  void Promise.resolve(ctx.onProgress?.(event)).catch(() => {});
}
function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    /* Already exited. */
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }, 1500);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}
function executionEnvironment(runtime?: HyperframesRuntime): NodeJS.ProcessEnv {
  const paths = [runtime?.ffmpegPath, runtime?.ffprobePath, runtime?.nodePath]
    .filter(Boolean)
    .map((path) => dirname(path!));
  return {
    ...process.env,
    PATH: [...new Set([...paths, ...(process.env.PATH ?? "").split(delimiter)])].join(delimiter),
    ELECTRON_RUN_AS_NODE: "1",
    HYPERFRAMES_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  };
}
async function run(
  executable: string,
  args: string[],
  options: HyperframesContext & {
    cwd?: string;
    runtime?: HyperframesRuntime;
    timeoutMs?: number;
    phase?: HyperframesProgress["phase"];
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  abort(options.signal);
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: executionEnvironment(options.runtime),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const onAbort = () => terminate(child);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        terminate(child);
      },
      options.timeoutMs ?? 10 * 60_000,
    );
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const message = chunk.toString();
      if (stream === "stdout") stdout = (stdout + message).slice(-MAX_LOG_BYTES);
      else stderr = (stderr + message).slice(-MAX_LOG_BYTES);
      const match = [...message.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)%/g)].at(-1);
      // Progress crosses the host/guest boundary. Keep raw compiler logs (which
      // contain internal paths) in the bounded command result, not in UI events.
      if (options.phase && match) {
        const progress = Math.min(1, Number(match[1]) / 100);
        report(options, {
          phase: options.phase,
          message: `HyperFrames ${options.phase} ${Math.round(progress * 100)}%`,
          progress,
        });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted)
        reject(new DOMException("HyperFrames operation cancelled", "AbortError"));
      else if (timedOut) reject(new Error("HyperFrames command timed out"));
      else if (code !== 0)
        reject(
          new Error(`HyperFrames command failed (${code}): ${(stderr || stdout).slice(-4000)}`),
        );
      else resolveRun({ stdout, stderr });
    });
  });
}
async function executablePath(name: string, explicit?: string): Promise<string | undefined> {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
  ];
  const choices = explicit
    ? [explicit]
    : directories
        .filter(isAbsolute)
        .map((dir) => join(dir, process.platform === "win32" ? `${name}.exe` : name));
  for (const path of choices) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {
      /* Try next installed path. */
    }
  }
  return undefined;
}
async function discoverCli(options: HyperframesRuntimeOptions): Promise<string | undefined> {
  if (options.cliPath) {
    await access(options.cliPath, constants.R_OK);
    return realpath(options.cliPath);
  }
  const candidates: string[] = [];
  if (options.projectDir)
    candidates.push(join(options.projectDir, "node_modules/hyperframes/bin/hyperframes.mjs"));
  const global = await executablePath("hyperframes");
  if (global) candidates.push(global);
  const cache = join(homedir(), ".npm/_npx");
  try {
    const entries = await readdir(cache, { withFileTypes: true });
    for (const entry of entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 100)) {
      candidates.push(join(cache, entry.name, "node_modules/hyperframes/bin/hyperframes.mjs"));
    }
  } catch {
    /* A fresh host may have no npm cache. */
  }
  for (const path of candidates) {
    try {
      await access(path, constants.R_OK);
      return realpath(path);
    } catch {
      /* Not installed here. */
    }
  }
  return undefined;
}

/** Read only: never downloads packages, changes project pins, or installs Chrome. */
export async function detectHyperframesRuntime(
  options: HyperframesRuntimeOptions = {},
): Promise<HyperframesRuntime> {
  const runtime: HyperframesRuntime = { available: false, checks: [] };
  runtime.nodePath = await executablePath("node", options.nodePath);
  runtime.ffmpegPath = await executablePath("ffmpeg", options.ffmpegPath);
  runtime.ffprobePath = await executablePath("ffprobe", options.ffprobePath);
  try {
    runtime.cliPath = await discoverCli(options);
  } catch (error) {
    runtime.checks.push({ name: "HyperFrames", ok: false, detail: String(error) });
  }
  for (const [name, path, versionArgs] of [
    ["Node.js", runtime.nodePath, ["--version"]],
    ["FFmpeg", runtime.ffmpegPath, ["-version"]],
    ["FFprobe", runtime.ffprobePath, ["-version"]],
  ] as const) {
    try {
      if (!path) throw new Error(`${name} is not installed`);
      const result = await run(path, [...versionArgs], { runtime, timeoutMs: 15_000 });
      const version = result.stdout.split("\n")[0]!.trim();
      if (name === "Node.js") {
        runtime.nodeVersion = version;
        if (Number(version.replace(/^v/, "").split(".")[0]) < 22)
          throw new Error("Node.js 22 or newer is required");
      }
      runtime.checks.push({ name, ok: true, detail: version });
    } catch (error) {
      runtime.checks.push({ name, ok: false, detail: String(error) });
    }
  }
  if (runtime.cliPath && runtime.nodePath) {
    try {
      const result = await run(runtime.nodePath, [runtime.cliPath, "--version"], {
        runtime,
        timeoutMs: 20_000,
      });
      runtime.version = result.stdout.trim();
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(runtime.version))
        throw new Error("Unrecognized HyperFrames version");
      runtime.checks.push({ name: "HyperFrames", ok: true, detail: runtime.version });
      const browser = await run(runtime.nodePath, [runtime.cliPath, "browser", "path"], {
        runtime,
        timeoutMs: 20_000,
      });
      const browserPath = browser.stdout.trim().split("\n").at(-1)!;
      if (!isAbsolute(browserPath)) throw new Error("Bundled Chrome is not available");
      await access(browserPath, constants.X_OK);
      runtime.browserPath = browserPath;
      runtime.checks.push({ name: "Chrome", ok: true, detail: browserPath });
    } catch (error) {
      runtime.checks.push({ name: "HyperFrames / Chrome", ok: false, detail: String(error) });
    }
  } else if (!runtime.checks.some((check) => check.name === "HyperFrames")) {
    runtime.checks.push({
      name: "HyperFrames",
      ok: false,
      detail: "Install HyperFrames with Node.js 22+, then install its bundled Chrome",
    });
  }
  runtime.available =
    runtime.checks.every((check) => check.ok) && Boolean(runtime.version && runtime.browserPath);
  return runtime;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}
async function within(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(resolve(root, path));
  if (!inside(canonicalRoot, canonical))
    throw new Error("HyperFrames path is outside its authorized workspace");
  return canonical;
}
async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function sourceFiles(
  projectDir: string,
): Promise<{ path: string; hash: string; size: number }[]> {
  const files: { path: string; hash: string; size: number }[] = [];
  let total = 0;
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        SKIP_DIRECTORIES.has(entry.name) ||
        entry.name === META_NAME ||
        entry.name === ".DS_Store"
      )
        continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("HyperFrames source snapshots do not follow symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const size = (await lstat(path)).size;
        total += size;
        if (total > MAX_SOURCE_BYTES || files.length >= MAX_SOURCE_FILES)
          throw new Error("HyperFrames source exceeds the 1 GiB / 10,000 file import limit");
        files.push({
          path: relative(projectDir, path).split(sep).join("/"),
          hash: await digestFile(path),
          size,
        });
      } else throw new Error("HyperFrames sources must contain regular files");
    }
  }
  await visit(projectDir);
  return files;
}
function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function text(value: unknown, max: number, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new Error(`Invalid HyperFrames ${field}`);
  return value.trim();
}
function number(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid HyperFrames ${field}`);
  return value;
}
function normalizeParams(params: HyperframesSceneParams): Required<HyperframesSceneParams> {
  if (!params || !["chapter", "explainer"].includes(params.kind))
    throw new Error("Scene kind must be chapter or explainer");
  const width = number(params.width ?? 1920, 320, 3840, "width"),
    height = number(params.height ?? 1080, 180, 3840, "height");
  if (!Number.isInteger(width / 2) || !Number.isInteger(height / 2))
    throw new Error("MP4 scene dimensions must be even integers");
  const palette = params.palette ?? {
    background: "#142823",
    foreground: "#f2f4e9",
    accent: "#b5e3ac",
  };
  for (const value of Object.values(palette))
    if (!/^#[\da-fA-F]{6}$/.test(value))
      throw new Error("Scene palette requires six-digit hex colors");
  if (!palette.background || !palette.foreground || !palette.accent)
    throw new Error("Scene palette requires background, foreground and accent");
  if (params.bullets !== undefined && (!Array.isArray(params.bullets) || params.bullets.length > 4))
    throw new Error("Explainer scenes support up to four points");
  return {
    kind: params.kind,
    title: text(params.title, 120, "title"),
    subtitle: params.subtitle ? text(params.subtitle, 240, "subtitle") : "",
    eyebrow: params.eyebrow
      ? text(params.eyebrow, 60, "eyebrow")
      : params.kind === "chapter"
        ? "CHAPTER"
        : "EXPLAINER",
    bullets: (params.bullets ?? []).map((line) => text(line, 140, "bullet")),
    durationSeconds: number(params.durationSeconds ?? 4, 0.5, 60, "duration"),
    width,
    height,
    palette: { ...palette },
  };
}
function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
function sceneHtml(p: Required<HyperframesSceneParams>): string {
  const unit = Math.min(p.width / 1280, p.height / 720);
  const titleSize = Math.round((p.kind === "explainer" ? 64 : 84) * unit);
  const points =
    p.kind === "explainer"
      ? p.bullets
          .map(
            (line, index) =>
              `<li><span class="point-number">${String(index + 1).padStart(2, "0")}</span><span>${escape(line)}</span></li>`,
          )
          .join("")
      : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${escape(p.title)}</title>
<meta name="viewport" content="width=${p.width}, height=${p.height}">
<style>
*{box-sizing:border-box}body{margin:0;background:${p.palette.background};color:${p.palette.foreground};font-family:system-ui,sans-serif}
#scene{position:relative;width:${p.width}px;height:${p.height}px;overflow:hidden} .clip{position:absolute;inset:0;padding:${Math.round(64 * unit)}px;display:flex;flex-direction:column;justify-content:center;gap:${Math.round(24 * unit)}px}
.eyebrow{font:600 ${Math.max(14, Math.round(18 * unit))}px ui-monospace,monospace;letter-spacing:.18em;color:${p.palette.accent};margin:0}h1{font-size:${titleSize}px;line-height:1.16;letter-spacing:-.035em;font-weight:750;margin:0;max-width:94%;overflow-wrap:anywhere} .subtitle{font-size:${Math.round(28 * unit)}px;line-height:1.5;max-width:88%;margin:0}ul{padding:0;margin:0;display:flex;flex-direction:column;gap:${Math.round(15 * unit)}px;list-style:none}li{display:flex;gap:${Math.round(22 * unit)}px;align-items:baseline;font-size:${Math.round(27 * unit)}px;line-height:1.45}.point-number{color:${p.palette.accent};font-family:monospace}.progress{position:absolute;left:0;bottom:0;width:100%;height:${Math.max(3, Math.round(5 * unit))}px;background:${p.palette.accent};transform-origin:left center}
</style></head><body><div id="scene" data-composition-id="scene" data-no-timeline data-width="${p.width}" data-height="${p.height}" data-duration="${p.durationSeconds}">
<section id="scene-content" class="clip" data-start="0" data-duration="${p.durationSeconds}" data-track-index="0"><p class="eyebrow">${escape(p.eyebrow)}</p><h1>${escape(p.title)}</h1>${p.subtitle ? `<p class="subtitle">${escape(p.subtitle)}</p>` : ""}${points ? `<ul>${points}</ul>` : ""}</section><div class="progress" data-layout-ignore="true"></div></div>
<script>
const duration=${p.durationSeconds * 1000};
for(const [index,element] of [...document.querySelectorAll('.eyebrow,h1,.subtitle,li')].entries()){
const effect=element.animate([{opacity:0,transform:'translateY(18px)'},{opacity:1,transform:'translateY(0)'}],{duration:Math.min(550,duration*.22),delay:Math.min(index*100,duration*.3),fill:'both',iterations:1,easing:'cubic-bezier(.2,.7,.2,1)'});effect.pause();}
const progress=document.querySelector('.progress').animate([{transform:'scaleX(0)'},{transform:'scaleX(1)'}],{duration,fill:'both',iterations:1});progress.pause();
</script></body></html>\n`;
}
async function inspectDirectory(
  projectDir: string,
  kind: HyperframesSource["kind"],
): Promise<HyperframesSource> {
  const sourcePath = join(projectDir, "index.html");
  if ((await stat(sourcePath)).size > 8 * 1024 * 1024)
    throw new Error("HyperFrames index.html exceeds 8 MiB");
  const html = await readFile(sourcePath, "utf8");
  const root = /<[a-z][^>]*\bdata-composition-id\s*=\s*["'][^"']+["'][^>]*>/i.exec(html)?.[0];
  if (!root) throw new Error("index.html does not contain a HyperFrames composition root");
  const attr = (name: string) => {
    const value = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(root)?.[1];
    return value && Number.isFinite(Number(value)) ? Number(value) : undefined;
  };
  const files = await sourceFiles(projectDir);
  const externalUrls = new Set<string>();
  for (const file of files.filter(
    (file) => /\.(html|css|js|mjs)$/i.test(file.path) && file.size <= 8 * 1024 * 1024,
  )) {
    const source = await readFile(join(projectDir, file.path), "utf8");
    for (const match of source.matchAll(/https?:\/\/[^\s"'<>`)]+/g)) externalUrls.add(match[0]);
  }
  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  } catch {
    /* Optional project metadata. */
  }
  const pin = Object.values(pkg.scripts ?? {})
    .join(" ")
    .match(/hyperframes@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
  return {
    projectDir,
    sourcePath,
    paramsPath: join(projectDir, META_NAME),
    contentHash: contentHash(files),
    kind,
    width: attr("data-width"),
    height: attr("data-height"),
    durationSeconds: attr("data-duration"),
    pinnedVersion: pin,
    externalUrls: [...externalUrls],
    packageDependencies: [
      ...new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]),
    ].sort(),
  };
}
async function probeVideo(
  runtime: HyperframesRuntime,
  path: string,
  signal?: AbortSignal,
): Promise<{ durationSeconds: number; width: number; height: number; fps: number }> {
  const result = await run(
    runtime.ffprobePath!,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate:format=duration",
      "-of",
      "json",
      path,
    ],
    { runtime, signal, timeoutMs: 30_000 },
  );
  const info = JSON.parse(result.stdout) as {
    streams?: { codec_name: string; width: number; height: number; r_frame_rate: string }[];
    format?: { duration: string };
  };
  const stream = info.streams?.[0];
  const durationSeconds = Number(info.format?.duration);
  if (
    !stream ||
    stream.codec_name !== "h264" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  )
    throw new Error("HyperFrames output is not a valid H.264 MP4");
  const [n, d] = stream.r_frame_rate.split("/").map(Number);
  const fps = n! / d!;
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isSafeInteger(stream.width) ||
    !Number.isSafeInteger(stream.height) ||
    stream.width <= 0 ||
    stream.height <= 0
  )
    throw new Error("HyperFrames output has invalid video dimensions or frame rate");
  return { durationSeconds, width: stream.width, height: stream.height, fps };
}

export function createHyperframesAdapter(options: HyperframesAdapterOptions) {
  let runtimePromise: Promise<HyperframesRuntime> | undefined;
  const runtime = async () => {
    runtimePromise ??= detectHyperframesRuntime(options);
    const found = await runtimePromise;
    if (!found.available)
      throw new Error(
        `HyperFrames is unavailable: ${found.checks
          .filter((check) => !check.ok)
          .map((check) => check.detail)
          .join("; ")}`,
      );
    return found;
  };
  const cacheRoot = resolve(options.cacheRoot);
  const prepare = async () => {
    await mkdir(join(cacheRoot, "sources"), { recursive: true });
    await mkdir(join(cacheRoot, "renders"), { recursive: true });
  };
  async function managed(source: HyperframesSource): Promise<HyperframesSource> {
    await prepare();
    const dir = await within(join(cacheRoot, "sources"), source.projectDir);
    return inspectDirectory(dir, source.kind);
  }
  async function inspectProject(relativeDir: string): Promise<HyperframesSource> {
    if (typeof relativeDir !== "string" || !relativeDir || isAbsolute(relativeDir))
      throw new Error("HyperFrames import requires a workspace-relative directory");
    const dir = await within(options.workspaceRoot, relativeDir);
    return inspectDirectory(dir, "imported");
  }
  async function createScene(
    params: HyperframesSceneParams,
    ctx: HyperframesContext = {},
  ): Promise<HyperframesSource> {
    abort(ctx.signal);
    await prepare();
    const p = normalizeParams(params),
      found = await runtime();
    const key = contentHash({ template: TEMPLATE_VERSION, params: p });
    const target = join(cacheRoot, "sources", key);
    try {
      await access(join(target, META_NAME));
      return await inspectDirectory(target, "generated");
    } catch {
      /* First creation. */
    }
    const temporary = join(cacheRoot, "sources", `.tmp-${randomUUID()}`);
    await mkdir(temporary);
    try {
      await writeFile(join(temporary, "index.html"), sceneHtml(p));
      await writeFile(
        join(temporary, "hyperframes.json"),
        JSON.stringify({ skill: "general-video" }, null, 2),
      );
      await writeFile(
        join(temporary, "package.json"),
        JSON.stringify(
          {
            private: true,
            scripts: {
              check: `npx hyperframes@${found.version} check`,
              render: `npx hyperframes@${found.version} render`,
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(temporary, META_NAME),
        JSON.stringify(
          { schemaVersion: 1, templateVersion: TEMPLATE_VERSION, kind: "generated", params: p },
          null,
          2,
        ),
      );
      abort(ctx.signal);
      await rename(temporary, target).catch(async (error) => {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" &&
          (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        )
          throw error;
      });
      report(ctx, {
        phase: "inspect",
        message: "Parameterized HyperFrames source saved",
        progress: 1,
      });
      return inspectDirectory(target, "generated");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async function importProject(
    relativeDir: string,
    ctx: HyperframesContext = {},
  ): Promise<HyperframesSource> {
    abort(ctx.signal);
    await prepare();
    const original = await inspectProject(relativeDir),
      files = await sourceFiles(original.projectDir);
    const target = join(cacheRoot, "sources", original.contentHash);
    try {
      await access(join(target, META_NAME));
      return await inspectDirectory(target, "imported");
    } catch {
      /* New source snapshot. */
    }
    const temporary = join(cacheRoot, "sources", `.tmp-${randomUUID()}`);
    await mkdir(temporary);
    try {
      for (const file of files) {
        abort(ctx.signal);
        await mkdir(dirname(join(temporary, file.path)), { recursive: true });
        await copyFile(join(original.projectDir, file.path), join(temporary, file.path));
        if ((await digestFile(join(temporary, file.path))) !== file.hash)
          throw new Error("HyperFrames source changed during import; retry the snapshot");
      }
      await writeFile(
        join(temporary, META_NAME),
        JSON.stringify(
          {
            schemaVersion: 1,
            kind: "imported",
            originalRelativeDir: relative(
              await realpath(options.workspaceRoot),
              original.projectDir,
            ),
            sourceHash: original.contentHash,
            files,
          },
          null,
          2,
        ),
      );
      await rename(temporary, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      });
      return inspectDirectory(target, "imported");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async function check(source: HyperframesSource, ctx: HyperframesContext = {}): Promise<unknown> {
    const current = await managed(source),
      found = await runtime();
    report(ctx, {
      phase: "check",
      message: "Checking HyperFrames source, layout, motion and runtime",
      progress: 0,
    });
    const result = await run(
      found.nodePath!,
      [found.cliPath!, "check", current.projectDir, "--json"],
      { ...ctx, runtime: found, phase: "check", timeoutMs: 180_000 },
    );
    const parsed = JSON.parse(result.stdout);
    if (parsed.ok !== true)
      throw new Error(`HyperFrames check did not pass: ${JSON.stringify(parsed).slice(-4000)}`);
    await mkdir(join(current.projectDir, ".hyperframes"), { recursive: true });
    await writeFile(
      join(current.projectDir, ".hyperframes/codeshell-check.json"),
      JSON.stringify(parsed, null, 2),
    );
    report(ctx, { phase: "check", message: "HyperFrames checks passed", progress: 1 });
    return parsed;
  }
  async function render(
    source: HyperframesSource,
    ctx: HyperframesContext & { quality?: "draft" | "standard" | "high"; fps?: 24 | 30 | 60 } = {},
  ): Promise<HyperframesRenderResult> {
    abort(ctx.signal);
    const current = await managed(source),
      found = await runtime();
    const quality = ctx.quality ?? "standard",
      fps = ctx.fps ?? 30;
    if (!["draft", "standard", "high"].includes(quality) || ![24, 30, 60].includes(fps))
      throw new Error("Invalid HyperFrames render quality or fps");
    const key = contentHash({ source: current.contentHash, version: found.version, quality, fps });
    const directory = join(cacheRoot, "renders", key),
      artifactPath = join(directory, "scene.mp4"),
      manifestPath = join(directory, "render.json");
    // Remote URLs are not content-addressed source dependencies; never reuse
    // their rendered output as though the local source hash described them.
    if (!current.externalUrls.length) {
      try {
        const stored = JSON.parse(await readFile(manifestPath, "utf8"));
        if (stored.artifactHash === (await digestFile(artifactPath))) {
          const video = await probeVideo(found, artifactPath, ctx.signal);
          report(ctx, {
            phase: "cache",
            message: "Reused verified HyperFrames scene render",
            progress: 1,
          });
          return {
            ...current,
            ...video,
            artifactPath,
            cached: true,
            format: "mp4",
            rendererVersion: found.version!,
          };
        }
      } catch {
        abort(ctx.signal); /* Missing or damaged cache is rendered again. */
      }
    }
    await check(current, ctx);
    abort(ctx.signal);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.partial-${randomUUID()}.mp4`);
    try {
      report(ctx, { phase: "render", message: "Rendering scene with HyperFrames", progress: 0 });
      await run(
        found.nodePath!,
        [
          found.cliPath!,
          "render",
          current.projectDir,
          "--output",
          temporary,
          "--format",
          "mp4",
          "--quality",
          quality,
          "--fps",
          String(fps),
          "--workers",
          "1",
          "--strict",
          "--no-best-effort",
        ],
        { ...ctx, runtime: found, phase: "render", timeoutMs: 30 * 60_000 },
      );
      abort(ctx.signal);
      const video = await probeVideo(found, temporary, ctx.signal);
      if (
        current.durationSeconds &&
        Math.abs(video.durationSeconds - current.durationSeconds) > Math.max(0.15, 2 / fps)
      )
        throw new Error("HyperFrames output duration does not match its source");
      if (
        (current.width && video.width !== current.width) ||
        (current.height && video.height !== current.height) ||
        Math.abs(video.fps - fps) > 0.01
      )
        throw new Error("HyperFrames output dimensions or frame rate do not match the request");
      const artifactHash = await digestFile(temporary);
      if ((await managed(current)).contentHash !== current.contentHash)
        throw new Error("HyperFrames source changed during rendering; retry with the new source");
      await rename(temporary, artifactPath);
      const result: HyperframesRenderResult = {
        ...current,
        ...video,
        artifactPath,
        cached: false,
        format: "mp4",
        rendererVersion: found.version!,
      };
      const temporaryManifest = join(directory, `.render-${randomUUID()}.json`);
      await writeFile(temporaryManifest, JSON.stringify({ ...result, artifactHash }, null, 2));
      await rename(temporaryManifest, manifestPath);
      report(ctx, { phase: "render", message: "HyperFrames MP4 verified", progress: 1 });
      return result;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function preview(
    source: HyperframesSource,
    ctx: HyperframesContext & { port?: number } = {},
  ): Promise<HyperframesPreview> {
    const current = await managed(source),
      found = await runtime();
    await check(current, ctx);
    abort(ctx.signal);
    let port = ctx.port;
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535))
      throw new Error("Preview port must be between 1024 and 65535");
    if (!port)
      port = await new Promise<number>((resolvePort, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const chosen = typeof address === "object" && address ? address.port : 0;
          server.close((error) => (error ? reject(error) : resolvePort(chosen)));
        });
      });
    const url = `http://127.0.0.1:${port}/#project/${encodeURIComponent(basename(current.projectDir))}`;
    const child = spawn(
      found.nodePath!,
      [
        found.cliPath!,
        "preview",
        current.projectDir,
        "--foreground",
        "--json",
        "--no-open",
        "--port",
        String(port),
      ],
      {
        cwd: current.projectDir,
        env: executionEnvironment(found),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let closed = false,
      error: Error | undefined,
      log = "";
    const closing = new Promise<void>((resolveClose) => {
      child.once("close", () => {
        closed = true;
        resolveClose();
      });
    });
    child.once("error", (failure) => {
      error = failure;
    });
    child.stdout.on("data", (data: Buffer) => {
      log = (log + data.toString()).slice(-4000);
    });
    child.stderr.on("data", (data: Buffer) => {
      log = (log + data.toString()).slice(-4000);
    });
    const stop = async () => {
      if (!closed) terminate(child);
      await closing;
      ctx.signal?.removeEventListener("abort", stop);
    };
    ctx.signal?.addEventListener("abort", stop, { once: true });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        abort(ctx.signal);
        if (closed || error) throw error ?? new Error(`HyperFrames preview stopped: ${log}`);
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            report(ctx, { phase: "preview", message: "HyperFrames Studio is ready", progress: 1 });
            return { url, stop };
          }
        } catch {
          /* Server is starting. */
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
      throw new Error(`HyperFrames preview did not start: ${log}`);
    } catch (failure) {
      await stop();
      throw failure;
    }
  }
  return {
    inspectProject,
    createScene,
    importProject,
    check,
    render,
    preview,
    detectRuntime: () => detectHyperframesRuntime(options),
  };
}
