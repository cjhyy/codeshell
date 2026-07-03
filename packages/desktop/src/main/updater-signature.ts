const RELEASE_TAG_BASE_URL = "https://github.com/cjhyy/codeshell/releases/tag";

export function releaseUrlForVersion(version: string): string {
  const trimmed = version.trim();
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return `${RELEASE_TAG_BASE_URL}/${encodeURIComponent(tag)}`;
}

export function macSignatureTextLooksAdHoc(text: string): boolean {
  return (
    /^\s*Signature=adhoc\s*$/m.test(text) ||
    /^\s*TeamIdentifier=not set\s*$/m.test(text) ||
    /^\s*# designated => cdhash H"/m.test(text)
  );
}
