const RELEASE_TAG_BASE_URL = "https://github.com/cjhyy/codeshell/releases/tag";

export function releaseUrlForVersion(version: string): string {
  const trimmed = version.trim();
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return `${RELEASE_TAG_BASE_URL}/${encodeURIComponent(tag)}`;
}

export function macSignatureNeedsManualInstall(text: string): boolean {
  // Squirrel validates the replacement against the installed app's designated
  // requirement. Our local signing certificate has no Apple team identifier.
  const requirement = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("designated => "));
  const app = 'designated => identifier "com.cjhyy.codeshell"';
  const certificate = 'certificate leaf = H"30a64d20fc3614e327902f45cf9b725e6e1986dc"';
  if (requirement === app || requirement === `${app} and ${certificate}`) return false;

  return (
    /^\s*Signature=adhoc\s*$/m.test(text) ||
    /^\s*TeamIdentifier=not set\s*$/m.test(text) ||
    /^\s*# designated => cdhash H"/m.test(text)
  );
}
