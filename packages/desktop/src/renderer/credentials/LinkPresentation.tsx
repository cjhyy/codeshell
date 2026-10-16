import React from "react";
import { MoreHorizontal } from "lucide-react";
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

/** A disclosure with normal buttons keeps keyboard focus and destructive confirmations intact. */
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
  const id = React.useId();
  const trigger = React.useRef<HTMLButtonElement>(null);
  if (!context) return <>{children}</>;
  return (
    <div
      className="relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label ?? t("ext.link.directory.accountActions")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      <div
        id={id}
        hidden={!open}
        onClick={(event) => {
          const button = (event.target as Element).closest("button");
          if (button && !(button as HTMLButtonElement).disabled) {
            setOpen(false);
            trigger.current?.focus();
          }
        }}
        className="absolute left-0 top-full z-20 mt-1 flex min-w-40 flex-col items-stretch gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-lg [&_button]:justify-start"
      >
        {children}
      </div>
    </div>
  );
}
