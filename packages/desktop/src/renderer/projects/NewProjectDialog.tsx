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
import type { CloudProjectBinding } from "../../shared/project-runtime";

const CLOUD_ADDRESS_KEY = "codeshell.cloud-workbench.v1";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateLocal: () => Promise<void>;
  cloudBindings?: CloudProjectBinding[];
  onOpenCloudProject?: (binding: CloudProjectBinding) => Promise<void>;
}

/** Own the chooser lifecycle shared by App's sidebar, composer and native menu. */
export function useNewProjectDialog(
  onCreateLocal: () => Promise<void>,
  cloud: Pick<Props, "cloudBindings" | "onOpenCloudProject"> = {},
) {
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
    <NewProjectDialog
      open={open}
      onOpenChange={setOpen}
      onCreateLocal={onCreateLocal}
      {...cloud}
    />,
  ] as const;
}

/** One location chooser shared by the sidebar, composer and native File menu. */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreateLocal,
  cloudBindings = [],
  onOpenCloudProject,
}: Props) {
  const { t } = useT();
  const [location, setLocation] = useState<"choose" | "cloud">("choose");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const projectPendingRef = useRef(false);
  const cloudPendingRef = useRef(false);
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
    cloudPendingRef.current = next;
    pendingRef.current = next || projectPendingRef.current;
    setBusy(pendingRef.current);
  }, []);

  const openProject = async (operation: () => Promise<void>) => {
    if (pendingRef.current) return;
    projectPendingRef.current = true;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      projectPendingRef.current = false;
      pendingRef.current = cloudPendingRef.current;
      setBusy(pendingRef.current);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pendingRef.current && onOpenChange(next)}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md"
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
              onClick={() => void openProject(onCreateLocal)}
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
          <div className="grid gap-4">
            {cloudBindings.length > 0 && onOpenCloudProject && (
              <section className="grid gap-2" aria-label={t("sidebar.linkedCloudProjects")}>
                <p className="text-sm font-medium">{t("sidebar.linkedCloudProjects")}</p>
                {cloudBindings.map((binding) => (
                  <Button
                    key={binding.id}
                    type="button"
                    variant="outline"
                    className="h-auto justify-start gap-3 whitespace-normal p-3 text-left"
                    aria-label={t("sidebar.openLinkedCloudProject", {
                      name: binding.remoteProjectName,
                    })}
                    disabled={busy}
                    onClick={() => void openProject(() => onOpenCloudProject(binding))}
                  >
                    <Cloud className="shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">
                      <span className="block">{binding.remoteProjectName}</span>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {binding.environmentName} · {binding.origin}
                      </span>
                    </span>
                  </Button>
                ))}
                {error && (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {error}
                  </p>
                )}
              </section>
            )}
            <fieldset disabled={busy} className="min-w-0">
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
            </fieldset>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
