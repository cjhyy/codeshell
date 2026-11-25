// Run by UnifiedDiffViewer.review.test.ts in a clean process.
import assert from "node:assert/strict";
import { toPierreFileDiff } from "../code-view/pierreDiffModel";
import { splitDiffSections } from "./diffSections";

const patch = [
  'diff --git "a/ padded name.ts " "b/ padded name.ts "',
  "index 1111111..2222222 100644",
  '--- "a/ padded name.ts "',
  '+++ "b/ padded name.ts "',
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old line",
  "+new line",
  " tail",
  "",
].join("\n");

const [section] = splitDiffSections(patch);
assert.ok(section);
const pierre = toPierreFileDiff(section, "cache-key");
assert.equal(pierre?.name, " padded name.ts ");
assert.equal(pierre?.prevName, undefined);
assert.equal(pierre?.cacheKey, "cache-key");
assert.equal(pierre?.hunks.length, 1);
// A header-only section has no body for Pierre.
const [binary] = splitDiffSections(
  "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
);
assert.ok(binary);
assert.equal(toPierreFileDiff(binary, "binary"), null);
