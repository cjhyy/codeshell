import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./store.js";
import {
  localCredentialAccess,
  setDefaultCredentialAccess,
  type CredentialAccess,
} from "./access.js";
import { useCredentialTool, __resetCredentialSessionAllowForTests } from "./use-credential-tool.js";
import {
  injectCredentialTool,
  __resetInjectCredentialSessionAllowForTests,
} from "./inject-credential-tool.js";

let cwd: string;
let other: string;
const id = "same-id";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cs-approval-origin-"));
  other = mkdtempSync(join(tmpdir(), "cs-approval-other-"));
});
afterEach(() => {
  new CredentialStore(cwd).remove("user", id);
  setDefaultCredentialAccess(null);
  __resetCredentialSessionAllowForTests();
  __resetInjectCredentialSessionAllowForTests();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});
const token = (secret: string) => ({ id, type: "token" as const, label: "Same label", secret });
const cookie = (value: string) => ({
  id,
  type: "cookie" as const,
  label: "Same label",
  secret: JSON.stringify([{ name: "session", value, domain: ".example.com", path: "/" }]),
});

test("remembered approval survives unchanged reads but not a project-to-user fallback", async () => {
  const store = new CredentialStore(cwd);
  store.save("user", token("user-value"));
  store.save("project", token("project-value"));
  let approvals = 0;
  const ctx = {
    cwd,
    sessionId: "origin-session",
    askUser: async () => (++approvals === 1 ? "本会话都允许" : "拒绝"),
  };
  const use = () => useCredentialTool({ id }, ctx as never).then(JSON.parse);
  expect(await use()).toEqual({ kind: "value", value: "project-value" });
  expect(await use()).toEqual({ kind: "value", value: "project-value" });
  store.remove("project", id);
  expect((await use()).kind).toBe("error");
  expect(approvals).toBe(2);
});

test("same id, label and value in another project cannot borrow session approval", async () => {
  new CredentialStore(cwd).save("project", token("same-value"));
  new CredentialStore(other).save("project", token("same-value"));
  let approvals = 0;
  const ctx = {
    cwd,
    sessionId: "workspace-session",
    askUser: async () => (++approvals === 1 ? "本会话都允许" : "拒绝"),
  };
  expect(JSON.parse(await useCredentialTool({ id }, ctx as never)).kind).toBe("value");
  ctx.cwd = other;
  expect(JSON.parse(await useCredentialTool({ id }, ctx as never)).kind).toBe("error");
  expect(approvals).toBe(2);
});

test("same-source replacement with identical label invalidates the remembered record", async () => {
  const store = new CredentialStore(cwd);
  store.save("project", token("first-account"));
  let approvals = 0;
  const ctx = {
    cwd,
    sessionId: "replace-session",
    askUser: async () => (++approvals === 1 ? "本会话都允许" : "拒绝"),
  };
  expect(JSON.parse(await useCredentialTool({ id }, ctx as never)).kind).toBe("value");
  store.save("project", token("different-account"));
  expect(JSON.parse(await useCredentialTool({ id }, ctx as never)).kind).toBe("error");
  expect(approvals).toBe(2);
});

test("record changes while an approval is pending are rejected before resolving a value", async () => {
  const store = new CredentialStore(cwd);
  store.save("project", token("approved-record"));
  const result = JSON.parse(
    await useCredentialTool({ id }, {
      cwd,
      sessionId: "pending-session",
      askUser: async () => {
        store.save("project", token("replacement-record"));
        return "允许本次";
      },
    } as never),
  );
  expect(result.kind).toBe("error");
  expect(JSON.stringify(result)).not.toContain("replacement-record");
});

test("InjectCredential remembers exact cookie origin and does not inject fallback credentials", async () => {
  const store = new CredentialStore(cwd);
  store.save("user", cookie("user-cookie"));
  store.save("project", cookie("project-cookie"));
  let approvals = 0;
  let injections = 0;
  const ctx = {
    cwd,
    sessionId: "inject-session",
    askUser: async () => (++approvals === 1 ? "本会话都允许" : "拒绝"),
    injectCredentialToBrowser: async (_id: string, _scope: string, identity: string) => {
      injections++;
      expect(identity).toBe(localCredentialAccess.resolveMeta(cwd, id, "full")?.approvalIdentity);
      return { ok: true, count: 1 };
    },
  };
  expect(JSON.parse(await injectCredentialTool({ id }, ctx as never)).kind).toBe("injected");
  expect(JSON.parse(await injectCredentialTool({ id }, ctx as never)).kind).toBe("injected");
  store.remove("project", id);
  expect(JSON.parse(await injectCredentialTool({ id }, ctx as never)).kind).toBe("error");
  expect(approvals).toBe(2);
  expect(injections).toBe(2);
});

test("InjectCredential rejects replacement during approval before calling the Host", async () => {
  const store = new CredentialStore(cwd);
  store.save("project", cookie("original"));
  let injections = 0;
  const result = JSON.parse(
    await injectCredentialTool({ id }, {
      cwd,
      sessionId: "inject-pending",
      askUser: async () => {
        store.save("project", cookie("replacement"));
        return "允许本次";
      },
      injectCredentialToBrowser: async () => {
        injections++;
        return { ok: true, count: 1 };
      },
    } as never),
  );
  expect(result.kind).toBe("error");
  expect(injections).toBe(0);
});

test("legacy custom access without an authoritative identity never caches approval", async () => {
  const metadata = { id, type: "token" as const, label: "Same label", hasSecret: true };
  const access: CredentialAccess = {
    listMasked: () => [metadata],
    resolveMeta: () => metadata,
    envExposures: () => ({}),
    resolveValue: async () => "legacy-value",
  };
  setDefaultCredentialAccess(access);
  let approvals = 0;
  const ctx = {
    cwd,
    sessionId: "legacy-session",
    askUser: async () => (++approvals === 1 ? "本会话都允许" : "拒绝"),
  };
  expect(JSON.parse(await useCredentialTool({ id }, ctx as never)).kind).toBe("value");
  expect(JSON.parse(await useCredentialTool({ id }, ctx as never)).kind).toBe("error");
  expect(approvals).toBe(2);
});

test("local resolution enforces the pinned identity even after a metadata read", async () => {
  const store = new CredentialStore(cwd);
  store.save("project", token("old-value"));
  const expectedApprovalIdentity = localCredentialAccess.resolveMeta(
    cwd,
    id,
    "full",
  )!.approvalIdentity;
  store.save("project", token("new-value"));
  await expect(
    localCredentialAccess.resolveValue!({
      cwd,
      id,
      scope: "full",
      purpose: "use",
      expectedApprovalIdentity,
    }),
  ).rejects.toThrow("changed after approval");
  store.save("project", cookie("old-cookie"));
  const cookieIdentity = localCredentialAccess.resolveMeta(cwd, id, "full")!.approvalIdentity;
  store.save("project", cookie("new-cookie"));
  await expect(
    localCredentialAccess.materializeCookie!({
      cwd,
      id,
      scope: "full",
      expectedApprovalIdentity: cookieIdentity,
    }),
  ).rejects.toThrow("changed after approval");
});
