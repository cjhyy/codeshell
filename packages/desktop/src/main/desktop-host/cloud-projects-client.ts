import { randomUUID } from "node:crypto";
import {
  cloudManagementRequest,
  managedCloudGrant,
  managedCloudPartition,
  type CloudManagementRequest,
  type CloudManagementResult,
} from "@cjhyy/code-shell-server/account";
import type { NativeCloudAccount } from "./cloud-client.js";
import type { ManagedCloudWindows } from "../cloud-management-manager.js";
import type { PrivateHostPeer } from "../../host/native-peer.js";

type Dependencies = {
  windows: ManagedCloudWindows;
  account: Pick<NativeCloudAccount, "captureRootAccount">;
  requireFeature(): void;
  onFeatureChange(listener: () => void): () => void;
};
type ProjectFlow = { input: CloudManagementRequest; current(): void };
export class NativeCloudProjects {
  private readonly flows = new Map<string, ProjectFlow>();
  private readonly partitions = new Map<string, { closing?: Promise<void> }>();
  private lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(
    private readonly peer: () => PrivateHostPeer,
    private readonly deps: Dependencies,
  ) {}
  async manage(
    raw: unknown,
    authorized: () => boolean,
    document?: AbortSignal,
  ): Promise<CloudManagementResult> {
    if (this.closing) throw Error("云端管理正在关闭。");
    const input = cloudManagementRequest(raw),
      lease = this.deps.account.captureRootAccount(
        input.accountOrigin,
        input.accountId,
        authorized,
      );
    const feature = new AbortController();
    const checkFeature = () => {
      if (input.action !== "logout" && input.action !== "stop") this.deps.requireFeature();
    };
    const signal = AbortSignal.any([
      lease.signal,
      this.lifetime.signal,
      feature.signal,
      ...(document ? [document] : []),
    ]);
    const current = () => {
      signal.throwIfAborted();
      lease.current();
      checkFeature();
    };
    current();
    const drop = this.deps.onFeatureChange(() => {
      try {
        checkFeature();
      } catch {
        feature.abort();
      }
    });
    const flow = randomUUID();
    this.flows.set(flow, { input, current });
    try {
      const result = await this.peer().call<CloudManagementResult>(
        "projects/manage",
        { flow, input },
        signal,
      );
      current();
      return result;
    } finally {
      drop();
      this.flows.delete(flow);
    }
  }
  retireAccount(identity: { origin: string; accountId: string }) {
    return this.peer().call<void>("projects/retire", identity);
  }
  private closePartition(key: string) {
    const known = this.partitions.get(key);
    if (!known) return Promise.resolve();
    if (known.closing) return known.closing;
    // The native adapter destroys every owned window synchronously, before clearing its cookie partition.
    let removal: Promise<void>;
    try {
      removal = this.deps.windows.close(key);
    } catch (error) {
      removal = Promise.reject(error);
    }
    known.closing = removal.then(
      () => {
        this.partitions.delete(key);
      },
      (error) => {
        known.closing = undefined;
        throw error;
      },
    );
    return known.closing;
  }
  async handle(method: string, raw: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const req = raw as {
      flow?: string;
      partition?: string;
      input?: { grant?: unknown; projectId?: string };
    };
    if (method === "projects/closeWindow" && typeof req?.partition === "string")
      return this.closePartition(req.partition);
    const scope = req?.flow && this.flows.get(req.flow);
    if (!scope) throw Error("云端操作已取消。");
    scope.current();
    if (method === "projects/confirm") return;
    if (
      method !== "projects/openWindow" ||
      scope.input.action !== "open" ||
      req.input?.projectId !== scope.input.projectId
    )
      throw Error("云端窗口权限无效。");
    const grant = managedCloudGrant(req.input.grant, scope.input, Date.now()),
      partition = managedCloudPartition(grant);
    const known = this.partitions.get(partition) ?? {};
    if (known.closing) throw Error("云端窗口正在关闭。");
    this.partitions.set(partition, known);
    const authorized = () => {
      try {
        signal.throwIfAborted();
        scope.current();
        return (
          this.partitions.get(partition) === known &&
          !known.closing &&
          grant.session.expiresAt > Date.now()
        );
      } catch {
        return false;
      }
    };
    try {
      const result = await this.deps.windows.open({
        grant,
        projectId: scope.input.projectId,
        authorized,
      });
      if (!authorized()) throw Error("云端窗口权限已失效。");
      return result;
    } catch (error) {
      await this.closePartition(partition);
      throw error;
    }
  }
  disconnect() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.flows.clear();
    return Promise.all([...this.partitions.keys()].map((key) => this.closePartition(key))).then(
      () => {},
    );
  }
  dispose() {
    return (this.closing ??= (async () => {
      try {
        await this.peer().call("projects/dispose", {});
      } finally {
        await this.disconnect();
      }
    })());
  }
}
