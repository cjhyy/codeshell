import React, { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Loader2, Monitor } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CloudProjectManager } from "./CloudProjectManager";
import { useT } from "../i18n";

const CLOUD_ADDRESS_KEY = "codeshell.cloud-workbench.v1";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateLocal: () => Promise<void>;
}

/** Own the chooser lifecycle shared by App's sidebar, composer and native menu. */
export function useNewProjectDialog(onCreateLocal: () => Promise<void>) {
  const [open, setOpen] = useState(false);
  const openNewProject = useCallback(() => setOpen(true), []);
  useEffect(
    () =>
      window.codeshell.onMenuEvent((event) => {
        if (event === "add-project") openNewProject();
      }),
    [openNewProject],
  );
  return [
    openNewProject,
    <NewProjectDialog open={open} onOpenChange={setOpen} onCreateLocal={onCreateLocal} />,
  ] as const;
}

/** One location chooser shared by the sidebar, composer and native File menu. */
export function NewProjectDialog({ open, onOpenChange, onCreateLocal }: Props) {
  const { t } = useT();
  const [location, setLocation] = useState<"choose" | "cloud">("choose");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const composingRef = useRef(false);
  const localRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocation("choose");
    setError(null);
    composingRef.current = false;
    try {
      setAddress(window.localStorage.getItem(CLOUD_ADDRESS_KEY) ?? "");
    } catch {
      setAddress("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (location === "choose") localRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, location]);

  const cloudBusy = useCallback((next: boolean) => {
    pendingRef.current = next;
    setBusy(next);
  }, []);

  const create = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreateLocal();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pendingRef.current && onOpenChange(next)}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={() => {
          openerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onEscapeKeyDown={(event) => {
          if (composingRef.current || event.isComposing || event.keyCode === 229 || busy)
            event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("sidebar.addProject")}</DialogTitle>
          <DialogDescription>
            {t(location === "choose" ? "sidebar.projectLocation" : "sidebar.cloudHint")}
          </DialogDescription>
        </DialogHeader>
        {location === "choose" ? (
          <div className="grid gap-3">
            <Button
              ref={localRef}
              type="button"
              variant="outline"
              className="h-auto justify-start gap-3 whitespace-normal rounded-xl p-4 text-left"
              aria-label={t("sidebar.thisComputer")}
              disabled={busy}
              onClick={() => void create()}
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Monitor aria-hidden />}
              <span>
                <span className="block font-medium">{t("sidebar.thisComputer")}</span>
                <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                  {t("sidebar.thisComputerHint")}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-auto justify-start gap-3 whitespace-normal rounded-xl p-4 text-left"
              aria-label={t("sidebar.cloud")}
              disabled={busy}
              onClick={() => {
                setError(null);
                setLocation("cloud");
              }}
            >
              <Cloud aria-hidden />
              <span>
                <span className="block font-medium">{t("sidebar.cloud")}</span>
                <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                  {t("sidebar.cloudProjectHint")}
                </span>
              </span>
            </Button>
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        ) : (
          <CloudProjectManager
            initialAddress={address}
            onBusyChange={cloudBusy}
            onBack={() => {
              setError(null);
              setLocation("choose");
            }}
            onOpened={(origin) => {
              try {
                window.localStorage.setItem(CLOUD_ADDRESS_KEY, `${origin}/`);
              } catch {
                /* Optional bookmark. */
              }
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
