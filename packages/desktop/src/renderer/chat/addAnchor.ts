// Helper for panels to pin a comment anchor to the composer. Decoupled via a
// window event (like "codeshell:review-files") so panels don't prop-drill into
// App. App listens and accumulates the anchor as a chip above the composer.
import { nextAnchorId, type Anchor, type AnchorKind } from "./anchors";

export function addAnchor(input: {
  kind: AnchorKind;
  label: string;
  locator: Record<string, string>;
  comment: string;
}): string {
  const anchor: Anchor = { id: nextAnchorId(), ...input };
  window.dispatchEvent(new CustomEvent("codeshell:add-anchor", { detail: { anchor } }));
  return anchor.id;
}
