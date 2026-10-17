import { expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} package paths and Main URL preserve spaces and Unicode`, () => {
    const root = resolve(
      tmpdir(),
      "owned 包 build",
      platform === "darwin" ? "code-shell.app" : `${platform}-unpacked`,
    );
    const layout = describePackagedAppLayout(root, { platform });
    const resources =
      platform === "darwin" ? join(root, "Contents", "Resources") : join(root, "resources");
    expect(layout).toEqual({
      root,
      resources,
      executable:
        platform === "darwin"
          ? join(root, "Contents", "MacOS", "code-shell")
          : join(root, platform === "win32" ? "code-shell.exe" : "@cjhyycode-shell-desktop"),
      managedNode: join(
        resources,
        "runtimes",
        "node",
        "bin",
        platform === "win32" ? "node.exe" : "node",
      ),
      mainURLPrefix: pathToFileURL(join(resources, "app.asar", "out", "main") + sep).href,
    });
    const mainUrl = pathToFileURL(
      join(resources, "app.asar", "out", "main", "chunks", "entry.mjs"),
    ).href;
    expect(mainUrl.startsWith(layout.mainURLPrefix)).toBe(true);
    expect(mainUrl.includes("\\")).toBe(false);
    expect(layout.mainURLPrefix.endsWith("/")).toBe(true);
    expect(layout.mainURLPrefix.includes("%20")).toBe(true);
    expect(
      pathToFileURL(
        join(resources, "app.asar", "out", "main-foreign", "entry.mjs"),
      ).href.startsWith(layout.mainURLPrefix),
    ).toBe(false);
  });
}

test("package layout defaults to the actual platform and rejects unsupported platforms", () => {
  expect(describePackagedAppLayout("owned")).toEqual(
    describePackagedAppLayout("owned", { platform: process.platform }),
  );
  expect(() => describePackagedAppLayout("owned", { platform: "freebsd" })).toThrow(
    "Unsupported packaged platform",
  );
});
