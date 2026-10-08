import type {
  LinkAuthMode,
  LinkAuthorization,
  LinkAuthorizationResponse,
  LinkAuthorizationStep,
  LinkConnectionInput,
  LinkProviderView,
} from "@cjhyy/code-shell-link";

export interface LinkAuthorizationTransport {
  begin(input: LinkConnectionInput, authModeId: string): Promise<LinkAuthorization>;
  status(id: string): Promise<LinkAuthorization>;
  respond(id: string, response: LinkAuthorizationResponse): Promise<LinkAuthorization>;
  cancel(id: string): Promise<LinkAuthorization | void>;
}

export interface LinkAuthorizationControllerSnapshot {
  authorization?: LinkAuthorization;
  busy: boolean;
  /** Transport errors do not imply that the Host rejected the authorization. */
  error?: Error;
}

/** Presentation URLs cannot contain credentials or executable protocols. */
export function safeLinkAuthorizationUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function selectPreferredLinkAuthMode(
  provider: Pick<LinkProviderView, "authModes">,
  methodId?: string,
): LinkAuthMode | undefined {
  const modes = provider.authModes?.filter(
    (mode) => mode.available && (!methodId || mode.methodId === methodId),
  );
  return modes?.find((mode) => mode.preferred) ?? modes?.[0];
}

/** Adapt only the two legacy wire shapes. Unknown new steps remain unsupported. */
export function getLinkAuthorizationStep(
  authorization: LinkAuthorization,
): LinkAuthorizationStep | undefined {
  if (authorization.state !== "pending") return undefined;
  if (authorization.step) return authorization.step;
  if (authorization.redirect)
    return {
      id: authorization.id,
      kind: "redirect",
      ...authorization.redirect,
    };
  if (authorization.prompt)
    return { id: authorization.id, kind: "device-code", ...authorization.prompt };
  return undefined;
}

const SUPPORTED_STEPS = new Set([
  "redirect",
  "device-code",
  "qr-code",
  "credential-input",
  "local-session",
  "consent",
  "processing",
]);

function assertAuthorization(value: LinkAuthorization, expectedId?: string): void {
  if (!value.id || (expectedId && value.id !== expectedId))
    throw new Error("授权响应与当前连接不匹配。");
  if (!["pending", "connected", "failed", "cancelled"].includes(value.state))
    throw new Error("无法识别授权状态，请更新客户端。");
  if (value.state === "connected" && !value.connection)
    throw new Error("服务尚未确认连接已保存，请刷新后重试。");
  const step = getLinkAuthorizationStep(value);
  if (value.state === "pending" && (!step || !SUPPORTED_STEPS.has(step.kind)))
    throw new Error("当前客户端不支持这个授权步骤，请更新客户端。");
  if (step && (!step.id || !Number.isFinite(Date.parse(step.expiresAt))))
    throw new Error("授权步骤缺少有效期限，请重新连接。");
}

/**
 * Browser-safe lifecycle shared by Desktop and Web. The Host owns credentials,
 * challenge progression and persistence; this controller owns one UI attempt.
 */
export class LinkAuthorizationController {
  private value: LinkAuthorizationControllerSnapshot = { busy: false };
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;
  private binding?: LinkConnectionInput;

  constructor(
    private readonly transport: LinkAuthorizationTransport,
    private readonly options: { pollIntervalMs?: number; retryIntervalMs?: number } = {},
  ) {}

  getSnapshot = (): LinkAuthorizationControllerSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: LinkAuthorizationControllerSnapshot): void {
    if (this.disposed) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  }
  private stop(): number {
    clearTimeout(this.timer);
    return ++this.generation;
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
  private deadline(authorization: LinkAuthorization): number {
    const step = getLinkAuthorizationStep(authorization);
    return Math.min(
      authorization.expiresAt ? Date.parse(authorization.expiresAt) : Infinity,
      step ? Date.parse(step.expiresAt) : Infinity,
    );
  }
  private accept(value: LinkAuthorization, generation: number, expectedId?: string): void {
    if (!this.current(generation)) return;
    assertAuthorization(value, expectedId);
    if (
      this.binding &&
      (value.providerId !== this.binding.providerId ||
        (value.methodId && value.methodId !== this.binding.methodId))
    )
      throw new Error("授权响应与当前服务不匹配。");
    this.publish({ authorization: value, busy: false });
    if (value.state === "pending") this.schedule(generation);
  }
  private schedule(generation: number, delay = this.options.pollIntervalMs ?? 2_000): void {
    const authorization = this.value.authorization;
    if (!this.current(generation) || authorization?.state !== "pending") return;
    const remaining = this.deadline(authorization) - Date.now();
    if (remaining <= 0) {
      this.stop();
      this.publish({
        busy: false,
        authorization: {
          ...authorization,
          state: "failed",
          step: undefined,
          prompt: undefined,
          redirect: undefined,
          errorCode: "authorization_expired",
        },
      });
      void this.transport.cancel(authorization.id).catch(() => {});
      return;
    }
    const step = getLinkAuthorizationStep(authorization);
    // Input and consent are advanced by explicit responses, never by a GET.
    const needsInput = step && ["credential-input", "local-session", "consent"].includes(step.kind);
    this.timer = setTimeout(
      () => {
        if (needsInput) this.schedule(generation);
        else void this.poll(generation);
      },
      Math.min(delay, remaining),
    );
  }
  private async poll(generation: number): Promise<void> {
    const authorization = this.value.authorization;
    if (!this.current(generation) || authorization?.state !== "pending") return;
    if (this.deadline(authorization) <= Date.now()) {
      this.schedule(generation);
      return;
    }
    try {
      const next = await this.transport.status(authorization.id);
      this.accept(next, generation, authorization.id);
    } catch (cause) {
      if (!this.current(generation)) return;
      this.publish({ ...this.value, busy: false, error: asError(cause) });
      const status = (cause as { status?: number })?.status;
      if (status !== 401 && status !== 404)
        this.schedule(generation, this.options.retryIntervalMs ?? 4_000);
    }
  }

  async begin(
    input: LinkConnectionInput,
    authModeId: string,
  ): Promise<LinkAuthorization | undefined> {
    if (this.disposed || this.value.busy || this.value.authorization?.state === "pending") return;
    const generation = this.stop();
    this.binding = input;
    this.publish({ busy: true });
    try {
      const value = await this.transport.begin(input, authModeId);
      if (!this.current(generation)) {
        if (value.state === "pending") void this.transport.cancel(value.id).catch(() => {});
        return;
      }
      try {
        this.accept(value, generation);
      } catch (cause) {
        if (value.state === "pending") void this.transport.cancel(value.id).catch(() => {});
        throw cause;
      }
      return value;
    } catch (cause) {
      if (this.current(generation)) this.publish({ busy: false, error: asError(cause) });
    }
  }

  async respond(response: LinkAuthorizationResponse): Promise<LinkAuthorization | undefined> {
    const authorization = this.value.authorization;
    const step = authorization && getLinkAuthorizationStep(authorization);
    if (
      this.disposed ||
      this.value.busy ||
      authorization?.state !== "pending" ||
      !step ||
      step.id !== response.stepId
    )
      return;
    if (this.deadline(authorization) <= Date.now()) {
      this.schedule(this.generation);
      return;
    }
    const generation = this.stop();
    this.publish({ authorization, busy: true });
    try {
      const value = await this.transport.respond(authorization.id, response);
      this.accept(value, generation, authorization.id);
      return this.current(generation) ? value : undefined;
    } catch (cause) {
      if (this.current(generation)) {
        this.publish({ authorization, busy: false, error: asError(cause) });
        // An uncertain write must be reconciled by a read, never replayed.
        this.timer = setTimeout(
          () => void this.poll(generation),
          this.options.retryIntervalMs ?? 4_000,
        );
      }
    }
  }

  async cancel(): Promise<void> {
    const authorization = this.value.authorization;
    const generation = this.stop();
    if (authorization?.state !== "pending") {
      this.publish({ busy: false });
      return;
    }
    this.publish({ authorization, busy: true });
    try {
      const result = await this.transport.cancel(authorization.id);
      if (!this.current(generation)) return;
      this.publish({
        busy: false,
        authorization: result ?? {
          ...authorization,
          state: "cancelled",
          step: undefined,
          prompt: undefined,
          redirect: undefined,
        },
      });
    } catch (cause) {
      if (this.current(generation)) {
        this.publish({ authorization, busy: false, error: asError(cause) });
        this.schedule(generation, this.options.retryIntervalMs ?? 4_000);
      }
    }
  }

  clearError(): void {
    this.publish({ ...this.value, error: undefined });
  }
  dispose(): void {
    const authorization = this.value.authorization;
    this.stop();
    this.disposed = true;
    this.listeners.clear();
    if (authorization?.state === "pending")
      void this.transport.cancel(authorization.id).catch(() => {});
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("连接操作失败，请重试。");
}
