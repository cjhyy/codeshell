import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
  SettingsManager,
  PanelAppAlreadyInstalledError,
  PanelAppInstallError,
  PanelAppReviewChangedError,
  assertSafePanelAppId,
  discoverGitPanelApps,
  installReviewedLocalPanelApp,
  invalidateSkillCache,
  listInstalledPanelApps,
  listProjectPanelApps,
  parsePanelAppPackagePins,
  retainInstalledPanelApp,
  userHome,
  panelAppsRoot,
  previewLocalPanelApp,
  resolvePanelAppBindingPolicy,
  uninstallPanelApp,
  type GitPanelAppSourceInput,
  type InstalledPanelApp,
  type PanelAppPreview,
  type PanelAppSourceInput,
} from "@cjhyy/code-shell-core";
import { mutateJsonFile } from "@cjhyy/code-shell-core/internal";
import { getRefCommit, parseGithubUrl } from "@cjhyy/code-shell-core/internal/skills";
import type {
  ManagedPanel,
  PanelCompatibility,
  PanelDiscovery,
  PanelGitSource,
  PanelOperationContext,
  PanelReview,
  PanelProjectReview,
  PanelSnapshot,
} from "./types.js";

const REVIEW_TTL = 8 * 60_000;
const MAX_REVIEWS = 8;
const MAX_NETWORK = 2;
const SHA = /^[a-f0-9]{40}$/i;
// All workspace services in one host share the same global installed catalog.
let catalogMutation: Promise<unknown> = Promise.resolve();

export class PanelManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PanelManagementError";
  }
}

export function publicPanelError(error: unknown): PanelManagementError {
  if (error instanceof PanelManagementError) return error;
  if (error instanceof PanelAppReviewChangedError || error instanceof PanelAppAlreadyInstalledError)
    return new PanelManagementError(409, "conflict", "面板或来源已经变化，请重新预览后操作。");
  // Core's shared GitHub reader throws ordinary Errors. Preserve actionable
  // upstream failures without exposing arbitrary filesystem or transport text.
  const cause = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
  } | null;
  const message = typeof cause?.message === "string" ? cause.message : "";
  const code = String(cause?.code ?? cause?.cause?.code ?? "");
  if (/GitHub.*(?:速率限制|rate.?limit|(?:API|HTTP)\s+429)/i.test(message))
    return new PanelManagementError(
      429,
      "github_rate_limit",
      "GitHub 请求次数已达到限制，请稍后重试。已安装的面板仍可使用。",
    );
  if (
    cause?.name === "AbortError" ||
    cause?.name === "TimeoutError" ||
    /(?:ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)/.test(code) ||
    /GitHub.*(?:timed?\s*out|timeout|aborted)/i.test(message)
  )
    return new PanelManagementError(
      504,
      "github_timeout",
      "连接 GitHub 超时，请检查服务端网络后重试。",
    );
  if (
    /找不到仓库（404）|GitHub.*(?:repository or ref was not found|(?:API|HTTP)\s+404)/i.test(
      message,
    )
  )
    return new PanelManagementError(
      404,
      "github_not_found",
      "找不到这个公开 GitHub 仓库、分支或标签，请检查来源地址。",
    );
  if (/GitHub.*(?:拒绝访问.*403|(?:API|HTTP)\s+403)/i.test(message))
    return new PanelManagementError(
      403,
      "github_forbidden",
      "GitHub 拒绝访问这个来源，请检查仓库是否公开及服务端网络。",
    );
  if (/GitHub.*(?:API|HTTP)\s+5\d\d/i.test(message))
    return new PanelManagementError(503, "github_unavailable", "GitHub 暂时不可用，请稍后重试。");
  if (
    /(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET)/.test(code) ||
    /^(?:fetch failed|Failed to fetch)$/i.test(message) ||
    /GitHub source download failed/i.test(message)
  )
    return new PanelManagementError(
      502,
      "github_network",
      "服务端无法连接 GitHub，请检查网络、DNS 或代理设置后重试。",
    );
  if (error instanceof PanelAppInstallError)
    return new PanelManagementError(400, "invalid_source", error.message);
  if ((error as { status?: unknown })?.status === 409)
    return new PanelManagementError(409, "busy", "任务正在运行，请结束后修改面板。");
  return new PanelManagementError(503, "unavailable", "面板操作未完成，请刷新后重试。");
}

export interface PanelManagementOptions {
  /** Already authorized concrete workspace; never selected by request bodies. */
  cwd: string;
  /** Host-authorized main project for a worktree. Defaults to the exact cwd. */
  bindingCwd?: string;
  /** Enable only when every runtime in this Host selects the project package. */
  projectPackages?: boolean;
  /** Explicit opt-in for a trusted native caller; never enabled on HTTP services. */
  allowLocalSources?: boolean;
  /** Recheck a host-verified, frozen project/worktree association before use. */
  assertBinding?: () => void;
  withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
  onChanged?: (
    id: string,
    kind: "install" | "update" | "binding" | "remove",
  ) => void | Promise<void>;
  compatibility?: (app: Pick<PanelAppPreview, "permissions" | "agent">) => PanelCompatibility;
  now?: () => number;
  /** Network seam only; production still uses the reviewed Core installer. */
  resolveCommit?: typeof getRefCommit;
}

interface StoredOrigin {
  source: PanelGitSource;
  lastUpdated: string;
}
type Origins = Record<string, StoredOrigin>;
interface HeldReview {
  owner: string;
  generation: number;
  public: PanelProjectReview;
  source: PanelAppSourceInput;
  origin?: PanelGitSource;
  digest: string;
  projectState: string;
  catalogState?: string;
}

function invalid(): never {
  throw new PanelManagementError(400, "invalid_request", "面板请求参数无效。");
}

function originFile(): string {
  const root = panelAppsRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new PanelManagementError(403, "unsafe_path", "面板安装目录必须是普通目录。");
  return join(root, ".web-sources.json");
}

function origins(change?: (current: Origins) => void): Origins {
  return mutateJsonFile<Origins, Origins>(originFile(), {
    maxBytes: 1024 * 1024,
    mode: 0o600,
    parse(raw) {
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid panel origins");
      return parsed;
    },
    serialize: (value) => JSON.stringify(value),
    mutation(current) {
      change?.(current);
      return { ...(change ? { value: current } : {}), result: current };
    },
  })!;
}

function inputSource(input: unknown): {
  source: GitPanelAppSourceInput;
  owner: string;
  repo: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["kind", "url", "ref", "subdir"].includes(key)) ||
    (value.kind !== undefined && value.kind !== "git") ||
    typeof value.url !== "string"
  )
    invalid();
  const raw = value.url.trim();
  const url = /^[\w.-]+\/[\w.-]+\/?$/.test(raw) ? `https://github.com/${raw}` : raw;
  let parsed: ReturnType<typeof parseGithubUrl>;
  try {
    const checked = new URL(url);
    if (checked.search || checked.hash || /\/blob\//.test(checked.pathname)) invalid();
    parsed = parseGithubUrl(url);
  } catch {
    invalid();
  }
  if (
    (value.ref !== undefined && typeof value.ref !== "string") ||
    (value.subdir !== undefined && typeof value.subdir !== "string") ||
    (value.ref && parsed.ref) ||
    (value.subdir && parsed.subpath)
  )
    invalid();
  const ref = (value.ref as string | undefined)?.trim() || parsed.ref || "HEAD";
  const subdir = (value.subdir as string | undefined)?.trim() || parsed.subpath;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  )
    invalid();
  if (
    subdir &&
    (subdir.length > 1024 ||
      subdir.includes("\\") ||
      subdir.includes("\0") ||
      subdir
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.startsWith(".")))
  )
    invalid();
  return {
    source: {
      kind: "git",
      url: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
      ref,
      ...(subdir ? { subdir } : {}),
    },
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string") invalid();
  try {
    assertSafePanelAppId(id);
  } catch {
    invalid();
  }
}

function assertRevision(revision: unknown): asserts revision is string {
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) invalid();
}

export function createPanelManagement(options: PanelManagementOptions) {
  const now = options.now ?? Date.now;
  const workspace = resolve(options.bindingCwd ?? options.cwd);
  const hasProject = workspace !== resolve(join(userHome(), ".code-shell", "no-repo"));
  const reviews = new Map<string, HeldReview>();
  const generations = new Map<string, number>();
  let closed = false;
  let networkBusy = 0;
  const compatibility = options.compatibility ?? (() => ({ supported: true, reasons: [] }));
  const generation = (owner: string) => generations.get(owner) ?? 0;

  async function assertAuthorized(
    context: PanelOperationContext,
    expected = generation(context.ownerId),
  ) {
    if (closed || generation(context.ownerId) !== expected || !(await context.authorize()))
      throw new PanelManagementError(401, "login_required", "登录已失效，请重新登录。");
    options.assertBinding?.();
  }

  function policy(project?: Record<string, unknown>) {
    const manager = new SettingsManager(workspace, "full");
    return resolvePanelAppBindingPolicy(
      manager.getForScope("user") as Record<string, unknown>,
      project ?? (manager.getForScope("project", workspace) as Record<string, unknown>),
      hasProject,
    );
  }

  function revision(app: InstalledPanelApp, digest: string, project?: Record<string, unknown>) {
    const current = policy(project);
    return createHash("sha256")
      .update(
        JSON.stringify({
          app,
          digest,
          ...(options.projectPackages
            ? { pin: parsePanelAppPackagePins(project ?? projectSettings())[app.id] ?? null }
            : {}),
          bound: current.boundApps.has(app.id),
          disabled: current.globalDisabledApps.has(app.id),
        }),
      )
      .digest("hex");
  }

  function projectSettings(): Record<string, unknown> {
    return new SettingsManager(workspace, "full").getRawForScope("project", workspace, {
      strict: true,
    });
  }

  // Compare the app-specific state under the project settings lock after package
  // installation. Installing bytes must never overwrite another device's binding.
  function projectState(id: string, project = projectSettings()): string {
    const current = policy(project);
    return JSON.stringify({
      bound: current.boundApps.has(id),
      disabled: current.globalDisabledApps.has(id),
      pin: options.projectPackages ? (parsePanelAppPackagePins(project)[id] ?? null) : null,
    });
  }

  const listApps = () =>
    options.projectPackages ? listProjectPanelApps(workspace) : listInstalledPanelApps();

  async function inspectApp(app: InstalledPanelApp) {
    const info = lstatSync(app.installPath);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new PanelManagementError(403, "unsafe_path", "面板安装目录不支持链接。");
    const preview = await previewLocalPanelApp({ kind: "dir", path: app.installPath });
    return { app, digest: preview.reviewToken };
  }

  async function selectedApp(id: string) {
    const app = (await listApps()).find((item) => item.id === id);
    if (!app) throw new PanelManagementError(404, "not_found", "找不到这个面板，请刷新列表。");
    return inspectApp(app);
  }

  async function catalogState(id: string): Promise<string> {
    const app = (await listInstalledPanelApps()).find((item) => item.id === id);
    return JSON.stringify(app ? await inspectApp(app) : null);
  }

  function savedSource(app: InstalledPanelApp, saved: Origins): PanelGitSource | undefined {
    if (typeof app.source === "string") return;
    const record = saved[app.id];
    if (
      record &&
      record.lastUpdated === app.lastUpdated &&
      record.source?.url === app.source.url &&
      record.source?.ref === app.source.ref &&
      SHA.test(record.source.commit)
    )
      return record.source;
    const parsed = inputSource(app.source);
    return {
      ...parsed.source,
      ref: parsed.source.ref ?? "HEAD",
      commit: SHA.test(parsed.source.ref ?? "") ? parsed.source.ref! : "",
    };
  }

  async function snapshot(): Promise<PanelSnapshot> {
    options.assertBinding?.();
    const project = projectSettings();
    const current = policy(project);
    const saved = origins();
    const panels: ManagedPanel[] = [];
    for (const listed of await listApps()) {
      const { app, digest } = await inspectApp(listed);
      const source = savedSource(app, saved);
      const {
        installPath: _path,
        source: _source,
        installedAt: _installedAt,
        lastUpdated: _lastUpdated,
        ...publicApp
      } = app;
      const support = compatibility(app);
      panels.push({
        ...publicApp,
        revision: revision(app, digest, project),
        bound: current.boundApps.has(app.id),
        globalDisabled: current.globalDisabledApps.has(app.id),
        enabled:
          current.hasProject &&
          current.boundApps.has(app.id) &&
          !current.globalDisabledApps.has(app.id) &&
          support.supported,
        updatable: Boolean(source),
        source: source
          ? {
              ...source,
              label: `${new URL(source.url).pathname.replace(/^\/|\.git$/g, "")}${source.subdir ? `/${source.subdir}` : ""}`,
            }
          : { kind: "local", label: basename(app.source as string) },
        compatibility: support,
      });
    }
    // Never attach a new revision to stale displayed binding state. File and
    // package inspection above can yield to another device's mutation.
    for (const app of panels) {
      const pin = options.projectPackages ? parsePanelAppPackagePins(project)[app.id] : undefined;
      if (
        projectState(app.id, project) !== projectState(app.id) ||
        current.globalDisabledApps.has(app.id) !== policy().globalDisabledApps.has(app.id) ||
        (pin && (pin.packageDigest !== app.packageDigest || pin.version !== app.version))
      )
        throw new PanelManagementError(409, "conflict", "项目面板配置已改变，请刷新后重试。");
    }
    return { panels, workspace, hasProject };
  }

  async function network<T>(
    context: PanelOperationContext,
    work: (guard: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const expected = generation(context.ownerId);
    const guard = () => assertAuthorized(context, expected);
    await guard();
    if (networkBusy >= MAX_NETWORK)
      throw new PanelManagementError(429, "busy", "已有来源检查正在进行，请稍后重试。");
    networkBusy++;
    try {
      const result = await work(guard);
      await guard();
      return result;
    } finally {
      networkBusy--;
    }
  }

  async function pinned(input: unknown, guard: () => Promise<void>): Promise<PanelGitSource> {
    const parsed = inputSource(input);
    const ref = parsed.source.ref ?? "HEAD";
    const commit = SHA.test(ref)
      ? ref.toLowerCase()
      : await (options.resolveCommit ?? getRefCommit)(
          { owner: parsed.owner, repo: parsed.repo },
          ref,
        );
    await guard();
    if (!SHA.test(commit))
      throw new PanelManagementError(502, "invalid_source", "GitHub 没有返回有效的提交版本。");
    return { ...parsed.source, ref, commit: commit.toLowerCase() };
  }

  function prune() {
    for (const [token, value] of reviews)
      if (value.public.expiresAt <= now()) reviews.delete(token);
  }

  async function issue(
    context: PanelOperationContext,
    input: unknown,
    current?: { app: InstalledPanelApp; digest: string; revision: string; catalogState: string },
  ): Promise<PanelReview> {
    return network(context, async (guard) => {
      prune();
      if (reviews.size >= MAX_REVIEWS)
        throw new PanelManagementError(429, "busy", "待确认的面板过多，请先完成已有预览。");
      const source = await pinned(input, guard);
      const pinnedSource: GitPanelAppSourceInput = {
        kind: "git",
        url: source.url,
        ref: source.commit,
        ...(source.subdir ? { subdir: source.subdir } : {}),
      };
      const preview = await previewLocalPanelApp(pinnedSource);
      await guard();
      if (current && preview.id !== current.app.id)
        throw new PanelManagementError(409, "conflict", "来源中的面板标识已经改变。");
      if (!current && preview.alreadyInstalled)
        throw new PanelManagementError(
          409,
          "already_installed",
          "这个面板已经安装，请从列表检查更新。",
        );
      const { reviewToken: digest, ...publicPreview } = preview;
      const reviewToken = randomBytes(32).toString("base64url");
      const value: PanelReview = {
        reviewToken,
        expiresAt: now() + REVIEW_TTL,
        kind: current ? "update" : "install",
        preview: publicPreview,
        source,
        expectedRevision: current?.revision ?? null,
        compatibility: compatibility(preview),
      };
      reviews.set(reviewToken, {
        owner: context.ownerId,
        generation: generation(context.ownerId),
        public: value,
        source: pinnedSource,
        origin: source,
        digest,
        projectState: projectState(preview.id),
        catalogState: current?.catalogState,
      });
      return value;
    });
  }

  async function issueProjectSource(
    context: PanelOperationContext,
    input: PanelAppSourceInput,
    expected?: { id: string; revision: string },
  ): Promise<PanelProjectReview> {
    if (!options.allowLocalSources || !options.projectPackages || !hasProject)
      throw new PanelManagementError(403, "unsupported", "这个入口不支持本地项目安装。");
    return network(context, async (guard) => {
      prune();
      if (reviews.size >= MAX_REVIEWS)
        throw new PanelManagementError(429, "busy", "待确认的面板过多，请先完成已有预览。");
      if (!input || typeof input !== "object") invalid();
      let source: PanelAppSourceInput;
      let origin: PanelGitSource | undefined;
      if (input.kind === "git") {
        origin = await pinned(input, guard);
        source = {
          kind: "git",
          url: origin.url,
          ref: origin.commit,
          ...(origin.subdir ? { subdir: origin.subdir } : {}),
        };
      } else {
        if (
          (input.kind !== "dir" && input.kind !== "zip") ||
          typeof input.path !== "string" ||
          !isAbsolute(input.path) ||
          input.path.length > 8192 ||
          input.path.includes("\0")
        )
          invalid();
        source = { kind: input.kind, path: input.path };
      }
      const preview = await previewLocalPanelApp(source);
      await guard();
      if (expected && preview.id !== expected.id)
        throw new PanelManagementError(409, "conflict", "来源中的面板标识已经改变。");
      const listed = (await listApps()).find((app) => app.id === preview.id);
      const current = listed ? await inspectApp(listed) : undefined;
      const currentRevision = current ? revision(current.app, current.digest) : null;
      if (expected && currentRevision !== expected.revision)
        throw new PanelManagementError(409, "conflict", "面板已改变，请刷新后重试。");
      const catalog = await catalogState(preview.id);
      await guard();
      const { reviewToken: digest, ...publicPreview } = preview;
      const value: PanelProjectReview = {
        reviewToken: randomBytes(32).toString("base64url"),
        expiresAt: now() + REVIEW_TTL,
        kind: current ? "update" : "install",
        preview: publicPreview,
        expectedRevision: currentRevision,
        compatibility: compatibility(preview),
        ...(current ? { installedVersion: current.app.version } : {}),
      };
      reviews.set(value.reviewToken, {
        owner: context.ownerId,
        generation: generation(context.ownerId),
        public: value,
        source,
        origin,
        digest,
        projectState: projectState(preview.id),
        catalogState: catalog,
      });
      return value;
    });
  }

  async function mutate<T>(
    context: PanelOperationContext,
    work: (guard: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const expected = generation(context.ownerId);
    const guard = () => assertAuthorized(context, expected);
    const run = async () => {
      await guard();
      const write = async () => {
        await guard();
        return work(guard);
      };
      return options.withMutation ? options.withMutation(write) : write();
    };
    const next = catalogMutation.then(run, run);
    catalogMutation = next.catch(() => undefined);
    return next;
  }

  function setBinding(
    app: InstalledPanelApp,
    bound: boolean,
    expected?:
      | { app: InstalledPanelApp; digest: string; revision: string }
      | { projectState: string },
  ) {
    options.assertBinding?.();
    if (!hasProject)
      throw new PanelManagementError(400, "project_required", "请先选择项目，再绑定面板。");
    const manager = new SettingsManager(workspace, "full");
    manager.mutateSettingsForScope("project", workspace, (current) => {
      options.assertBinding?.();
      if (
        expected &&
        ("revision" in expected
          ? revision(expected.app, expected.digest, current) !== expected.revision
          : projectState(app.id, current) !== expected.projectState)
      )
        throw new PanelManagementError(409, "conflict", "面板配置已改变，请刷新后重试。");
      const bindings = new Set(
        Array.isArray(current.panelAppBindings)
          ? current.panelAppBindings.filter((value): value is string => typeof value === "string")
          : [],
      );
      if (bound) bindings.add(app.id);
      else bindings.delete(app.id);
      current.panelAppBindings = [...bindings].sort();
      if (options.projectPackages) {
        const pins = parsePanelAppPackagePins(current);
        if (bound) {
          if (!app.packageDigest) throw new Error("Cannot bind an unverified Panel package");
          pins[app.id] = { version: app.version, packageDigest: app.packageDigest };
        } else delete pins[app.id];
        current.panelAppPins = pins;
      }
      const overrides =
        current.panelAppOverrides &&
        typeof current.panelAppOverrides === "object" &&
        !Array.isArray(current.panelAppOverrides)
          ? { ...(current.panelAppOverrides as Record<string, unknown>) }
          : {};
      // Clear legacy overrides only for this app; a stale `on` must not defeat unbind.
      delete overrides[app.id];
      current.panelAppOverrides = overrides;
    });
    invalidateSkillCache();
  }

  return {
    snapshot,
    assertAuthorized,
    async discover(context: PanelOperationContext, input: unknown): Promise<PanelDiscovery> {
      return network(context, async (guard) => {
        const source = await pinned(input, guard);
        const result = await discoverGitPanelApps({
          kind: "git",
          url: source.url,
          ref: source.commit,
          ...(source.subdir ? { subdir: source.subdir } : {}),
        });
        await guard();
        // Keep the selected branch in candidates; preview resolves and pins it again.
        return {
          ...result,
          source,
          panels: result.panels.map((item) => ({
            ...item,
            source: { ...item.source, ref: source.ref },
          })),
        };
      });
    },
    preview: (context: PanelOperationContext, input: unknown) => issue(context, input),
    async previewUpdate(context: PanelOperationContext, id: unknown, expected: unknown) {
      assertId(id);
      assertRevision(expected);
      await assertAuthorized(context);
      const current = await selectedApp(id);
      const currentRevision = revision(current.app, current.digest);
      if (currentRevision !== expected)
        throw new PanelManagementError(409, "conflict", "面板已改变，请刷新后重试。");
      const source = savedSource(current.app, origins());
      if (!source)
        throw new PanelManagementError(
          400,
          "local_source",
          "这个面板由本地来源安装，请在桌面端更新。",
        );
      const { commit: _commit, ...input } = source;
      return issue(context, input, {
        ...current,
        revision: currentRevision,
        catalogState: await catalogState(id),
      });
    },
    previewProjectSource: issueProjectSource,
    async previewProjectUpdate(context: PanelOperationContext, id: unknown, expected: unknown) {
      if (!options.allowLocalSources || !options.projectPackages || !hasProject)
        throw new PanelManagementError(403, "unsupported", "这个入口不支持本地项目安装。");
      assertId(id);
      assertRevision(expected);
      await assertAuthorized(context);
      const { app, digest } = await selectedApp(id);
      if (revision(app, digest) !== expected)
        throw new PanelManagementError(409, "conflict", "面板已改变，请刷新后重试。");
      let input: PanelAppSourceInput;
      if (typeof app.source !== "string") input = app.source;
      else {
        const info = statSync(app.source);
        if (info.isDirectory()) input = { kind: "dir", path: app.source };
        else if (info.isFile() && extname(app.source).toLowerCase() === ".zip")
          input = { kind: "zip", path: app.source };
        else throw new PanelManagementError(400, "invalid_source", "原始来源不是文件夹或 ZIP 包。");
      }
      return issueProjectSource(context, input, { id, revision: expected });
    },
    async install(
      context: PanelOperationContext,
      token: unknown,
      bind = true,
      approval?: { overwrite?: boolean; expectedId?: string },
    ) {
      if (typeof token !== "string" || typeof bind !== "boolean") invalid();
      prune();
      const held = reviews.get(token);
      if (!held)
        throw new PanelManagementError(409, "review_expired", "预览已失效，请重新检查来源。");
      if (held.owner !== context.ownerId)
        throw new PanelManagementError(403, "review_owner", "请在当前设备重新预览这个来源。");
      await assertAuthorized(context, held.generation);
      if (approval?.expectedId && approval.expectedId !== held.public.preview.id) invalid();
      if (approval && held.public.kind === "update" && !approval.overwrite)
        throw new PanelManagementError(
          409,
          "already_installed",
          "这个面板已经安装，请确认项目更新。",
        );
      return mutate(context, async (guard) => {
        await assertAuthorized(context, held.generation);
        if (reviews.get(token) !== held || held.public.expiresAt <= now())
          throw new PanelManagementError(409, "review_expired", "预览已失效，请重新检查来源。");
        const id = held.public.preview.id;
        if (held.public.kind === "update") {
          const current = await selectedApp(id);
          if (
            revision(current.app, current.digest) !== held.public.expectedRevision ||
            (await catalogState(id)) !== held.catalogState
          )
            throw new PanelManagementError(409, "conflict", "面板已改变，请重新检查更新。");
        } else if ((await listInstalledPanelApps()).some((item) => item.id === id))
          throw new PanelManagementError(
            409,
            "already_installed",
            "这个面板已经安装，请检查更新。",
          );
        if (projectState(id) !== held.projectState)
          throw new PanelManagementError(409, "conflict", "项目面板配置已改变，请重新预览。");
        await guard();
        const installed = await installReviewedLocalPanelApp(
          held.source,
          held.digest,
          new Date(now()).toISOString(),
          {
            overwrite: held.public.kind === "update",
            expectedId: id,
            recordedRef: held.origin?.ref,
            beforeCommit: async () => {
              if (held.public.kind === "update") {
                const current = await selectedApp(id);
                if (
                  revision(current.app, current.digest) !== held.public.expectedRevision ||
                  (await catalogState(id)) !== held.catalogState
                )
                  throw new PanelManagementError(409, "conflict", "面板已改变，请重新检查更新。");
              }
              if (projectState(id) !== held.projectState)
                throw new PanelManagementError(409, "conflict", "项目面板配置已改变，请重新预览。");
              await guard();
            },
          },
        );
        reviews.delete(token);
        origins((value) => {
          if (held.origin) value[id] = { source: held.origin, lastUpdated: installed.lastUpdated };
          else delete value[id];
        });
        await guard();
        if (bind && hasProject && held.public.compatibility.supported)
          setBinding(installed, true, { projectState: held.projectState });
        invalidateSkillCache();
        await options.onChanged?.(id, held.public.kind);
        return { id, packageDigest: installed.packageDigest };
      });
    },
    async binding(
      context: PanelOperationContext,
      id: unknown,
      bound: unknown,
      expected: unknown,
    ): Promise<PanelSnapshot> {
      assertId(id);
      assertRevision(expected);
      if (typeof bound !== "boolean") invalid();
      return mutate(context, async (guard) => {
        const current = await selectedApp(id);
        if (bound && !compatibility(current.app).supported)
          throw new PanelManagementError(
            400,
            "unsupported",
            "这个面板需要当前 Web 环境未提供的能力。",
          );
        // Legacy installs need a retained copy before the project can pin them.
        // An already pinned project must keep its selected version, not the catalog's.
        const app =
          bound &&
          options.projectPackages &&
          !parsePanelAppPackagePins(projectSettings())[current.app.id]
            ? await retainInstalledPanelApp(current.app.id, current.app.packageDigest!)
            : current.app;
        await guard();
        setBinding(app, bound, { ...current, revision: expected });
        await options.onChanged?.(id, "binding");
        return snapshot();
      });
    },
    async remove(context: PanelOperationContext, id: unknown, expected: unknown) {
      assertId(id);
      assertRevision(expected);
      return mutate(context, async (guard) => {
        const current = await selectedApp(id);
        if (revision(current.app, current.digest) !== expected)
          throw new PanelManagementError(409, "conflict", "面板已改变，请刷新后重试。");
        await guard();
        await uninstallPanelApp(id, {
          beforeCommit: async () => {
            const latest = await selectedApp(id);
            if (revision(latest.app, latest.digest) !== expected)
              throw new PanelManagementError(409, "conflict", "面板已改变，请刷新后重试。");
            await guard();
          },
        });
        origins((value) => {
          delete value[id];
        });
        if (hasProject) setBinding(current.app, false);
        invalidateSkillCache();
        await options.onChanged?.(id, "remove");
        return { removed: true as const };
      });
    },
    cancelOwner(owner: string) {
      generations.set(owner, generation(owner) + 1);
      for (const [token, held] of reviews) if (held.owner === owner) reviews.delete(token);
    },
    close() {
      closed = true;
      reviews.clear();
    },
  };
}
