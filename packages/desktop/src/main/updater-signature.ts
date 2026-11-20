const RELEASE_TAG_BASE_URL = "https://github.com/cjhyy/codeshell/releases/tag";

export function releaseUrlForVersion(version: string): string {
  const trimmed = version.trim();
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return `${RELEASE_TAG_BASE_URL}/${encodeURIComponent(tag)}`;
}

export function macSignatureNeedsManualInstall(text: string): boolean {
  // Squirrel validates the installed requirement. Our release leaf has no Apple team ID.
  const releaseLeaf = "30a64d20fc3614e327902f45cf9b725e6e1986dc";
  const requirement =
    /^designated => identifier "com\.cjhyy\.codeshell"(?: and certificate leaf = H"([0-9a-fA-F]{40})")?$/;
  for (const line of text.split("\n")) {
    const match = requirement.exec(line.trim());
    if (match && (!match[1] || match[1].toLowerCase() === releaseLeaf)) return false;
  }

  return (
    /^\s*Signature=adhoc\s*$/m.test(text) ||
    /^\s*TeamIdentifier=not set\s*$/m.test(text) ||
    /^\s*# designated => cdhash H"/m.test(text)
  );
}
