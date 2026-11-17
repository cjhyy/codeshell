import { expect, test } from "bun:test";
import { parseWebsiteComputers, websiteComputerClaim } from "./website-devices.js";
import {
  safeWebsiteReturn,
  websiteCloudSelected,
  websiteComputerTarget,
  websiteRouteUrl,
} from "./website-routes.js";

const origin = "https://codeshell.site";
const host = {
  hostId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  name: "我的电脑",
  online: true,
  revoked: false,
  publicOrigin: "https://11111111-1111-4111-8111-111111111111.devices.codeshell.site",
};
test("computer projection rejects duplicate identities and noncanonical or account origins", () => {
  expect(parseWebsiteComputers({ hosts: [host] }, origin)).toEqual([host]);
  expect(() => parseWebsiteComputers({ hosts: [host, host] }, origin)).toThrow();
  for (const publicOrigin of [
    origin,
    host.publicOrigin + "/path",
    host.publicOrigin.replace("https:", "http:"),
    "https://other.devices.codeshell.site",
  ])
    expect(() => parseWebsiteComputers({ hosts: [{ ...host, publicOrigin }] }, origin)).toThrow();
});
test("claim authority is bound to the selected host and fixed one-use fragment route", () => {
  const claim = {
    hostId: host.hostId,
    publicOrigin: host.publicOrigin,
    claimUrl: `${host.publicOrigin}/__relay/claim#${"T".repeat(43)}`,
    expiresAt: Date.now() + 60000,
  };
  expect(websiteComputerClaim(claim, host)).toBe(claim.claimUrl);
  for (const replacement of [
    { hostId: host.environmentId },
    { publicOrigin: origin },
    { expiresAt: Date.now() - 1 },
    { claimUrl: claim.claimUrl.replace("/__relay/claim", "/mobile") },
    { claimUrl: claim.claimUrl.replace("/__relay/claim", "/__relay/claim?token=secret") },
    { claimUrl: claim.claimUrl.replace(host.publicOrigin, "https://foreign.example") },
    { claimUrl: claim.claimUrl.replace("https://", "https://user:secret@") },
  ])
    expect(() => websiteComputerClaim({ ...claim, ...replacement }, host)).toThrow();
});
test("destination navigation preserves public project selections without accepting unknown destinations", () => {
  expect(websiteCloudSelected(new URL(origin + "/app"))).toBe(false);
  expect(websiteCloudSelected(new URL(origin + "/app?target=cloud"))).toBe(true);
  expect(websiteCloudSelected(new URL(origin + `/app?project=${host.hostId}`))).toBe(true);
  expect(websiteCloudSelected(new URL(origin + `/app?target=choose&project=${host.hostId}`))).toBe(
    false,
  );
  const current = new URL(origin + `/app?target=cloud&project=${host.hostId}&token=secret`);
  expect(websiteRouteUrl({ kind: "account", section: "profile" }, current)).toBe(
    `/settings/account/profile?target=cloud&project=${host.hostId}`,
  );
  expect(safeWebsiteReturn("/app?target=https://foreign.example&token=secret", origin)).toBe(
    "/app",
  );
});

test("selected computer URLs survive login and account settings without Cloud or project authority", () => {
  const current = new URL(
    `/app?target=cloud&computer=${host.hostId}&project=${host.environmentId}&session=old-chat&view=files&token=private`,
    origin,
  );
  const destination = `/app?target=choose&computer=${host.hostId}`;
  expect(websiteComputerTarget(current)).toBe(host.hostId);
  expect(websiteCloudSelected(current)).toBe(false);
  expect(safeWebsiteReturn(current.pathname + current.search, origin)).toBe(destination);
  const settings = websiteRouteUrl({ kind: "account", section: "security" }, current);
  expect(settings).toBe(`/settings/account/security?target=choose&computer=${host.hostId}`);
  expect(websiteRouteUrl({ kind: "workbench" }, new URL(settings, origin))).toBe(destination);
  expect(websiteComputerTarget(new URL("/app?target=choose", origin))).toBeUndefined();
});

test("invalid or duplicate selected computer hints stay visibly invalid across login without copying input", () => {
  for (const query of [
    "computer=",
    "computer=../../foreign",
    "computer=https://foreign.invalid",
    "computer=" + host.hostId.toUpperCase().replace("11111111", "AAAAAAAA"),
    `computer=${host.hostId}&computer=${host.environmentId}`,
  ]) {
    const url = new URL(`/app?target=cloud&${query}&project=${host.environmentId}`, origin);
    expect(websiteComputerTarget(url)).toBeNull();
    expect(websiteCloudSelected(url)).toBe(false);
    expect(safeWebsiteReturn(url.pathname + url.search, origin)).toBe(
      "/app?target=choose&computer=",
    );
  }
});
