import type { Dispose } from "../utils/dispose.js";
export { onceDispose, type Dispose } from "../utils/dispose.js";

/** Explicit ownership for resources acquired by one host, engine, session or run. */
export type ModuleScopeKind = "host" | "engine" | "session" | "run";
export interface Disposable {
  dispose(): void | Promise<void>;
}
export type DisposableLike = Dispose | Disposable | void;

export class LifetimeScope {
  private resources: Dispose[] = [];
  private children = new Set<LifetimeScope>();
  private disposal?: Promise<void>;

  constructor(
    readonly kind: ModuleScopeKind,
    readonly id: string,
    private readonly detached?: () => void,
    private readonly parent?: LifetimeScope,
  ) {}

  get disposed(): boolean {
    return this.disposal !== undefined || this.parent?.disposed === true;
  }

  child(kind: ModuleScopeKind, id: string): LifetimeScope {
    this.assertOpen();
    const child = new LifetimeScope(kind, id, () => this.children.delete(child), this);
    this.children.add(child);
    return child;
  }

  own(resource: DisposableLike): void {
    this.assertOpen();
    if (typeof resource === "function") this.resources.push(resource);
    else if (resource) this.resources.push(() => resource.dispose());
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error(`Lifetime scope ${this.kind}:${this.id} is disposed`);
  }

  /** Sync disposers execute immediately; async disposers are awaited in acquisition-reverse order. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.disposal = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const tasks: Dispose[] = [
      ...[...this.children].reverse().map((child) => () => child.dispose()),
      ...this.resources.reverse(),
    ];
    this.resources = [];
    this.children.clear();
    const errors: unknown[] = [];
    let index = 0;
    const drain = (): void => {
      while (index < tasks.length) {
        try {
          const result = tasks[index++]();
          if (result && typeof result.then === "function") {
            result.then(drain, (error) => {
              errors.push(error);
              drain();
            });
            return;
          }
        } catch (error) {
          errors.push(error);
        }
      }
      this.detached?.();
      if (errors.length)
        reject(new AggregateError(errors, `Disposal failed: ${this.kind}:${this.id}`));
      else resolve();
    };
    drain();
    return this.disposal;
  }
}
