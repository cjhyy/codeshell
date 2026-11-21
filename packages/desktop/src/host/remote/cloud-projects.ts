import { AsyncLocalStorage } from "node:async_hooks";
import {
  cloudId,
  cloudManagementRequest,
  type CloudAccountManager,
} from "@cjhyy/code-shell-server/account";
import { CloudManagementManager } from "../../main/cloud-management-manager.js";
import {
  createCloudManagementTransport,
  type CloudManagementTransport,
} from "../../main/cloud-management-http.js";
import type { PrivateHostPeer } from "../native-peer.js";
import type { AccountIdentity } from "./cloud-account.js";

/** The Host owns scoped project grants, exchange/remote revocation, and the per-account operation queue. */
export class HostedCloudProjects {
  private readonly manager: CloudManagementManager;
  private readonly calls = new AsyncLocalStorage<{ flow: string; signal: AbortSignal }>();
  private closing?: Promise<void>;
  constructor(
    peer: () => PrivateHostPeer,
    account: Pick<CloudAccountManager, "captureRootAccount">,
    transport: CloudManagementTransport = createCloudManagementTransport(),
  ) {
    const call = <T>(name: string, input?: unknown) => {
      const scope = this.calls.getStore();
      if (!scope) throw Error("云端操作已取消。");
      return peer().call<T>(name, { flow: scope.flow, input }, scope.signal);
    };
    this.manager = new CloudManagementManager({
      account,
      windows: {
        open: ({ grant, projectId, authorized }) => {
          if (!authorized()) throw Error("云端操作已取消。");
          return call("projects/openWindow", { grant, projectId });
        },
        close: (partition) => peer().call("projects/closeWindow", { partition }),
      },
      request: async (input) => {
        if (input.method === "POST" && input.path !== "/api/v1/cloud-management/logout")
          await call("projects/confirm");
        input.signal?.throwIfAborted();
        return transport(input);
      },
    });
  }
  run(method: string, raw: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (method === "projects/retire") return this.manager.retireAccount(raw as AccountIdentity);
    if (method === "projects/dispose") return this.close();
    if (method !== "projects/manage" || !raw) throw Error("Unknown project action");
    const { flow, input } = raw as { flow: string; input: unknown };
    cloudId(flow);
    const request = cloudManagementRequest(input);
    return this.calls.run({ flow, signal }, () =>
      this.manager.manage(request, () => !signal.aborted),
    );
  }
  close() {
    return (this.closing ??= this.manager.dispose());
  }
}
