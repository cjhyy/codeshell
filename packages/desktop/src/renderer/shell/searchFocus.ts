const dialogOpeners = new WeakMap<HTMLElement, HTMLElement | null>();

/** Remember the original target while a search dialog hands focus to another search. */
export function rememberSearchDialogOpener(dialog: HTMLElement, opener: HTMLElement | null): void {
  dialogOpeners.set(dialog, opener);
}

export function resolveSearchOpener(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement)) return null;
  for (let node: Node | null = active; node; node = node.parentNode) {
    if (node instanceof HTMLElement && dialogOpeners.has(node)) {
      return dialogOpeners.get(node) ?? null;
    }
  }
  return active;
}
