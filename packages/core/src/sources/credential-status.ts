import {
  credentialAccessScope,
  getCredentialAccess,
  type CredentialMetadata,
} from "../credentials/access.js";
import { createHash } from "node:crypto";
import { linkAuthoritySnapshot } from "../links/authority.js";
import { allowsSourceView, linkSourceView } from "./link-view.js";
import type { SourceDefinition } from "./types.js";
import type { CredentialStatusFn, SourceCredentialDecision } from "./resolve.js";

/** Probe global credential availability through renderer-safe metadata only. */
export const defaultCredentialStatus: CredentialStatusFn = (ref, context) => {
  const credential = getCredentialAccess().resolveMeta(
    context?.cwd,
    ref,
    context?.settingsScope ? credentialAccessScope(context.settingsScope) : "full",
  );
  return credentialMetadataStatus(credential);
};

function credentialMetadataStatus(
  credential: CredentialMetadata | undefined,
): ReturnType<CredentialStatusFn> {
  if (!credential) return "missing";

  if (
    credential.type === "oauth" &&
    credential.oauthStatus?.state === "expired" &&
    !credential.oauthStatus.hasRefreshToken
  ) {
    return "expired";
  }

  return "ok";
}

/** The native credential owner evaluates only these selectors from a bound source. */
export interface SourceCredentialQuestion {
  ref: string;
  link?: { providerId: string; action: string } | null;
}
export function sourceCredentialQuestion(
  definition: SourceDefinition,
): SourceCredentialQuestion | undefined {
  const ref = definition.credentialRef;
  if (!ref) return undefined;
  if (definition.kind !== "link") return { ref };
  try {
    const { providerId, action } = linkSourceView(definition);
    return { ref, link: { providerId, action } };
  } catch {
    return { ref, link: null };
  }
}
export function decideSourceCredential(
  question: SourceCredentialQuestion,
  credential: CredentialMetadata | undefined,
): SourceCredentialDecision {
  return {
    available:
      credentialMetadataStatus(credential) === "ok" &&
      (question.link === undefined ||
        (!!question.link && allowsSourceView(credential, question.link))),
    ...(question.link !== undefined && credential
      ? { revision: createHash("sha256").update(linkAuthoritySnapshot(credential)).digest("hex") }
      : {}),
  };
}
