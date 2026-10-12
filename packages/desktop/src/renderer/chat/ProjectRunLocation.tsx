import React, { useId, useRef, useState } from "react";
import { Check, ChevronDown, Cloud, ExternalLink, Loader2, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "../i18n/I18nProvider";
import { projectLabel, type TrackedProject } from "../projects";

interface Props {
  project: TrackedProject | null;
  disabled?: boolean;
}

/** Native chats execute locally; cloud selection opens this project's mapped remote workspace. */
export function ProjectRunLocation({ project, disabled = false }: Props) {
  const { t } = useT();
  const addressId = useId();
  const errorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const openingRef = useRef(false);
  const storageKey = project ? `codeshell.project-cloud-target.v1:${project.id}` : null;
  const [savedAddress, setSavedAddress] = useState(() => {
    try {
      return storageKey ? (localStorage.getItem(storageKey) ?? "") : "";
    } catch {
      return "";
    }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [address, setAddress] = useState(savedAddress);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);

  const configureCloud = () => {
    setAddress(savedAddress);
    setError("");
    setDialogOpen(true);
  };
  const openCloud = async (target: string) => {
    if (!project || disabled || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError("");
    try {
      const result = await window.codeshell.openCloudProject(target.trim());
      setSavedAddress(result.address);
      try {
        if (storageKey) localStorage.setItem(storageKey, result.address);
      } catch {
        /* Opening remains usable when UI preference storage is unavailable. */
      }
      setDialogOpen(false);
    } catch (cause) {
      setAddress(target);
      setError(cause instanceof Error ? cause.message : String(cause));
      setDialogOpen(true);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  const closeThenAct = (action: () => void) => {
    pendingActionRef.current = action;
    setMenuOpen(false);
  };

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(next) => {
          if (next) pendingActionRef.current = null;
          setMenuOpen(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:pointer-events-none disabled:opacity-50"
            disabled={disabled || opening || !project}
            aria-label={t("chat.runLocation.current")}
            title={project ? t("chat.runLocation.current") : t("chat.runLocation.chooseProject")}
          >
            {opening ? <Loader2 size={12} className="animate-spin" /> : <Monitor size={12} />}
            <span>{t("chat.runLocation.thisComputer")}</span>
            <ChevronDown size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label={t("chat.runLocation.title")}
          side="top"
          align="start"
          className="w-64 rounded-xl p-1.5"
          onCloseAutoFocus={(event) => {
            const action = pendingActionRef.current;
            if (!action) return;
            pendingActionRef.current = null;
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
            // Release Radix menu focus/pointer locks before opening the dialog.
            action();
          }}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          <DropdownMenuLabel>{t("chat.runLocation.title")}</DropdownMenuLabel>
          <DropdownMenuItem aria-label={t("chat.runLocation.thisComputer")}>
            <Monitor size={14} aria-hidden />
            <span className="flex-1">{t("chat.runLocation.thisComputer")}</span>
            <Check size={14} aria-hidden />
          </DropdownMenuItem>
          <DropdownMenuItem
            aria-label={t("chat.runLocation.cloud")}
            onSelect={() =>
              closeThenAct(savedAddress ? () => void openCloud(savedAddress) : configureCloud)
            }
          >
            <Cloud size={14} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block">{t("chat.runLocation.cloud")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("chat.runLocation.cloudHint")}
              </span>
            </span>
            <ExternalLink size={12} className="shrink-0" aria-hidden />
          </DropdownMenuItem>
          {savedAddress && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => closeThenAct(configureCloud)}>
                {t("chat.runLocation.changeCloud")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!openingRef.current) setDialogOpen(next);
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md"
          showClose={!opening}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (openingRef.current || event.isComposing || event.keyCode === 229)
              event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("chat.runLocation.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("chat.runLocation.dialogDescription", {
                name: project ? projectLabel(project) : "",
              })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void openCloud(address);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
              )
                event.preventDefault();
            }}
          >
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor={addressId}>
                {t("chat.runLocation.address")}
              </label>
              <Input
                id={addressId}
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setError("");
                }}
                placeholder="https://cloud.example.com/?project=…"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={opening || disabled}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
              />
              {error && (
                <p id={errorId} role="alert" className="break-words text-sm text-status-err">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={opening}
                onClick={() => setDialogOpen(false)}
              >
                {t("misc.dialog.cancel")}
              </Button>
              <Button type="submit" disabled={!address.trim() || opening || disabled}>
                {opening && <Loader2 size={14} className="animate-spin" aria-hidden />}
                {t("chat.runLocation.openCloud")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
