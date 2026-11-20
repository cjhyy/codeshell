const RELEASE_TAG_BASE_URL = "https://github.com/cjhyy/codeshell/releases/tag";

export function releaseUrlForVersion(version: string): string {
  const trimmed = version.trim();
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return `${RELEASE_TAG_BASE_URL}/${encodeURIComponent(tag)}`;
}

export function macSignatureNeedsManualInstall(text: string): boolean {
  // Stable designated requirements survive across builds, so Squirrel can
  // validate the update: the bare identifier form (legacy stabilized ad-hoc)
  // and the self-signed "CodeShell Local Signing" form, which has no Team ID.
  if (
    /^\s*designated => identifier "com\.cjhyy\.codeshell"(?: and certificate leaf = H"[0-9a-f]{40}")?\s*$/im.test(
      text,
    )
  ) {
    return false;
  }

  return (
    /^\s*Signature=adhoc\s*$/m.test(text) ||
    /^\s*TeamIdentifier=not set\s*$/m.test(text) ||
    /^\s*# designated => cdhash H"/m.test(text)
  );
}
