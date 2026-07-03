const RELEASE_TAG_BASE_URL = "https://github.com/cjhyy/codeshell/releases/tag";

export function releaseUrlForVersion(version: string): string {
  const trimmed = version.trim();
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return `${RELEASE_TAG_BASE_URL}/${encodeURIComponent(tag)}`;
}

export function macSignatureNeedsManualInstall(text: string): boolean {
  if (/^\s*designated => identifier "com\.cjhyy\.codeshell"\s*$/m.test(text)) {
    return false;
  }

  return (
    /^\s*Signature=adhoc\s*$/m.test(text) ||
    /^\s*TeamIdentifier=not set\s*$/m.test(text) ||
    /^\s*# designated => cdhash H"/m.test(text)
  );
}
