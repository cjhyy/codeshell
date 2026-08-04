export type LinkActionRisk = "discovery" | "read" | "write";

export interface LocalLinkIdentity {
  externalAccountId: string;
  label: string;
  detail?: string;
  /** Safe, non-secret resource labels that may be previewed in the Link card. */
  resourceLabels?: string[];
}

export interface LocalLinkValidationResult {
  providerId: string;
  identity: LocalLinkIdentity;
  capabilityIds: string[];
  verifiedAt: string;
}

export interface LocalLinkActionSummary {
  id: string;
  title: string;
  description: string;
  risk: LinkActionRisk;
}

export interface LocalLinkProviderSummary {
  id: string;
  displayName: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  actions: LocalLinkActionSummary[];
}

export interface LocalLinkActionContext {
  token: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface LocalLinkActionSpec extends LocalLinkActionSummary {
  execute(context: LocalLinkActionContext): Promise<unknown>;
}

export interface LocalLinkProviderSpec {
  id: string;
  displayName: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  validate(context: Omit<LocalLinkActionContext, "params">): Promise<LocalLinkIdentity>;
  actions: LocalLinkActionSpec[];
}
