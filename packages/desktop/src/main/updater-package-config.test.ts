import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));

function parseSimpleYaml(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf(":");
        const key = line.slice(0, separator).trim();
        const value = line
          .slice(separator + 1)
          .trim()
          .replace(/^(['"])(.*)\1$/, "$2");
        return [key, value];
      }),
  );
}

describe("desktop updater package configuration", () => {
  test("packages app-update.yml in directory-only builds", () => {
    const pkg = JSON.parse(readFileSync(`${desktopRoot}/package.json`, "utf8")) as {
      build?: {
        extraResources?: Array<{ from?: string; to?: string }>;
        publish?: Array<{ provider?: string; owner?: string; repo?: string }>;
      };
    };
    const updateConfig = parseSimpleYaml(
      readFileSync(`${desktopRoot}/resources/app-update.yml`, "utf8"),
    );
    const publishConfig = pkg.build?.publish?.[0];

    expect(pkg.build?.extraResources).toContainEqual({
      from: "resources/app-update.yml",
      to: "app-update.yml",
    });
    expect(updateConfig).toEqual({
      owner: publishConfig?.owner,
      repo: publishConfig?.repo,
      provider: publishConfig?.provider,
      updaterCacheDirName: "@cjhyycode-shell-desktop-updater",
    });
  });
});
