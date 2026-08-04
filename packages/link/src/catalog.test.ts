import { describe, expect, test } from "bun:test";
import { LINK_PROVIDER_MANIFESTS, getLinkProviderManifest } from "./catalog.js";

describe("Link provider catalog", () => {
  test("contains ten unique providers with usable local and independent server methods", () => {
    expect(LINK_PROVIDER_MANIFESTS).toHaveLength(10);
    expect(new Set(LINK_PROVIDER_MANIFESTS.map((provider) => provider.id)).size).toBe(10);
    for (const provider of LINK_PROVIDER_MANIFESTS) {
      const local = provider.connectionMethods.find(
        (method) => method.executionRuntime === "local",
      );
      expect(local?.availability).toBe("available");
      expect(local?.authGuide?.createCredentialUrl).toMatch(/^https:\/\//);
      expect(local?.authGuide?.docsUrl).toMatch(/^https:\/\//);
      expect(local?.authGuide?.steps.length).toBeGreaterThanOrEqual(3);
      expect(
        provider.connectionMethods.some((method) => method.executionRuntime === "server"),
      ).toBe(true);
    }
  });

  test("prefills GitHub and GitLab least-privilege token creation", () => {
    const github = getLinkProviderManifest("github")!;
    const githubUrl = new URL(github.connectionMethods[0]!.authGuide!.createCredentialUrl);
    expect(githubUrl.searchParams.get("contents")).toBe("read");
    expect(githubUrl.searchParams.get("issues")).toBe("write");
    expect(githubUrl.searchParams.get("pull_requests")).toBe("read");

    const gitlab = getLinkProviderManifest("gitlab")!;
    const gitlabUrl = new URL(gitlab.connectionMethods[0]!.authGuide!.createCredentialUrl);
    expect(gitlabUrl.searchParams.get("scopes")).toBe("read_api");
  });

  test("declares zero-copy sessions only for provider-owned CLIs with local Actions", () => {
    const commands = Object.fromEntries(
      LINK_PROVIDER_MANIFESTS.flatMap((provider) => {
        const quickAuth = provider.connectionMethods.find(
          (method) => method.executionRuntime === "local",
        )?.quickAuth;
        return quickAuth ? [[provider.id, quickAuth.command]] : [];
      }),
    );
    expect(commands).toEqual({
      github: "gh",
      gitlab: "glab",
      notion: "ntn",
      todoist: "td",
      vercel: "vercel",
    });
  });

  test("offers provider-hosted browser login for GitHub and GitLab without requiring a CLI", () => {
    for (const providerId of ["github", "gitlab"]) {
      const local = getLinkProviderManifest(providerId)?.connectionMethods.find(
        (method) => method.executionRuntime === "local",
      );
      expect(local?.browserAuth).toMatchObject({
        kind: "browser-oauth",
        flow: "device-code",
      });
      expect(local?.browserAuth?.docsUrl).toMatch(/^https:\/\//);
    }
  });
});
