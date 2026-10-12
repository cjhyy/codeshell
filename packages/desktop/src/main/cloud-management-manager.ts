import type { CloudManagementRequest, CloudManagementResult } from "../shared/cloud-management.js";
import type { CloudAccountManager } from "./cloud-account-manager.js";
import {
  cloudManagementRequest,
  cloudObject,
  cloudProject,
  cloudManagementTarget,
  managedCloudGrant,
  managedCloudPartition,
  type ManagedCloudGrant,
} from "./cloud-management-contract.js";
import {
  CloudManagementHttpError,
  createCloudManagementTransport,
  type CloudManagementTransport,
} from "./cloud-management-http.js";

export interface ManagedCloudWindows {
  open(input: {
    grant: ManagedCloudGrant;
    projectId: string;
    authorized: () => boolean;
  }): Promise<{ address: string }>;
  close(partition: string): Promise<void>;
}
interface Entry {
  key: string;
  grant: ManagedCloudGrant;
  signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  retiring?: Promise<boolean>;
}
/** Explicit Main-only Cloud operations. Construction never connects or loads credentials. */
export class CloudManagementManager {
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly retired = new Set<Entry>();
  private readonly request: CloudManagementTransport;
  constructor(
    private readonly deps: {
      account: Pick<CloudAccountManager, "captureRootAccount">;
      windows: ManagedCloudWindows;
      request?: CloudManagementTransport;
      now?: () => number;
    },
  ) {
    this.request = deps.request ?? createCloudManagementTransport();
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private key(input: CloudManagementRequest) {
    return JSON.stringify([input.cloudOrigin, input.accountOrigin, input.accountId]);
  }
  private newEntry(key: string, grant: ManagedCloudGrant, signal: AbortSignal): Entry {
    const created: Entry = {
      key,
      grant,
      signal,
      timer: undefined as never,
      abort: () => {
        void this.retire(key, created, true).catch(() => {});
      },
    };
    created.timer = setTimeout(created.abort, Math.max(1, grant.session.expiresAt - this.now()));
    created.timer.unref?.();
    return created;
  }
  private retire(key: string, entry: Entry, remote: boolean): Promise<boolean> {
    if (entry.retiring) return entry.retiring;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    this.retired.add(entry);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    // close() destroys windows synchronously before its cookie cleanup awaits.
    const pending = (async () => {
      let local: Promise<{ ok: true } | { ok: false; error: unknown }>;
      try {
        local = this.deps.windows.close(managedCloudPartition(entry.grant)).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      } catch (error) {
        local = Promise.resolve({ ok: false, error });
      }
      let confirmed = !remote || entry.grant.session.expiresAt <= this.now();
      if (remote && !confirmed) {
        try {
          const ack = cloudObject(
            await this.request({
              origin: entry.grant.session.audience,
              path: "/api/v1/cloud-management/logout",
              method: "POST",
              token: entry.grant.token,
              body: {},
            }),
          );
          confirmed = ack.revoked === true;
        } catch {
          confirmed = false;
        }
      }
      const cleanup = await local;
      if (!cleanup.ok) throw cleanup.error;
      if (confirmed) this.retired.delete(entry);
      return confirmed;
    })();
    entry.retiring = pending;
    void pending
      .finally(() => {
        if (entry.retiring === pending) entry.retiring = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async retireAccount(identity: { origin: string; accountId: string }) {
    const owned = new Set([...this.entries.values(), ...this.retired]);
    const results = await Promise.allSettled(
      [...owned]
        .filter(
          (e) =>
            e.grant.session.accountOrigin === identity.origin &&
            e.grant.session.accountId === identity.accountId,
        )
        .map((entry) => this.retire(entry.key, entry, true)),
    );
    if (results.some((r) => r.status === "rejected"))
      throw new Error("云端窗口清理未完成，请重试退出。");
  }
  manage(raw: unknown, authorized: () => boolean): Promise<CloudManagementResult> {
    if (this.closed) throw new Error("云端管理正在关闭。");
    const input = cloudManagementRequest(raw);
    const lease = this.deps.account.captureRootAccount(
      input.accountOrigin,
      input.accountId,
      authorized,
    );
    const key = this.key(input);
    const pending = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.perform(input, key, lease));
    this.queues.set(key, pending);
    void pending
      .finally(() => {
        if (this.queues.get(key) === pending) this.queues.delete(key);
      })
      .catch(() => {});
    return pending;
  }
  private async perform(
    input: CloudManagementRequest,
    key: string,
    lease: ReturnType<CloudAccountManager["captureRootAccount"]>,
  ): Promise<CloudManagementResult> {
    const alive = () => {
      if (this.closed) throw new Error("云端管理正在关闭。");
      lease.current();
    };
    const signal = AbortSignal.any([lease.signal, this.shutdown.signal]);
    alive();
    let entry = this.entries.get(key);
    if (entry && (entry.signal !== lease.signal || entry.grant.session.expiresAt <= this.now())) {
      await this.retire(key, entry, true);
      entry = undefined;
      alive();
    }
    if (input.action === "logout") {
      const owned = new Set([...this.retired].filter((e) => e.key === key));
      if (entry) owned.add(entry);
      const results = await Promise.all([...owned].map((e) => this.retire(key, e, true)));
      alive();
      if (results.some((confirmed) => !confirmed))
        throw new Error("本机云端窗口已关闭；服务端未确认撤销，请联网后重试或在账号中撤销会话。");
      return { action: "logout", revoked: true };
    }
    if (!entry) {
      const target = cloudManagementTarget(
        await this.request({
          origin: input.cloudOrigin,
          path: "/api/v1/cloud-management/capabilities",
          method: "GET",
          signal,
        }),
        input,
      );
      alive();
      const ticket = await lease.ticket(target.cloudOrigin, target.installationId);
      alive();
      const value = await this.request({
        origin: input.cloudOrigin,
        path: "/api/v1/cloud-management/session",
        method: "POST",
        body: { ticket: ticket.ticket },
        signal,
      });
      const grant = managedCloudGrant(value, input, this.now());
      if (grant.session.installationId !== target.installationId) {
        const orphan = this.newEntry(key, grant, lease.signal);
        void this.retire(key, orphan, true).catch(() => {});
        throw new Error("云端安装身份已变化，请重新连接。");
      }
      try {
        alive();
      } catch (error) {
        const orphan = this.newEntry(key, grant, lease.signal);
        void this.retire(key, orphan, true).catch(() => {});
        throw error;
      }
      const created = this.newEntry(key, grant, lease.signal);
      lease.signal.addEventListener("abort", created.abort, { once: true });
      this.entries.set(key, created);
      entry = created;
    }
    const current = () => {
      alive();
      if (this.entries.get(key) !== entry || entry!.grant.session.expiresAt <= this.now())
        throw new Error("云端管理授权已失效，请重新连接。");
    };
    current();
    const path =
      input.action === "list" || input.action === "create"
        ? "/api/v1/projects"
        : `/api/v1/projects/${input.projectId}/${input.action}`;
    try {
      const value = cloudObject(
        await this.request({
          origin: input.cloudOrigin,
          path,
          method: input.action === "list" ? "GET" : "POST",
          token: entry.grant.token,
          ...(input.action === "list"
            ? {}
            : { body: input.action === "create" ? { name: input.name } : {} }),
          signal,
        }),
      );
      current();
      if (input.action === "list") {
        if (
          value.runtime !== "docker" ||
          typeof value.available !== "boolean" ||
          !Array.isArray(value.projects) ||
          value.projects.length > 4096 ||
          (value.error !== undefined &&
            (typeof value.error !== "string" ||
              value.error.length > 2048 ||
              /[\x00-\x1f\x7f]/.test(value.error)))
        )
          throw new Error("云端项目列表无效。");
        const projects = value.projects.map(cloudProject);
        if (new Set(projects.map((p) => p.id)).size !== projects.length)
          throw new Error("云端项目列表无效。");
        return {
          action: "list",
          available: value.available,
          ...(value.error === undefined ? {} : { error: value.error as string }),
          projects,
        };
      }
      const project = cloudProject(value.project);
      if (input.action !== "create" && project.id !== input.projectId)
        throw new Error("云端返回了其他项目，请重新加载。");
      if (input.action === "open") {
        const address = `${input.cloudOrigin}/?project=${input.projectId}`;
        if (value.url !== address || project.status !== "running")
          throw new Error("云端项目入口无效。");
        await this.deps.windows.open({
          grant: entry.grant,
          projectId: input.projectId,
          authorized: () => {
            try {
              current();
              return true;
            } catch {
              return false;
            }
          },
        });
        current();
        return { action: "open", project, address };
      }
      return { action: input.action, project };
    } catch (error) {
      if (input.action === "open") await this.retire(key, entry, true);
      if (error instanceof CloudManagementHttpError && [401, 403].includes(error.status))
        await this.retire(key, entry, true);
      throw error;
    }
  }
  async dispose() {
    this.closed = true;
    this.shutdown.abort();
    const owned = new Set([...this.entries.values(), ...this.retired]);
    await Promise.allSettled([...owned].map((entry) => this.retire(entry.key, entry, true)));
  }
}
