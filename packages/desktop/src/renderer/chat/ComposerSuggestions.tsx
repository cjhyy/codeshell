import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/** Suggestions share the textarea's focus while escaping clipped chat/dock surfaces. */
export function ComposerSuggestions({
  anchorRef,
  label,
  selected,
  items,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  selected: number;
  items: readonly unknown[];
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    contentRef.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [items, selected]);

  return (
    <Popover open>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        ref={contentRef}
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
