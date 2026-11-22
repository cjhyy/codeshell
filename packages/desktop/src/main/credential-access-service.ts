import { installDefaultLinkProviders } from "@cjhyy/code-shell-server/links";
import { decideSourceCredential } from "@cjhyy/code-shell-core/internal";
import type { ProfileCredentialRevisions } from "@cjhyy/code-shell-core/internal/storage";
import type {
  ProfileCredentialQuestion,
  ProfileCredentialAnswers,
} from "../shared/profile-switch-authority.js";
import { credentialFiles, runDesktopCredentialOperation } from "./credential-file-client.js";
import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import {
  CredentialStore,
  credentialAllowsEnvExposure,
  credentialSecretHint,
  isCredentialSecretAvailable,
  isBrowserOAuthLinkCredential,
  materializeCookieSecret,
  resolveLinkCredentialAccessToken,
  summarizeOAuthCredentialSecret,
  type CredentialAccessScope,
  type Credential,
  type CredentialMetadata,
  type CredentialSnapshot,
  type CredentialSnapshotEntry,
} from "@cjhyy/code-shell-core";

export interface CredentialResolveRequest {
  cwd?: string;
  id: string;
  scope: CredentialAccessScope;
  purpose: "use" | "mcp" | "link";
  expectedApprovalIdentity?: string;
}

export interface CredentialMaterializeCookieRequest {
  cwd?: string;
  id: string;
  scope: CredentialAccessScope;
  expectedApprovalIdentity?: string;
}

export function buildCredentialSnapshot(
  cwds: Array<string | undefined>,
  revision: number,
): CredentialSnapshot;
export function buildCredentialSnapshot(
  cwds: Array<string | undefined>,
  revision: number,
  hosted: true,
): Promise<CredentialSnapshot>;
export function buildCredentialSnapshot(
  cwds: Array<string | undefined>,
  revision: number,
  hosted?: true,
): CredentialSnapshot | Promise<CredentialSnapshot> {
  const roots = [...new Set([undefined, ...cwds.map((cwd) => cwd || undefined)])];
  if (hosted)
    return Promise.all(
      roots.map((cwd) =>
        runDesktopCredentialOperation(cwd, ["user", "project"], undefined, (store) =>
          buildCredentialSnapshotEntry(cwd, store),
        ),
      ),
    ).then((entries) => ({ revision, entries }));
  return {
    revision,
    entries: roots.map((cwd) => buildCredentialSnapshotEntry(cwd, new CredentialStore(cwd))),
  };
}
export function resolveCredentialValueForWorker(req: CredentialResolveRequest): { value: string };
export function resolveCredentialValueForWorker(
  req: CredentialResolveRequest,
  assertCurrent: () => void,
): Promise<{ value: string }>;
export function resolveCredentialValueForWorker(
  req: CredentialResolveRequest,
  assertCurrent?: () => void,
) {
  if (assertCurrent)
    return runDesktopCredentialOperation(
      req.cwd,
      req.scope === "project" ? ["project"] : ["user", "project"],
      undefined,
      (store) => {
        assertCurrent();
        return credentialValue(store, req);
      },
    );
  return credentialValue(new CredentialStore(req.cwd), req);
}
function credentialValue(store: CredentialStore, req: CredentialResolveRequest): { value: string } {
  const record = store.resolveForApproval(req.id, req.scope);
  if (req.expectedApprovalIdentity && record?.approvalIdentity !== req.expectedApprovalIdentity)
    throw new Error("credential changed after approval");
  const cred = record?.credential;
  if (!cred || !isCredentialSecretAvailable(cred.secret)) {
    throw new Error(`credential "${req.id}" is unavailable`);
  }
  if (isBrowserOAuthLinkCredential(cred))
    throw new Error("OAuth Link credentials only support Host-owned actions");
  if (req.purpose !== "link" && cred.meta?.agentExposable === false) {
    // Trust boundary lives here in the main process, not in the worker: a
    // credential marked agentExposable:false may only feed Link Action
    // execution and must never surface its raw token to agent-facing purposes.
    throw new Error(
      `credential "${req.id}" is restricted to Link Actions and never returns its raw token`,
    );
  }
  const allowed =
    req.purpose === "link"
      ? cred.type === "link" &&
        linkConnectionMetadata(cred.meta).linkExecutionRuntime === "local" &&
        Boolean(cred.meta?.linkProvider)
      : cred.type === "token" || cred.type === "link";
  if (!allowed) {
    throw new Error(
      `credential "${req.id}" is not a ${
        req.purpose === "mcp"
          ? "token/link (OAuth uses the host access resolver)"
          : req.purpose === "link"
            ? "local Link"
            : "token/link"
      } credential`,
    );
  }
  return {
    value: req.purpose === "link" ? resolveLinkCredentialAccessToken(cred)! : cred.secret,
  };
}

type Cookiefiles = ReturnType<typeof materializeCookieSecret>;
export function materializeCredentialCookieForWorker(
  req: CredentialMaterializeCookieRequest,
): Cookiefiles;
export function materializeCredentialCookieForWorker(
  req: CredentialMaterializeCookieRequest,
  assertCurrent: () => void,
): Promise<Cookiefiles>;
export function materializeCredentialCookieForWorker(
  req: CredentialMaterializeCookieRequest,
  assertCurrent?: () => void,
) {
  if (assertCurrent)
    return runDesktopCredentialOperation(
      req.cwd,
      req.scope === "project" ? ["project"] : ["user", "project"],
      undefined,
      (store) => {
        assertCurrent();
        return materializeCookie(store, req);
      },
    );
  return materializeCookie(new CredentialStore(req.cwd), req);
}
function materializeCookie(
  store: CredentialStore,
  req: CredentialMaterializeCookieRequest,
): Cookiefiles {
  const record = store.resolveForApproval(req.id, req.scope);
  if (req.expectedApprovalIdentity && record?.approvalIdentity !== req.expectedApprovalIdentity)
    throw new Error("credential changed after approval");
  const cred = record?.credential;
  if (!cred || cred.type !== "cookie" || !isCredentialSecretAvailable(cred.secret)) {
    throw new Error(`cookie credential "${req.id}" is unavailable`);
  }
  return materializeCookieSecret(cred.id, cred.secret);
}

function buildCredentialSnapshotEntry(
  cwd: string | undefined,
  store: CredentialStore,
): CredentialSnapshotEntry {
  const full = store.listWithSources("full");
  const project = store.listWithSources("project");
  return {
    cwd,
    full: full.credentials.map(({ credential, source }) =>
      toMetadata(credential, store.approvalIdentity(source, credential)),
    ),
    project: project.credentials.map(({ credential, source }) =>
      toMetadata(credential, store.approvalIdentity(source, credential)),
    ),
    readableFull: full.readable,
    readableProject: project.readable,
    envFull: envExposures(full.credentials.map(({ credential }) => credential)),
    envProject: envExposures(project.credentials.map(({ credential }) => credential)),
  };
}

function envExposures(credentials: Credential[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cred of credentials) {
    if (!credentialAllowsEnvExposure(cred.type)) continue;
    const name = cred.exposeAsEnv?.trim();
    if (name && isCredentialSecretAvailable(cred.secret)) {
      out[name] = cred.secret;
    }
  }
  return out;
}

function toMetadata(cred: Credential, approvalIdentity: string): CredentialMetadata {
  const { id, type, label, autoUseByAI, autoInjectByAI, meta } = cred;
  const secret = cred.secret;
  const hasSecret = isCredentialSecretAvailable(secret);
  return {
    id,
    approvalIdentity,
    type,
    label,
    autoUseByAI,
    autoInjectByAI,
    exposeAsEnv: credentialAllowsEnvExposure(type) ? cred.exposeAsEnv : undefined,
    meta: meta ? linkConnectionMetadata(meta) : undefined,
    hasSecret,
    secretHint: hasSecret ? credentialSecretHint(type, secret) : undefined,
    ...(cred.type === "oauth" || isBrowserOAuthLinkCredential(cred)
      ? { oauthStatus: summarizeOAuthCredentialSecret(secret) }
      : {}),
  };
}

/** Only a bound source's availability and opaque Link authority leave Main. */
export async function answerProfileCredentialQuestions(
  cwd: string,
  questions: ProfileCredentialQuestion[],
  assertCurrent: () => void,
): Promise<ProfileCredentialAnswers> {
  if (!questions.length) return { decisions: [] };
  if (questions.some((q) => q.link)) installDefaultLinkProviders();
  const refs = new Set(questions.map((q) => q.ref));
  const files = credentialFiles();
  const revisions: Partial<ProfileCredentialRevisions> = {};
  const scopedFiles = {
    ...files,
    async read(address: Parameters<typeof files.read>[0]) {
      assertCurrent();
      const image = await files.read(address);
      assertCurrent();
      revisions[address.scope] = image.revision;
      return {
        ...image,
        file: {
          ...image.file,
          credentials: image.file.credentials.filter((record) => record && refs.has(record.id)),
        },
      };
    },
  };
  const decisions = await new CredentialStore(cwd).withAsyncCipher(
    scopedFiles,
    ["user", "project"],
    undefined,
    (store) => {
      assertCurrent();
      const credentials = new Map(
        store
          .listWithSources("full")
          .credentials.map(({ credential, source }) => [
            credential.id,
            toMetadata(credential, store.approvalIdentity(source, credential)),
          ]),
      );
      return questions.map((q) => ({
        key: JSON.stringify(q),
        ...decideSourceCredential(q, credentials.get(q.ref)),
      }));
    },
  );
  if (!revisions.user || !revisions.project) throw Error("Missing profile credential revisions");
  return { decisions, revisions: { user: revisions.user, project: revisions.project } };
}
