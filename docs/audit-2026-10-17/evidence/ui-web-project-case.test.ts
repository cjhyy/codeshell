import { test, expect } from "bun:test";
import { projectForCwd, groupByProject } from "../../../packages/web/src/lib/format";

const projects = [
  { id: "upper", name: "Upper project", path: "/srv/Example", roots: [{ path: "/srv/Example" }] },
  { id: "lower", name: "Lower project", path: "/srv/example", roots: [{ path: "/srv/example" }] },
];

test("round 3: exact second POSIX project is incorrectly mapped to first case variant", () => {
  const match = projectForCwd("/srv/example/src", projects);
  expect(match?.id).toBe("upper");
  expect(projectForCwd("/srv/example", projects)?.id).toBe("upper");
  expect(projectForCwd("/srv/example", [...projects].reverse())?.id).toBe("lower");
  console.log(JSON.stringify({ observation: "posix-case-variant-owner", requested: "/srv/example/src", expectedCaseSensitiveProject: "lower", actualProject: match?.id, reversedOrderProject: projectForCwd("/srv/example", [...projects].reverse())?.id }));
});

test("round 3: session groups for distinct case-sensitive directories collapse into one", () => {
  const groups = groupByProject([
    { id: "upper-session", cwd: "/srv/Example", updatedAt: 1 },
    { id: "lower-session", cwd: "/srv/example", updatedAt: 2 },
  ], projects, "zh");
  expect(groups).toHaveLength(1);
  expect(groups[0]?.projectId).toBe("upper");
  expect(groups[0]?.items.map(item => item.id)).toEqual(["upper-session", "lower-session"]);
  console.log(JSON.stringify({ observation: "posix-case-variant-groups", groups }));
});

test("round 3 control: distinct ordinary roots and nested longest prefix work", () => {
  const control = [{ id: "parent", name: "Parent", path: "/srv/project" }, { id: "child", name: "Child", path: "/srv/project/nested" }];
  expect(projectForCwd("/srv/project/nested/src", control)?.id).toBe("child");
  expect(projectForCwd("/srv/project-other", control)).toBeUndefined();
});
