import { describe, expect, test } from "bun:test";
import type { TrackedProject } from "../projects";
import { projectIdForPetWorkspacePath } from "./PetAutoDelegationHost";

const projects: TrackedProject[] = [
  { id: "codeshell", name: "codeshell", path: "/work/codeshell", addedAt: 1 },
  { id: "website", name: "website", path: "/work/website", addedAt: 2 },
];

describe("Pet automatic delegation", () => {
  test("binds the LLM-selected Workspace by exact host-validated path", () => {
    expect(projectIdForPetWorkspacePath(projects, "/work/website")).toBe("website");
    expect(projectIdForPetWorkspacePath(projects, "/work/codeshell")).toBe("codeshell");
  });

  test("preserves an explicit no-workspace selection", () => {
    expect(projectIdForPetWorkspacePath(projects, null)).toBeNull();
  });

  test("tolerates a trailing-separator difference between host and renderer paths", () => {
    expect(projectIdForPetWorkspacePath(projects, "/work/website/")).toBe("website");
    expect(
      projectIdForPetWorkspacePath(
        [{ id: "codeshell", name: "codeshell", path: "/work/codeshell/", addedAt: 1 }],
        "/work/codeshell",
      ),
    ).toBe("codeshell");
  });

  test("fails closed when the renderer no longer tracks the selected Workspace", () => {
    expect(projectIdForPetWorkspacePath(projects, "/work/deleted")).toBeUndefined();
  });
});
