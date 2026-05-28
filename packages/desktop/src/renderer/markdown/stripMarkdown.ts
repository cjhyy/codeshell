/**
 * Best-effort markdown-to-plain text conversion for the message copy
 * button. Not a full parser — just strips the markers users don't
 * want to paste into Slack / docs / commit messages.
 *
 * Order matters: fenced code blocks first (we keep their content
 * verbatim, only drop the ```), then links / images, then inline
 * emphasis / inline code / headings / lists / blockquotes.
 */
export function stripMarkdownToPlain(input: string): string {
  let s = input;

  // Fenced code blocks ```lang\n...\n``` — keep body, drop fences.
  s = s.replace(/```[\w-]*\n?([\s\S]*?)\n?```/g, (_, body: string) => body);

  // Images: ![alt](url) → alt (drop URL).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Links: [label](url) → "label (url)" so the URL doesn't get lost.
  // Drop angle-bracket autolinks too.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
    label === url ? label : `${label} (${url})`,
  );
  s = s.replace(/<((?:https?|file):[^>\s]+)>/g, "$1");

  // Headings: leading "# " up to 6.
  s = s.replace(/^#{1,6}\s+/gm, "");

  // Blockquotes: leading "> ".
  s = s.replace(/^>\s?/gm, "");

  // Unordered list markers ("- ", "* ", "+ ").
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

  // Ordered list markers ("1. ") kept as-is.

  // Bold/italic/strike — drop the markers, keep the content.
  // Order: longest run first so __x__ doesn't get eaten by _x_.
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/(\*|_)(.+?)\1/g, "$2");
  s = s.replace(/~~(.+?)~~/g, "$1");

  // Inline code: `x` → x.
  s = s.replace(/`([^`]+)`/g, "$1");

  // Horizontal rules.
  s = s.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "");

  // Collapse 3+ blank lines down to 2.
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}
