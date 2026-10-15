import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { LinkAuthorization, LinkErrorCode } from "./types.js";

export type LinkAuthorizationDiagnosticStage =
  | "authorization"
  | "body_validation"
  | "input_validation"
  | "host_store_read"
  | "remote_configuration"
  | "remote_catalog"
  | "mode_selection"
  | "connection_review"
  | "job_creation"
  | "final_authorization";

/** Fixed internal reasons, independent of exception text and provider responses. */
export type LinkAuthorizationDiagnosticCode =
  | "authorization_check_failed"
  | "request_body_invalid"
  | "input_validation_failed"
  | "host_store_unreadable"
  | "host_store_read_failed"
  | "remote_configuration_missing"
  | "remote_configuration_invalid"
  | "catalog_network"
  | "catalog_timeout"
  | "catalog_http_status"
  | "catalog_invalid_json"
  | "catalog_invalid_schema"
  | "catalog_unreviewed_capability"
  | "catalog_unsupported_auth"
  | "catalog_response_limit"
  | "catalog_unexpected_error"
  | "catalog_unavailable"
  | "provider_capability_missing"
  | "auth_mode_unavailable"
  | "connection_review_failed"
  | "job_capacity_exceeded"
  | "remote_authorization_invalid"
  | "authorization_job_failed"
  | "final_authorization_failed";

/** Deliberately excludes all URLs, request data, account IDs, secrets, and exception text. */
export interface LinkAuthorizationDiagnostic {
  event: "link_authorization";
  transport: "http" | "host";
  requestId: string;
  outcome: "stage" | "success" | "failure";
  stage: LinkAuthorizationDiagnosticStage;
  elapsedMs: number;
  providerId?: string;
  methodId?: string;
  authModeId?: string;
  internalCode?: LinkAuthorizationDiagnosticCode;
  publicCode?: LinkErrorCode;
  httpStatus?: number;
  upstreamStatus?: number;
  /** API success can return an authorization job that has already failed. */
  authorizationState?: LinkAuthorization["state"];
}

export type LinkAuthorizationDiagnosticSink = (
  diagnostic: Readonly<LinkAuthorizationDiagnostic>,
) => void | Promise<void>;

interface Failure {
  stage: LinkAuthorizationDiagnosticStage;
  internalCode: LinkAuthorizationDiagnosticCode;
  upstreamStatus?: number;
}

const defaults: Record<LinkAuthorizationDiagnosticStage, LinkAuthorizationDiagnosticCode> = {
  authorization: "authorization_check_failed",
  body_validation: "request_body_invalid",
  input_validation: "input_validation_failed",
  host_store_read: "host_store_read_failed",
  remote_configuration: "remote_configuration_invalid",
  remote_catalog: "catalog_unexpected_error",
  mode_selection: "auth_mode_unavailable",
  connection_review: "connection_review_failed",
  job_creation: "authorization_job_failed",
  final_authorization: "final_authorization_failed",
};

const internalCodes = new Set<string>([
  ...Object.values(defaults),
  "host_store_unreadable",
  "remote_configuration_missing",
  "catalog_network",
  "catalog_timeout",
  "catalog_http_status",
  "catalog_invalid_json",
  "catalog_invalid_schema",
  "catalog_unreviewed_capability",
  "catalog_unsupported_auth",
  "catalog_response_limit",
  "catalog_unavailable",
  "provider_capability_missing",
  "job_capacity_exceeded",
  "remote_authorization_invalid",
]);
const publicCodes = new Set<string>([
  "invalid_request",
  "login_required",
  "not_found",
  "read_only",
  "conflict",
  "busy",
  "provider_rejected",
  "cli_unavailable",
  "authorization_failed",
  "authorization_expired",
  "cancelled",
  "unavailable",
]);
const authorizationStates = new Set<string>(["pending", "connected", "failed", "cancelled"]);

const activeTrace = new AsyncLocalStorage<AuthorizationTrace>();

class AuthorizationTrace {
  readonly requestId = randomUUID();
  private readonly startedAt = performance.now();
  private active = true;
  private stage: LinkAuthorizationDiagnosticStage = "authorization";
  private failure?: Failure;
  private identity: Pick<LinkAuthorizationDiagnostic, "providerId" | "methodId" | "authModeId"> =
    {};

  constructor(
    private readonly sink?: LinkAuthorizationDiagnosticSink,
    private readonly transport: "http" | "host" = "http",
  ) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return activeTrace.run(this, operation);
  }

  isActive(): boolean {
    return this.active;
  }

  setStage(stage: LinkAuthorizationDiagnosticStage): void {
    if (!this.active) return;
    this.stage = stage;
    this.failure = undefined;
    this.emit({ outcome: "stage", stage });
  }

  setIdentity(identity: typeof this.identity): void {
    if (this.active) this.identity = { ...identity };
  }

  setFailure(failure: Failure): void {
    if (!this.active) return;
    if (
      failure.internalCode === "authorization_check_failed" &&
      this.stage === "final_authorization"
    )
      failure = { stage: "final_authorization", internalCode: "final_authorization_failed" };
    this.failure = {
      stage: failure.stage,
      internalCode: internalCodes.has(failure.internalCode)
        ? failure.internalCode
        : defaults[failure.stage],
      ...(Number.isInteger(failure.upstreamStatus) &&
      failure.upstreamStatus! >= 100 &&
      failure.upstreamStatus! <= 599
        ? { upstreamStatus: failure.upstreamStatus }
        : {}),
    };
  }

  complete(
    httpStatus: number,
    publicCode?: LinkErrorCode,
    authorizationState?: LinkAuthorization["state"],
  ): void {
    if (!this.active) return;
    this.emit(
      publicCode
        ? {
            outcome: "failure",
            ...(this.failure ?? { stage: this.stage, internalCode: defaults[this.stage] }),
            publicCode: publicCodes.has(publicCode) ? publicCode : "unavailable",
            httpStatus: this.httpStatus(httpStatus),
          }
        : {
            outcome: "success",
            stage: this.stage,
            httpStatus: this.httpStatus(httpStatus),
            ...(authorizationState && authorizationStates.has(authorizationState)
              ? { authorizationState }
              : {}),
          },
    );
  }

  private httpStatus(status: number): number {
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 503;
  }

  /** Detached authorization jobs inherit ALS; they must lose authority to edit this trace. */
  deactivate(): void {
    this.active = false;
  }

  private emit(
    value: Pick<LinkAuthorizationDiagnostic, "outcome" | "stage"> &
      Partial<
        Pick<
          LinkAuthorizationDiagnostic,
          "internalCode" | "publicCode" | "httpStatus" | "upstreamStatus" | "authorizationState"
        >
      >,
  ): void {
    const event: Readonly<LinkAuthorizationDiagnostic> = Object.freeze({
      event: "link_authorization",
      transport: this.transport,
      requestId: this.requestId,
      elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)),
      ...this.identity,
      ...value,
    });
    try {
      if (this.sink) {
        void Promise.resolve(this.sink(event)).catch(() => {});
      } else {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      }
    } catch {
      // Observability must never change an authorization result or reveal the sink's exception.
    }
  }
}

export function createLinkAuthorizationTrace(sink?: LinkAuthorizationDiagnosticSink) {
  return new AuthorizationTrace(sink);
}

/** Native Host callers share the same diagnostics; HTTP already owns its longer request lifetime. */
export async function withLinkAuthorizationTrace(
  sink: LinkAuthorizationDiagnosticSink | undefined,
  operation: () => Promise<LinkAuthorization>,
  failure: (error: unknown) => { status: number; code: LinkErrorCode },
): Promise<LinkAuthorization> {
  if (activeTrace.getStore()?.isActive()) return operation();
  const trace = new AuthorizationTrace(sink, "host");
  return trace.run(async () => {
    try {
      trace.setStage("authorization");
      const result = await operation();
      trace.complete(200, undefined, result.state);
      return result;
    } catch (error) {
      try {
        const mapped = failure(error);
        trace.complete(mapped.status, mapped.code);
      } catch {
        trace.complete(503, "unavailable");
      }
      throw error;
    } finally {
      trace.deactivate();
    }
  });
}

export function authorizationDiagnosticStage(stage: LinkAuthorizationDiagnosticStage): void {
  activeTrace.getStore()?.setStage(stage);
}

/** Callers must select identity values from the compiled provider/method/mode catalog. */
export function authorizationDiagnosticIdentity(
  identity: Pick<LinkAuthorizationDiagnostic, "providerId" | "methodId" | "authModeId">,
): void {
  activeTrace.getStore()?.setIdentity(identity);
}

export function authorizationDiagnosticFailure(
  stage: LinkAuthorizationDiagnosticStage,
  internalCode: LinkAuthorizationDiagnosticCode,
  upstreamStatus?: number,
): void {
  activeTrace.getStore()?.setFailure({ stage, internalCode, upstreamStatus });
}
