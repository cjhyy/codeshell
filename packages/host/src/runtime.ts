import type { Contracts } from "@cjhyy/code-shell-core";
import type { HostRequest } from "./host-requests.js";

/** Platform mechanisms stay in the adapter; services do not import Electron. */
export interface HostAdapter {
  kind: "electron" | "headless" | "container";
  label: string;
  id?: string;
  contracts?: Contracts;
  start?(): void;
  stop?(): void;
}

export interface HostService {
  id: string;
  capabilities: readonly string[];
  /** Missing handlers mean the adapter's existing downstream route owns the request. */
  hostRequests?: Readonly<Record<string, (request: HostRequest) => boolean>>;
  start?(adapter: HostAdapter): void;
  stop?(): void;
}

/** Step 1.1 registry. Large services and the v2 client transport migrate separately. */
export class HostRuntime {
  private readonly services = new Map<string, HostService>();
  private readonly owners = new Map<string, HostService>();
  private readonly started: HostService[] = [];
  private state: "created" | "starting" | "running" | "stopped" = "created";

  constructor(
    readonly adapter: HostAdapter,
    services: readonly HostService[] = [],
  ) {
    for (const service of services) this.register(service);
  }

  register(service: HostService): void {
    if (this.state !== "created") throw new Error("Host services must register before start");
    if (!service.id || this.services.has(service.id)) throw new Error("Duplicate host service");
    const capabilities = new Set<string>();
    for (const capability of service.capabilities) {
      if (!capability || capabilities.has(capability) || this.owners.has(capability))
        throw new Error(`Duplicate host capability: ${capability}`);
      capabilities.add(capability);
    }
    for (const capability of Object.keys(service.hostRequests ?? {})) {
      if (!service.capabilities.includes(capability))
        throw new Error(`Undeclared host capability: ${capability}`);
    }
    this.services.set(service.id, service);
    for (const capability of service.capabilities) this.owners.set(capability, service);
  }

  start(): void {
    if (this.state === "running") return;
    if (this.state === "stopped") throw new Error("Host runtime is stopped");
    if (this.state === "starting") throw new Error("Host runtime is already starting");
    this.state = "starting";
    try {
      this.adapter.start?.();
      if (this.state !== "starting") throw new Error("Host runtime stopped during start");
      for (const service of this.services.values()) {
        this.started.push(service);
        service.start?.(this.adapter);
        if (this.state !== "starting") throw new Error("Host runtime stopped during start");
      }
      this.state = "running";
    } catch (error) {
      let cleanupErrors: unknown[] | undefined;
      try {
        this.stop();
      } catch (cleanup) {
        cleanupErrors = cleanup instanceof AggregateError ? cleanup.errors : [cleanup];
      }
      if (cleanupErrors) {
        throw new AggregateError([error, ...cleanupErrors], "Host startup and rollback failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    const errors: unknown[] = [];
    for (const service of this.started.splice(0).reverse()) {
      try {
        service.stop?.();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.adapter.stop?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Host shutdown failed");
  }

  capabilities(): string[] {
    return [...this.owners.keys()];
  }

  supports(capability: string): boolean {
    return this.state === "running" && this.owners.has(capability);
  }

  dispatch(request: HostRequest): boolean {
    if (!this.supports(request.capability)) return false;
    return (
      this.owners.get(request.capability)?.hostRequests?.[request.capability]?.(request) ?? false
    );
  }
}
