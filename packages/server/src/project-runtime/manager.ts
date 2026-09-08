import type { HubSession } from "../hub/auth-store.js";
import {
  ProjectRegistry,
  ProjectRegistryError,
  projectView,
  type ProjectView,
  type StoredProject,
} from "./registry.js";
import type {
  ProjectRuntimeConnection,
  ProjectRuntimeProvider,
  ProjectRuntimeStatus,
} from "./types.js";

export interface ProjectManagerOptions {
  registry: ProjectRegistry;
  provider: ProjectRuntimeProvider;
  publicOrigin(): string;
  isSessionActive(session: HubSession): boolean;
  revokeProject(id: string): Promise<void>;
  maxRunning?: number;
  /** Clock seam for Docker observations; authorization is never cached. */
  now?: () => number;
}

/** Lifecycle and ownership live outside the project; all actual work runs inside it. */
export class ProjectManager {
  private readonly starts = new Map<string, Promise<ProjectView>>();
  private readonly stops = new Map<string, Promise<ProjectView>>();
  private readonly targets = new Map<string, ProjectRuntimeConnection>();
  private readonly statusChecks = new Map<
    string,
    {
      generation: number;
      url: string;
      expiresAt: number;
      promise: Promise<ProjectRuntimeStatus>;
    }
  >();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: ProjectManagerOptions) {
    if (
      !Number.isSafeInteger(options.maxRunning ?? 4) ||
      (options.maxRunning ?? 4) < 1 ||
      (options.maxRunning ?? 4) > 32
    )
      throw new Error("Project running limit must be between 1 and 32.");
  }

  private authorize(session: HubSession): void {
    if (this.closed) throw new ProjectRegistryError(503, "项目服务正在关闭。");
    if (!this.options.isSessionActive(session))
      throw new ProjectRegistryError(401, "登录已过期，请重新登录。");
  }

  async reconcile(): Promise<void> {
    this.statusChecks.clear();
    // Never adopt a previous controller's approvals or device credentials after a crash.
    for (const project of this.options.registry.all()) {
      if (project.generation === 0) continue;
      try {
        await this.options.provider.stop(project);
        this.options.registry.update(project.id, { status: "stopped" });
      } catch {
        this.options.registry.update(project.id, {
          status: "error",
          error: "无法确认旧运行环境已停止。请检查 Docker 后重试停止项目。",
        });
      }
    }
  }

  list(session: HubSession): ProjectView[] {
    this.authorize(session);
    return this.options.registry.list(session.username);
  }

  get(session: HubSession, id: string): ProjectView {
    this.authorize(session);
    return projectView(this.options.registry.get(session.username, id));
  }

  create(session: HubSession, name: unknown): ProjectView {
    this.authorize(session);
    return projectView(this.options.registry.create(session.username, name));
  }

  async start(session: HubSession, id: string): Promise<ProjectView> {
    this.authorize(session);
    this.options.registry.get(session.username, id);
    const stopping = this.stops.get(id);
    if (stopping) await stopping;
    this.authorize(session);
    const existing = this.starts.get(id);
    if (existing) {
      const result = await existing;
      this.authorize(session);
      return result;
    }
    const project = this.options.registry.get(session.username, id);
    if (project.status === "running") {
      await this.resolveTarget(session, id);
      return this.get(session, id);
    }
    const count = this.options.registry
      .all()
      .filter(
        (item) =>
          item.id !== id &&
          ["running", "starting", "stopping", "error"].includes(item.status) &&
          item.generation > 0,
      ).length;
    if (count >= (this.options.maxRunning ?? 4))
      throw new ProjectRegistryError(
        429,
        `最多同时运行 ${this.options.maxRunning ?? 4} 个项目，请先停止其他项目。`,
      );
    this.statusChecks.delete(id);
    const record = this.options.registry.update(id, {
      status: "starting",
      generation: project.generation + 1,
    });
    const operation = (async () => {
      try {
        await this.options.revokeProject(id);
        this.authorize(session);
        if (this.options.registry.get(session.username, id).status !== "starting")
          throw new ProjectRegistryError(409, "项目启动已取消。");
        const target = await this.options.provider.ensure(record, {
          publicOrigin: this.options.publicOrigin(),
        });
        this.authorize(session);
        const current = this.options.registry.get(session.username, id);
        if (current.status !== "starting" || current.generation !== record.generation)
          throw new ProjectRegistryError(409, "项目启动已取消。");
        if (target.generation !== record.generation) throw new Error("Runtime generation mismatch");
        this.targets.set(id, target);
        return projectView(this.options.registry.update(id, { status: "running" }));
      } catch (error) {
        this.statusChecks.delete(id);
        this.targets.delete(id);
        let stopped = true;
        try {
          await this.options.provider.stop(record);
        } catch {
          stopped = false;
        }
        const current = this.options.registry.get(session.username, id);
        if (current.generation === record.generation && current.status === "starting") {
          this.options.registry.update(id, {
            status: stopped ? "stopped" : "error",
            error: "项目未能启动。请检查 Docker 和项目镜像后重试。",
          });
        }
        if (error instanceof ProjectRegistryError) throw error;
        throw new ProjectRegistryError(503, "项目未能启动。请检查 Docker 和项目镜像后重试。");
      } finally {
        this.starts.delete(id);
      }
    })();
    this.starts.set(id, operation);
    return operation;
  }

  async stop(session: HubSession, id: string): Promise<ProjectView> {
    this.authorize(session);
    this.options.registry.get(session.username, id);
    const result = await this.beginStop(id);
    this.authorize(session);
    return result;
  }

  private beginStop(id: string): Promise<ProjectView> {
    const existing = this.stops.get(id);
    if (existing) return existing;
    const operation = this.stopProject(id);
    this.stops.set(id, operation);
    void operation
      .finally(() => {
        if (this.stops.get(id) === operation) this.stops.delete(id);
      })
      .catch(() => {});
    return operation;
  }

  private async stopProject(id: string): Promise<ProjectView> {
    this.statusChecks.delete(id);
    const record = this.options.registry.update(id, { status: "stopping" });
    this.targets.delete(id);
    // The proxy closes streams before trying the inner logout request. A failed
    // network logout must never prevent termination of the actual task runtime.
    await this.options.revokeProject(id).catch(() => {});
    try {
      await this.options.provider.stop(record);
      await this.starts.get(id)?.catch(() => {});
      return projectView(this.options.registry.update(id, { status: "stopped" }));
    } catch {
      return projectView(
        this.options.registry.update(id, {
          status: "error",
          error: "项目尚未确认停止，请检查 Docker 后重试。",
        }),
      );
    }
  }

  async resolveTarget(session: HubSession, id: string): Promise<ProjectRuntimeConnection> {
    this.authorize(session);
    const record = this.options.registry.get(session.username, id);
    const target = this.targets.get(id);
    if (record.status !== "running" || !target || target.generation !== record.generation)
      throw new ProjectRegistryError(409, "项目尚未运行，请先启动项目。");
    // The provider checks labels and the loopback binding, not just a remembered port.
    const state = await this.observeRuntime(record, target);
    this.authorize(session);
    const current = this.options.registry.get(session.username, id);
    if (current.status !== "running" || current.generation !== target.generation)
      throw new ProjectRegistryError(409, "项目已停止或重新启动，请重新进入。");
    if (state.state !== "running" || state.url !== target.url) {
      this.statusChecks.delete(id);
      this.targets.delete(id);
      this.options.registry.update(id, {
        status: "error",
        error: "运行环境已离线，请停止后重新启动。",
      });
      throw new ProjectRegistryError(503, "运行环境已离线，请停止后重新启动。");
    }
    return { ...target };
  }

  private observeRuntime(
    record: StoredProject,
    target: ProjectRuntimeConnection,
  ): Promise<ProjectRuntimeStatus> {
    const now = this.options.now ?? Date.now;
    const cached = this.statusChecks.get(record.id);
    if (
      cached &&
      cached.generation === record.generation &&
      cached.url === target.url &&
      cached.expiresAt > now()
    )
      return cached.promise;
    const entry = {
      generation: record.generation,
      url: target.url,
      // Pending checks share their provider deadline; completed checks live 2s.
      expiresAt: Infinity,
      promise: Promise.resolve<ProjectRuntimeStatus>({ state: "missing" }),
    };
    entry.promise = this.options.provider.status(record).then(
      (state) => {
        if (this.statusChecks.get(record.id) === entry) entry.expiresAt = now() + 2000;
        return state;
      },
      (error) => {
        if (this.statusChecks.get(record.id) === entry) this.statusChecks.delete(record.id);
        throw error;
      },
    );
    this.statusChecks.set(record.id, entry);
    return entry.promise;
  }

  /** Stop the affected runtime without relying on its already-revoked outer session. */
  async stopAfterRevocationFailure(id: string): Promise<void> {
    const result = await this.beginStop(id);
    if (result.status !== "stopped")
      throw new ProjectRegistryError(503, "项目尚未确认停止，请检查 Docker。");
  }

  /** Emergency fallback when an outer owner's affected projects are unavailable. */
  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.options.registry
        .all()
        .filter((project) => project.generation > 0 && project.status !== "stopped")
        .map((project) => this.beginStop(project.id)),
    );
    if (results.some((result) => result.status === "rejected" || result.value.status !== "stopped"))
      throw new ProjectRegistryError(503, "部分项目尚未确认停止，请检查 Docker。");
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.statusChecks.clear();
    return (this.closing = (async () => {
      try {
        await this.stopAll();
      } finally {
        await this.options.provider.close();
      }
    })());
  }
}
