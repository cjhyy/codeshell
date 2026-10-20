import React from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "../i18n/I18nProvider";

export interface LinkPrimaryAction {
  onClick: () => void;
  disabled?: boolean;
}

/** Presentation only: never changes the selected execution account or its grants. */
export const LinkPresentationContext = React.createContext<{
  primaryOption?: string;
  advanced: boolean;
  registerAction: (action?: LinkPrimaryAction) => void;
} | null>(null);

function optionGroup(optionId: string) {
  return optionId.startsWith("method:")
    ? optionId.slice(0, optionId.indexOf(":", "method:".length))
    : optionId;
}

export function useLinkPrimaryAction(optionId: string, action: LinkPrimaryAction): boolean {
  const context = React.useContext(LinkPresentationContext);
  const selected = Boolean(context && context.primaryOption === optionId);
  const primary = Boolean(
    context?.primaryOption && optionGroup(context.primaryOption) === optionGroup(optionId),
  );
  const callback = React.useRef(action.onClick);
  callback.current = action.onClick;
  const register = context?.registerAction;
  React.useEffect(() => {
    if (!selected || !register) return;
    register({ onClick: () => callback.current(), disabled: action.disabled });
    return () => register(undefined);
  }, [selected, register, action.disabled]);
  return primary;
}

export function LinkConnectionOption({
  optionId,
  children,
}: {
  optionId: string;
  children: React.ReactNode;
}) {
  const context = React.useContext(LinkPresentationContext);
  return (
    <div
      data-link-option={optionId}
      hidden={Boolean(
        context &&
        !context.advanced &&
        (!context.primaryOption || optionGroup(context.primaryOption) !== optionGroup(optionId)),
      )}
    >
      {children}
    </div>
  );
}

/** Portal and collision handling keep account actions reachable inside scrolling dialogs. */
export function LinkAccountMenu({
  children,
  label,
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const context = React.useContext(LinkPresentationContext);
  const { t } = useT();
  const [open, setOpen] = React.useState(false);
  const triggerId = React.useId();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const resizeGeneration = React.useRef(0);
  const resizeReturn = React.useRef<{
    opener: HTMLButtonElement | null;
    content: HTMLDivElement | null;
    generation: number;
  } | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const closeForResize = () => {
      const focused = document.activeElement;
      const opener = triggerRef.current;
      const content = contentRef.current;
      resizeReturn.current = {
        opener: focused === opener || content?.contains(focused) ? opener : null,
        content,
        generation: ++resizeGeneration.current,
      };
      setOpen(false);
    };
    window.addEventListener("resize", closeForResize);
    return () => window.removeEventListener("resize", closeForResize);
  }, [open]);
  if (!context) return <>{children}</>;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          resizeGeneration.current += 1;
          resizeReturn.current = null;
        }
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          aria-label={label ?? t("ext.link.directory.accountActions")}
          data-link-account-menu-open={open}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        aria-labelledby={triggerId}
        data-link-account-menu
        data-link-account-menu-trigger={triggerId}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          const pending = resizeReturn.current;
          if (!pending) return;
          resizeReturn.current = null;
          event.preventDefault();
          const focused = document.activeElement;
          const { opener, content, generation } = pending;
          if (
            !opener?.isConnected ||
            (focused !== opener && focused !== document.body && !content?.contains(focused))
          )
            return;
          opener.focus({ preventScroll: true });
          void (async () => {
            // The dialog's height transitions after native resize. Reveal the
            // launcher only when those bounds settle and it still owns focus.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const dialog = opener.closest("[data-link-provider-dialog]");
            await Promise.all(
              (dialog?.getAnimations() ?? []).map((animation) =>
                animation.finished.catch(() => undefined),
              ),
            );
            if (
              generation === resizeGeneration.current &&
              opener.isConnected &&
              document.activeElement === opener
            )
              opener.scrollIntoView({ block: "nearest", inline: "nearest" });
          })();
        }}
        className="flex min-w-40 flex-col items-stretch gap-1 [&_button]:w-full [&_button]:justify-start"
      >
        {React.Children.map(children, (child) =>
          React.isValidElement<{ disabled?: boolean }>(child) ? (
            <DropdownMenuItem asChild disabled={child.props.disabled}>
              {child}
            </DropdownMenuItem>
          ) : null,
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
