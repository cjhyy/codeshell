/** Portable, reviewed operation contracts. These definitions never contain credentials or code. */
export interface LinkValueSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, LinkValueSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: LinkValueSchema;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly enum?: readonly (string | number | boolean | null)[];
  /** Only reviewed, bounded patterns from the built-in catalog are accepted. */
  readonly pattern?: string;
  readonly anyOf?: readonly LinkValueSchema[];
  readonly oneOf?: readonly LinkValueSchema[];
}

export interface LinkResourcePolicy {
  /** Always declared, including list operations whose results need grant filtering. */
  readonly source: "input" | "grant-filtered" | "account";
  readonly group: string;
  readonly selector?: {
    readonly fields: readonly string[];
    readonly kind: "joined" | "identifier-or-url" | "slack-permalink";
    readonly separator?: string;
    readonly lowercase?: boolean;
    readonly stripHyphens?: boolean;
    readonly urlHosts?: readonly string[];
    readonly urlPathIndex?: number;
  };
}

export interface LinkOperationContract {
  readonly operationId: string;
  readonly providerId: string;
  /** Unqualified v1 wire name: lower-case letters and underscores only. */
  readonly action: string;
  readonly effect: "read" | "write";
  readonly executors: readonly ("api" | "mcp" | "cli")[];
  readonly inputSchema: LinkValueSchema;
  readonly outputSchema: LinkValueSchema;
  readonly resourcePolicy: LinkResourcePolicy;
  readonly content?: {
    readonly kind: string;
    readonly coverage: "summary" | "requested-subtree" | "selected-resource" | "page";
  };
  readonly defaults: Readonly<Record<string, string | number | boolean>>;
  readonly limits: { readonly inputBytes: number; readonly responseBytes: number };
  readonly repeatability: "read-only" | "verified-write-once";
  /** Existing adapters perform these canonicalizations after structural validation. */
  readonly normalization: readonly string[];
}

export type LinkRecipeId = "api-token" | "api-oauth" | "cli-session" | "broker-oauth" | "mcp-oauth";
export interface LinkConnectionRecipe {
  readonly id: LinkRecipeId;
  readonly auth: "static-secret" | "oauth2" | "external-session";
  readonly executor: "api" | "mcp" | "cli";
  readonly route: "direct" | "brokered";
  readonly credentialOwner: "current-host" | "broker" | "external-session-owner";
  readonly executorOwner: "current-host" | "broker";
}

export interface LinkOperationRequest {
  readonly connectionId: string;
  readonly providerId: string;
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface LinkOperationAuthorization {
  readonly connectionId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly recipeId: LinkRecipeId;
  readonly authorityRevision: string;
  readonly capabilityIds: readonly string[];
  readonly resources:
    | { readonly kind: "upstream-scoped" }
    | {
        readonly kind: "selected-resources";
        readonly groups: readonly {
          readonly id: string;
          readonly items: readonly { readonly id: string }[];
        }[];
      };
}

export class LinkOperationError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_result"
      | "unsupported_contract"
      | "permission_denied"
      | "resource_not_granted"
      | "contract_changed",
    message: string,
  ) {
    super(message);
    this.name = "LinkOperationError";
  }
}
