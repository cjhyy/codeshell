import { expect, test } from "bun:test";
import { reviewedLocalPlugins } from "./reviewed-local-plugins.js";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";

test("local package approval belongs to the reviewing document and supports a single overwrite retry", async () => {
  const seen: unknown[] = [];
  const digest = "a".repeat(64);
  const call = async (name: string, input: { reviewToken?: string; overwrite?: boolean }) => {
    if (name === "plugins/previewLocal") return { ok: true, preview: { reviewToken: digest } };
    seen.push(input);
    return input.overwrite
      ? { ok: true, name: "fixture" }
      : { ok: false, alreadyInstalled: true, name: "fixture" };
  };
  const reviews = reviewedLocalPlugins(call as CallShellBusiness);
  const source = { kind: "dir" as const, path: "/chosen" };
  const first = new AbortController().signal;
  const preview = await reviews.preview(source, first);
  if (!preview.ok) throw Error(preview.error);
  const chosen = { ...source, reviewToken: preview.preview.reviewToken };
  expect(chosen.reviewToken).not.toBe(digest);
  await expect(reviews.install(chosen, new AbortController().signal)).rejects.toThrow(/expired/);
  await expect(reviews.install({ ...chosen, path: "/other" }, first)).rejects.toThrow(/expired/);
  expect(await reviews.install(chosen, first)).toMatchObject({ alreadyInstalled: true });
  expect(await reviews.install({ ...chosen, overwrite: true }, first)).toMatchObject({ ok: true });
  await expect(reviews.install(chosen, first)).rejects.toThrow(/expired/);
  expect(seen).toEqual([
    { ...source, reviewToken: digest, overwrite: undefined },
    { ...source, reviewToken: digest, overwrite: true },
  ]);
});
