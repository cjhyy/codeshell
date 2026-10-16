import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LINK_OPERATION_CONTRACTS, getLinkOperationContract } from "./operations.js";
import {
  assertLinkOperationAuthorized,
  assertLinkOperationResult,
  validateLinkOperationInput,
} from "./operation-validation.js";
import { LINK_CONNECTION_RECIPES, resolveLinkRecipeId } from "./recipes.js";
import type { LinkOperationAuthorization } from "./operation-types.js";

const authority: LinkOperationAuthorization = {
  connectionId: "connection",
  providerId: "github",
  accountId: "42",
  recipeId: "broker-oauth",
  authorityRevision: "revision",
  capabilityIds: ["github.create_issue", "github.list_repositories"],
  resources: {
    kind: "selected-resources",
    groups: [{ id: "repositories", items: [{ id: "owner/repo" }] }],
  },
};

describe("reviewed operation contracts", () => {
  test("the complete catalog equals the committed immutable snapshot", () => {
    expect(
      Object.fromEntries(LINK_OPERATION_CONTRACTS.map((item) => [item.operationId, item])),
    ).toEqual(
      JSON.parse(readFileSync(new URL("../contracts/operations.v1.json", import.meta.url), "utf8")),
    );
    expect(new Set(LINK_OPERATION_CONTRACTS.map((item) => item.operationId)).size).toBe(
      LINK_OPERATION_CONTRACTS.length,
    );
    for (const contract of LINK_OPERATION_CONTRACTS) {
      expect(contract.action).toMatch(/^[a-z_]+$/);
      expect(Object.isFrozen(contract.inputSchema)).toBe(true);
      expect(contract.resourcePolicy.group).toBeTruthy();
      expect(contract.effect === "write").toBe(contract.repeatability === "verified-write-once");
    }
  });
  test("legacy Figma summary and explicit content have separate contracts", () => {
    const legacy = getLinkOperationContract("figma", "get_file")!;
    const content = getLinkOperationContract("figma", "read_design_content")!;
    expect(legacy.defaults.depth).toBe(1);
    expect(content.defaults.depth).toBe(2);
    validateLinkOperationInput(legacy, { file_key: "file" });
    expect(() => validateLinkOperationInput(legacy, { file_key: "file", depth: 2 })).toThrow();
    validateLinkOperationInput(content, {
      file_url_or_key: "https://figma.com/design/file/name",
      depth: "2",
    });
    expect(() =>
      validateLinkOperationInput(content, { file_key: "file", file_url_or_key: "other" }),
    ).toThrow();
  });
  test("a create operation authorizes its parent resource without a content trait", () => {
    const contract = getLinkOperationContract("github", "create_issue")!;
    expect(contract.content).toBeUndefined();
    assertLinkOperationAuthorized(
      contract,
      { owner: "OWNER", repo: "Repo", title: "issue" },
      authority,
    );
    expect(() =>
      assertLinkOperationAuthorized(
        contract,
        { owner: "other", repo: "repo", title: "issue" },
        authority,
      ),
    ).toThrow("outside");
    expect(() =>
      assertLinkOperationAuthorized(
        contract,
        { owner: "owner", repo: "repo" },
        { ...authority, recipeId: "cli-session" },
      ),
    ).toThrow();
  });
  test("broker listings require explicit resources and cannot use upstream-scoped authority", () => {
    const contract = getLinkOperationContract("github", "list_repositories")!;
    expect(() =>
      assertLinkOperationAuthorized(
        contract,
        {},
        { ...authority, resources: { kind: "upstream-scoped" } },
      ),
    ).toThrow();
    expect(() =>
      assertLinkOperationAuthorized(
        contract,
        {},
        { ...authority, resources: { kind: "selected-resources", groups: [] } },
      ),
    ).toThrow();
  });
  test("resource URLs never supply an arbitrary endpoint", () => {
    const contract = getLinkOperationContract("figma", "get_file")!;
    const auth: LinkOperationAuthorization = {
      ...authority,
      providerId: "figma",
      capabilityIds: ["figma.get_file"],
      resources: {
        kind: "selected-resources",
        groups: [{ id: "files", items: [{ id: "allowed" }] }],
      },
    };
    assertLinkOperationAuthorized(
      contract,
      { file_url_or_key: "https://www.figma.com/design/allowed/name" },
      auth,
    );
    for (const file_url_or_key of [
      "https://attacker.test/design/allowed",
      "https://user@figma.com/design/allowed",
      "http://figma.com/design/allowed",
      "https://figma.com:444/design/allowed",
      "https://[",
    ])
      expect(() => assertLinkOperationAuthorized(contract, { file_url_or_key }, auth)).toThrow();
  });
  test("inputs and results are bounded before adapters can use them", () => {
    const contract = getLinkOperationContract("github", "get_starred")!;
    expect(() =>
      validateLinkOperationInput(contract, {
        owner: "a",
        repo: "b",
        endpoint: "https://attacker.test",
      }),
    ).toThrow();
    expect(() =>
      validateLinkOperationInput(contract, JSON.parse('{"owner":"a","repo":"b","__proto__":{}}')),
    ).toThrow();
    assertLinkOperationResult(contract, { starred: true });
    expect(() => assertLinkOperationResult(contract, { starred: "yes" })).toThrow();
    expect(() =>
      assertLinkOperationResult(contract, { starred: true, data: "x".repeat(1024 * 1024) }),
    ).toThrow();
  });
  test("recipes derive custody relative to the current Host", () => {
    expect(LINK_CONNECTION_RECIPES["api-token"].credentialOwner).toBe("current-host");
    expect(LINK_CONNECTION_RECIPES["broker-oauth"].credentialOwner).toBe("broker");
    expect(LINK_CONNECTION_RECIPES["cli-session"].credentialOwner).toBe("external-session-owner");
    expect(resolveLinkRecipeId({ linkExecutionBackend: "remote" })).toBe("broker-oauth");
    expect(
      resolveLinkRecipeId({ linkRecipeId: "unknown", linkExecutionBackend: "remote" }),
    ).toBeUndefined();
  });
});
