import { randomUUID } from "node:crypto";
import type { CronJob, CronRunResult } from "@cjhyy/code-shell-core/internal";
import type { PanelAutomationHost } from "@cjhyy/code-shell-server/panels";
import type { CronCalls, CronCommand } from "../../host/automation/commands.js";
import type { CronNotice } from "../../host/automation/execution-receipts.js";
import { CronPeer, electronCronPort } from "../../host/automation/peer.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";

export interface NativeAutomationServices {
  execute(job: CronJob, signal: AbortSignal): Promise<CronRunResult>;
  deliver(notice: CronNotice): Promise<void>;
  dirty(id: string): void;
}

export class NativeAutomationClient {
  private services?: NativeAutomationServices;
  private peer?: CronPeer;
  private online?: ReturnType<typeof Promise.withResolvers<void>>;
  private readonly grants = new Map<string, () => Promise<boolean>>();
  constructor(
    private readonly business: CallShellBusiness,
    private readonly connect: () => void,
  ) {}
  get enabled() {
    return !!this.services;
  }
  async start(services: NativeAutomationServices) {
    this.services = services;
    this.online = Promise.withResolvers<void>();
    this.connect();
    const wait = this.online;
    const timeout = setTimeout(
      () => wait.reject(Error("Automation scheduler startup timed out")),
      15000,
    );
    try {
      await wait.promise;
    } finally {
      clearTimeout(timeout);
    }
  }
  bind(port: Electron.MessagePortMain) {
    this.disconnect();
    const services = this.services;
    if (!services) {
      port.close();
      return;
    }
    this.peer = new CronPeer(electronCronPort(port), (method, input, signal) => {
      switch (method) {
        case "execute":
          return services.execute(input as CronJob, signal);
        case "deliver":
          return services.deliver(input as CronNotice);
        case "authorize":
          return this.grants.get(String(input))?.() ?? false;
        case "started":
        case "definition":
          return services.dirty(String(input));
        case "online":
          this.online?.resolve();
          return;
        default:
          throw Error("Unknown native automation adapter");
      }
    });
  }
  disconnect() {
    this.peer?.close();
    this.peer = undefined;
  }
  close() {
    this.services = undefined;
    this.online?.reject(Error("Automation scheduler stopped"));
    this.grants.clear();
    this.disconnect();
  }
  call<K extends keyof CronCalls>(
    method: K,
    input: CronCalls[K]["input"],
    signal?: AbortSignal,
  ): Promise<CronCalls[K]["result"]> {
    return this.business("automation/command", { method, input } as CronCommand, signal) as Promise<
      CronCalls[K]["result"]
    >;
  }
  readonly panel: PanelAutomationHost = {
    conditionalMutations: true,
    call: async (scope, method, params) => {
      if (!(await scope.isAuthorized())) throw Error("Panel automation authorization expired");
      const grantId = randomUUID();
      this.grants.set(grantId, async () => {
        if (!(await scope.isAuthorized())) return false;
        scope.assertAuthorized?.();
        return true;
      });
      try {
        const { appId, cwd, sessionId, revision } = scope;
        return await this.call(
          "panel",
          {
            grantId,
            scope: { appId, cwd, sessionId, revision },
            method,
            params,
          },
          scope.signal,
        );
      } finally {
        this.grants.delete(grantId);
      }
    },
  };
}
