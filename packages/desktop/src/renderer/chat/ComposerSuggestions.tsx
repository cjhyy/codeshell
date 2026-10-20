import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

export function suggestionOptionId(listboxId: string, identity: string): string {
  return `${listboxId}-option-${encodeURIComponent(identity)}`;
}

/** Suggestions share the textarea's focus while escaping clipped chat/dock surfaces. */
export function ComposerSuggestions({
  id,
  anchorRef,
  label,
  selected,
  items,
  children,
}: {
  id: string;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  selected: number;
  items: readonly unknown[];
  children: ReactNode;
}) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const virtualAnchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          anchorRef.current?.getBoundingClientRect() ?? {
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          },
        get contextElement() {
          return anchorRef.current ?? undefined;
        },
      },
    }),
    [anchorRef],
  );
  // Link the native multiline textbox to the actual portal, rather than a
  // parent's delayed copy of an asynchronously changing mention list. The
  // callback ref also covers Radix mounting its portal after our first render.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !content) return;
    anchor.setAttribute("aria-controls", id);
    const active = content.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (active?.id) anchor.setAttribute("aria-activedescendant", active.id);
    else anchor.removeAttribute("aria-activedescendant");
    return () => {
      // An old popup must not clear a replacement popup's association.
      if (anchor.getAttribute("aria-controls") !== id) return;
      const currentContent = document.getElementById(id);
      if (currentContent && currentContent !== content) return;
      anchor.removeAttribute("aria-controls");
      anchor.removeAttribute("aria-activedescendant");
    };
  }, [anchorRef, content, id, items, selected]);
  useEffect(() => {
    content
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [content, items, selected]);

  return (
    <Popover open>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        ref={setContent}
        id={id}
        side="top"
        sideOffset={8}
        role="listbox"
        aria-label={label}
        className="cs-popup-surface max-h-[min(20rem,var(--radix-popover-content-available-height))] w-80 rounded-md p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The composer owns blur, Escape and selection. The floating list
        // only owns positioning; it must not move the textarea's caret/focus.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
