import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  SettingsManager,
  scanSkills,
  invalidateSkillCache,
  userHome,
} from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import {
  assertSafeSkillName,
  assertOwnedSkillDirectory,
  readSkillBundle,
  readBoundedSkillFile,
  validateSkillMarkdown,
  skillRoot,
  stageSkillDirectory,
  commitSkillDirectory,
  editSkillMarkdown,
  removeOwnedSkill,
  SkillConflictError,
  inspectRepo,
  getRefCommit,
  downloadSkillTree,
  parseSkillSourceMeta,
  SKILL_META_FILE,
  type RepoInspection,
  type GithubUrlInfo,
  type SkillSourceMeta,
} from "@cjhyy/code-shell-core/internal/skills";
import { HubConfigurationError } from "./configuration.js";

const ROOT = "/api/v1/skills";
const REVIEW_TTL = 15 * 60_000;
const MAX_REVIEWS = 16;
const MAX_STAGED_BYTES = 128 * 1024 * 1024;

export interface HubSkillsOptions {
  cwd: string;
  dataDir: string;
  owner: (request: IncomingMessage) => Promise<string | null>;
  isAuthorized?: (request: IncomingMessage) => Promise<boolean>;
  withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
  now?: () => number;
  github?: {
    inspect: typeof inspectRepo;
    commit: typeof getRefCommit;
    download: typeof downloadSkillTree;
  };
}

type Origin = { kind: "github"; url: string; ref: string; commit: string };
export interface HubManagedSkill {
  name: string;
  description: string;
  source: "project" | "user" | "plugin" | "panel-app";
  enabled: boolean;
  editable: boolean;
  removable: boolean;
  revision: string;
  origin?: Origin;
  disabledReason?: string;
  readOnlyReason?: string;
}
type Review =
  | {
      owner: string;
      expiresAt: number;
      kind: "install";
      inspection: RepoInspection;
    }
  | {
      owner: string;
      expiresAt: number;
      kind: "update";
      name: string;
      revision: string;
      stage: string;
      bytes: number;
      latestCommit: string;
      currentCommit: string;
    };

/** Dispatch only after the host's authenticated same-origin API boundary. */
export function createHubSkills(options: HubSkillsOptions) {
  const now = options.now ?? Date.now;
  const github = options.github ?? {
    inspect: inspectRepo,
    commit: getRefCommit,
    download: downloadSkillTree,
  };
  const reviews = new Map<string, Review>();
  const roots = [
    join(options.cwd, ".code-shell", "skills"),
    join(options.cwd, ".agents", "skills"),
  ];
  let networkBusy = 0;
  let closed = false;

  function origin(meta: SkillSourceMeta | null): Origin | undefined {
    if (!meta) return undefined;
    return {
      kind: "github",
      url: `https://github.com/${meta.owner}/${meta.repo}`,
      ref: meta.ref,
      commit: meta.commit,
    };
  }

  function readMeta(file: string): SkillSourceMeta | null {
    try {
      return parseSkillSourceMeta(
        JSON.parse(
          readBoundedSkillFile(join(dirname(file), SKILL_META_FILE), 64 * 1024).toString("utf8"),
        ),
      );
    } catch {
      return null;
    }
  }

  function listed(name: unknown) {
    if (typeof name !== "string" || !name || name.length > 256)
      throw new HubConfigurationError(400, "Skill 名称无效。");
    invalidateSkillCache();
    const skill = scanSkills(options.cwd).find((entry) => entry.name === name);
    if (!skill) throw new HubConfigurationError(404, "找不到这个 Skill，请刷新后重试。");
    return skill;
  }

  function owned(name: unknown) {
    const skill = listed(name);
    if (skill.source !== "project")
      throw new HubConfigurationError(
        403,
        "这里只能修改当前工作区的 Skills；服务器用户、插件和 Panel App 的 Skills 由来源管理。",
      );
    assertOwnedSkillDirectory(skill.filePath, roots);
    return skill;
  }

  function snapshot(): { skills: HubManagedSkill[]; directories: string[] } {
    invalidateSkillCache();
    const manager = new SettingsManager(options.cwd, "full");
    const disabled = computeEffectiveDisabledLists(manager, options.cwd);
    const enabled = new Set(scanSkills(options.cwd, disabled).map((entry) => entry.name));
    const skills = scanSkills(options.cwd).map((skill): HubManagedSkill => {
      let editable = false;
      let revision = createHash("sha256").update(skill.content).digest("hex");
      let readOnlyReason: string | undefined;
      let source: Origin | undefined;
      if (skill.source === "project") {
        try {
          const dir = assertOwnedSkillDirectory(skill.filePath, roots);
          revision = readSkillBundle(dir).revision;
          editable = true;
          source = origin(readMeta(skill.filePath));
        } catch {
          readOnlyReason = "此 Skill 的目录结构或文件类型不支持在线修改，请在服务器上管理。";
        }
      } else {
        readOnlyReason =
          skill.source === "user"
            ? "服务器用户级 Skill，请在对应用户目录中管理。"
            : "由插件或 Panel App 管理，可在当前工作区启用或停用。";
      }
      return {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        enabled: enabled.has(skill.name),
        editable,
        removable: editable,
        revision,
        ...(source ? { origin: source } : {}),
        ...(readOnlyReason ? { readOnlyReason } : {}),
        ...(skill.source === "plugin" &&
        disabled.disabledPlugins.includes(skill.name.split(":", 1)[0]!)
          ? { disabledReason: "请先启用所属插件。" }
          : {}),
      };
    });
    return { skills, directories: [...roots, join(userHome(), ".code-shell", "skills")] };
  }

  async function discard(token: string): Promise<void> {
    const entry = reviews.get(token);
    reviews.delete(token);
    if (entry?.kind === "update")
      await fs.rm(entry.stage, { recursive: true, force: true }).catch(() => {});
  }

  async function prune(): Promise<void> {
    for (const [token, entry] of reviews) if (entry.expiresAt <= now()) await discard(token);
  }

  const sweep = setInterval(() => {
    void prune();
  }, 60_000);
  sweep.unref();

  async function issue(entry: Review): Promise<string> {
    await prune();
    if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
    if (reviews.size >= MAX_REVIEWS)
      throw new HubConfigurationError(429, "待确认的导入过多，请完成或稍后重试。");
    const stagedBytes = [...reviews.values()].reduce(
      (sum, value) => sum + (value.kind === "update" ? value.bytes : 0),
      0,
    );
    if (entry.kind === "update" && stagedBytes + entry.bytes > MAX_STAGED_BYTES)
      throw new HubConfigurationError(429, "待确认的更新文件过多，请先完成已有更新。");
    const token = randomBytes(32).toString("base64url");
    reviews.set(token, entry);
    return token;
  }

  async function reviewFor(token: unknown, owner: string, kind: Review["kind"]): Promise<Review> {
    await prune();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new HubConfigurationError(400, "请先预览来源，再确认导入。");
    const entry = reviews.get(token);
    if (!entry || entry.kind !== kind)
      throw new HubConfigurationError(409, "预览已失效，请重新检查来源。");
    if (entry.owner !== owner)
      throw new HubConfigurationError(403, "这个预览属于另一个设备，请在当前设备重新预览。");
    return entry;
  }

  async function network<T>(work: () => Promise<T>): Promise<T> {
    if (networkBusy >= 2)
      throw new HubConfigurationError(429, "已有来源检查或下载正在进行，请稍后重试。");
    networkBusy++;
    try {
      return await work();
    } finally {
      networkBusy--;
    }
  }

  async function authorizeWrite(req: IncomingMessage): Promise<void> {
    if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
    if (options.isAuthorized && !(await options.isAuthorized(req)))
      throw new HubConfigurationError(401, "登录已失效，请重新登录。");
    if (closed) throw new HubConfigurationError(503, "服务正在关闭。");
  }

  async function mutation<T>(req: IncomingMessage, work: () => Promise<T>): Promise<T> {
    await authorizeWrite(req);
    const write = async () => {
      await authorizeWrite(req);
      return work();
    };
    const result = options.withMutation ? await options.withMutation(write) : await write();
    await authorizeWrite(req);
    return result;
  }

  async function temporary(): Promise<string> {
    // Temporary downloads are not in any discovered Skill root and never execute.
    const base = join(options.dataDir, "skill-previews");
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(base);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("invalid preview directory");
    return fs.mkdtemp(join(base, "preview-"));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    try {
      const owner = await options.owner(req);
      if (!owner) throw new HubConfigurationError(401, "请先登录。");
      if (req.method === "GET" && url.pathname === ROOT) {
        json(res, 200, snapshot());
        return true;
      }
      if (req.method === "GET" && url.pathname === `${ROOT}/detail`) {
        const skill = listed(url.searchParams.get("name"));
        const summary = snapshot().skills.find((entry) => entry.name === skill.name)!;
        // Read-only external Skills use the scanner's already-discovered text.
        const content = summary.editable
          ? readSkillBundle(dirname(skill.filePath)).content
          : skill.content;
        json(res, 200, {
          name: skill.name,
          content,
          revision: summary.revision,
          editable: summary.editable,
          origin: summary.origin,
        });
        return true;
      }
      const body = await readBody(req);
      if (url.pathname === `${ROOT}/local`) {
        if (req.method === "POST") {
          fields(body, ["name", "content"]);
          const name = assertSafeSkillName(body.name);
          const content = validateSkillMarkdown(body.content);
          const stage = await temporary();
          try {
            await fs.writeFile(join(stage, "SKILL.md"), content, { mode: 0o600 });
            await mutation(req, async () => {
              if (scanSkills(options.cwd).some((entry) => entry.name === name))
                throw new HubConfigurationError(409, "已有同名 Skill，请修改名称。");
              const root = skillRoot("project", options.cwd, true);
              const localStage = await stageSkillDirectory(stage, root);
              try {
                await authorizeWrite(req);
                commitSkillDirectory(localStage, root, name);
              } finally {
                await fs.rm(localStage, { recursive: true, force: true });
              }
            });
            json(res, 201, { ok: true, message: "Skill 已创建。", name });
          } finally {
            await fs.rm(stage, { recursive: true, force: true });
          }
        } else if (req.method === "PUT" || req.method === "DELETE") {
          fields(
            body,
            req.method === "PUT" ? ["name", "content", "revision"] : ["name", "revision"],
          );
          const name = string(body.name, 256);
          const revision = revisionOf(body.revision);
          const content = req.method === "PUT" ? validateSkillMarkdown(body.content) : undefined;
          await mutation(req, async () => {
            await authorizeWrite(req);
            const skill = owned(name);
            if (content !== undefined) editSkillMarkdown(skill.filePath, roots, content, revision);
            else removeOwnedSkill(skill.filePath, roots, revision);
          });
          json(res, 200, {
            ok: true,
            message: content !== undefined ? "Skill 已保存。" : "Skill 已移除。",
            name,
          });
        } else throw new HubConfigurationError(405, "不支持这个操作。");
      } else if (url.pathname === `${ROOT}/github/preview` && req.method === "POST") {
        fields(body, ["url"]);
        const inspection = await network(() =>
          github.inspect(
            string(body.url, 8192),
            scanSkills(options.cwd).map((skill) => skill.name),
          ),
        );
        if (!inspection.commit) throw new Error("source preview is not pinned to a commit");
        if (options.isAuthorized && !(await options.isAuthorized(req)))
          throw new HubConfigurationError(401, "登录已失效。");
        const expiresAt = now() + REVIEW_TTL;
        const reviewToken = await issue({ kind: "install", owner, expiresAt, inspection });
        json(res, 200, {
          reviewToken,
          expiresAt,
          repoUrl: `https://github.com/${inspection.url.owner}/${inspection.url.repo}`,
          commit: inspection.commit,
          skills: inspection.skills,
          warning: inspection.warning,
        });
      } else if (url.pathname === `${ROOT}/github/install` && req.method === "POST") {
        fields(body, ["reviewToken", "pathInRepo", "name"]);
        const reviewed = await reviewFor(body.reviewToken, owner, "install");
        if (reviewed.kind !== "install") throw new Error("invalid review kind");
        const selected = reviewed.inspection.skills.find(
          (skill) => skill.pathInRepo === body.pathInRepo,
        );
        if (!selected) throw new HubConfigurationError(400, "只能导入刚刚预览过的 Skill。");
        const name = assertSafeSkillName(body.name ?? selected.name);
        const stage = await temporary();
        try {
          await network(() =>
            github.download(
              reviewed.inspection.url,
              reviewed.inspection.commit!,
              selected.dirInRepo,
              stage,
            ),
          );
          readSkillBundle(stage);
          const meta: SkillSourceMeta = {
            kind: "github",
            owner: reviewed.inspection.url.owner,
            repo: reviewed.inspection.url.repo,
            ref: reviewed.inspection.url.ref || reviewed.inspection.defaultBranch,
            dirInRepo: selected.dirInRepo,
            commit: reviewed.inspection.commit!,
            installedAt: new Date(now()).toISOString(),
          };
          await fs.writeFile(join(stage, SKILL_META_FILE), JSON.stringify(meta, null, 2), {
            mode: 0o600,
          });
          await mutation(req, async () => {
            await reviewFor(body.reviewToken, owner, "install");
            if (scanSkills(options.cwd).some((skill) => skill.name === name))
              throw new HubConfigurationError(409, "已有同名 Skill，请选择其他名称。");
            const root = skillRoot("project", options.cwd, true);
            const localStage = await stageSkillDirectory(stage, root);
            try {
              await authorizeWrite(req);
              commitSkillDirectory(localStage, root, name);
            } finally {
              await fs.rm(localStage, { recursive: true, force: true });
            }
            await discard(body.reviewToken as string);
          });
          json(res, 201, { ok: true, message: "Skill 及其脚本、资源已导入工作区。", name });
        } finally {
          await fs.rm(stage, { recursive: true, force: true });
        }
      } else if (url.pathname === `${ROOT}/github/update-preview` && req.method === "POST") {
        fields(body, ["name", "revision"]);
        const skill = owned(body.name);
        const revision = revisionOf(body.revision);
        if (readSkillBundle(dirname(skill.filePath)).revision !== revision)
          throw new SkillConflictError();
        const meta = readMeta(skill.filePath);
        if (!meta) throw new HubConfigurationError(400, "这个 Skill 没有有效的 GitHub 来源记录。");
        const info: GithubUrlInfo = { owner: meta.owner, repo: meta.repo };
        const latestCommit = await network(() => github.commit(info, meta.ref));
        if (latestCommit.toLowerCase() === meta.commit.toLowerCase()) {
          json(res, 200, {
            changed: false,
            name: skill.name,
            currentCommit: meta.commit,
            latestCommit,
          });
        } else {
          const stage = await temporary();
          let retained = false;
          try {
            await network(() => github.download(info, latestCommit, meta.dirInRepo, stage));
            const bundle = readSkillBundle(stage);
            await fs.writeFile(
              join(stage, SKILL_META_FILE),
              JSON.stringify(
                { ...meta, commit: latestCommit, installedAt: new Date(now()).toISOString() },
                null,
                2,
              ),
              { mode: 0o600 },
            );
            if (options.isAuthorized && !(await options.isAuthorized(req)))
              throw new HubConfigurationError(401, "登录已失效。");
            const expiresAt = now() + REVIEW_TTL;
            const reviewToken = await issue({
              owner,
              expiresAt,
              kind: "update",
              name: skill.name,
              revision,
              stage,
              bytes: bundle.bytes,
              currentCommit: meta.commit,
              latestCommit,
            });
            retained = true;
            json(res, 200, {
              changed: true,
              reviewToken,
              expiresAt,
              name: skill.name,
              currentCommit: meta.commit,
              latestCommit,
              content: bundle.content,
              files: bundle.files,
            });
          } finally {
            if (!retained) await fs.rm(stage, { recursive: true, force: true });
          }
        }
      } else if (url.pathname === `${ROOT}/github/update` && req.method === "POST") {
        fields(body, ["reviewToken"]);
        const reviewed = await reviewFor(body.reviewToken, owner, "update");
        if (reviewed.kind !== "update") throw new Error("invalid review kind");
        await mutation(req, async () => {
          await reviewFor(body.reviewToken, owner, "update");
          const skill = owned(reviewed.name);
          const dir = dirname(skill.filePath);
          const stage = await stageSkillDirectory(reviewed.stage, dirname(dir));
          try {
            await authorizeWrite(req);
            commitSkillDirectory(stage, dirname(dir), basename(dir), reviewed.revision);
          } finally {
            await fs.rm(stage, { recursive: true, force: true });
          }
          await discard(body.reviewToken as string);
        });
        json(res, 200, { ok: true, name: reviewed.name, message: "Skill 已更新到预览的版本。" });
      } else throw new HubConfigurationError(404, "找不到这个 Skills 接口。");
    } catch (error) {
      if (error instanceof HubConfigurationError) json(res, error.status, { error: error.message });
      else if (error instanceof SkillConflictError) json(res, 409, { error: error.message });
      else json(res, 400, { error: safeMessage(error) });
    }
    return true;
  }

  async function close() {
    closed = true;
    clearInterval(sweep);
    for (const token of [...reviews.keys()]) await discard(token);
  }
  return { handle, snapshot, close };
}

function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new HubConfigurationError(400, "请求包含不支持的字段。");
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new HubConfigurationError(400, "请求字段无效。");
  return value;
}
function revisionOf(value: unknown): string {
  const revision = string(value, 64);
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new HubConfigurationError(400, "请刷新 Skill 后重试。");
  return revision;
}
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // Forward authored validation/network messages, never local paths or arbitrary stack text.
  return /[\u3400-\u9fff]/.test(message) && message.length < 400
    ? message
    : "操作失败，原有 Skill 已保留。请检查来源或稍后重试。";
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new HubConfigurationError(415, "需要 JSON 请求。");
  const limit = 3 * 1024 * 1024;
  if (Number(req.headers["content-length"] ?? 0) > limit)
    throw new HubConfigurationError(413, "请求内容过大。");
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), 15_000);
  timer.unref();
  try {
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new HubConfigurationError(413, "请求内容过大。");
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HubConfigurationError(400, "JSON 格式无效。");
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
