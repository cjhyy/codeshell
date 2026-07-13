const PET_AUTO_DELEGATE_MARKER = "<!--PET:AUTO_DELEGATE-->";

/** Keep Pet's host-control line out of both the live stream and hydrated chat. */
export function visiblePetAssistantText(text: string): string {
  const markerIndex = text.indexOf(PET_AUTO_DELEGATE_MARKER);
  if (markerIndex >= 0) return text.slice(0, markerIndex).trim();

  // The model streams the marker a few characters at a time on its own final
  // line. Hide that incomplete line as soon as it starts, not only after the
  // complete marker has arrived.
  const lineStart = text.lastIndexOf("\n") + 1;
  const tail = text.slice(lineStart).trim();
  if (tail && PET_AUTO_DELEGATE_MARKER.startsWith(tail)) {
    return text.slice(0, lineStart).trim();
  }
  return text.trim();
}
