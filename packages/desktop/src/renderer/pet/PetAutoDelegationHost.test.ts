import { describe, expect, test } from "bun:test";
import type { TrackedProject } from "../projects";
import { resolvePetDelegationProjectId } from "./PetAutoDelegationHost";

const projects: TrackedProject[] = [
  { id: "codeshell", name: "codeshell", path: "/work/codeshell", addedAt: 1 },
  { id: "website", name: "website", path: "/work/website", addedAt: 2 },
];

describe("Pet automatic delegation", () => {
  test("uses an explicitly named workspace before the originating workspace", () => {
    expect(
      resolvePetDelegationProjectId(projects, "去 website 修复登录页", "codeshell", "codeshell"),
    ).toBe("website");
  });

  test("falls back to the originating then active workspace without asking the user", () => {
    expect(resolvePetDelegationProjectId(projects, "修一下登录页", "website", "codeshell")).toBe(
      "website",
    );
    expect(resolvePetDelegationProjectId(projects, "修一下登录页", undefined, "codeshell")).toBe(
      "codeshell",
    );
  });
});
