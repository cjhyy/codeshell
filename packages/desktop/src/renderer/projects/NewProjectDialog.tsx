import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Cloud, Loader2, Monitor } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n";

const CLOUD_ADDRESS_KEY = "codeshell.cloud-workbench.v1";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateLocal: () => Promise<void>;
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
  const addressRef = useRef<HTMLInputElement>(null);
  const localRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const addressId = useId();

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
      if (location === "cloud") addressRef.current?.focus();
      else localRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, location]);

  const create = async (target: "local" | "cloud") => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (target === "local") {
        await onCreateLocal();
      } else {
        const result = await window.codeshell.openCloudWorkbench(address.trim());
        try {
          window.localStorage.setItem(CLOUD_ADDRESS_KEY, result.address);
        } catch {
          // A bookmark is optional; opening the cloud project still succeeds.
        }
      }
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
              onClick={() => void create("local")}
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
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!composingRef.current && address.trim()) void create("cloud");
            }}
          >
            <div className="grid gap-2">
              <label htmlFor={addressId} className="text-sm font-medium">
                {t("sidebar.cloudAddress")}
              </label>
              <Input
                ref={addressRef}
                id={addressId}
                value={address}
                inputMode="url"
                placeholder="https://cloud.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setError(null);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)
                  )
                    event.preventDefault();
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${addressId}-error` : undefined}
              />
              {error && (
                <p
                  id={`${addressId}-error`}
                  role="alert"
                  className="break-words text-sm text-destructive"
                >
                  {error}
                </p>
              )}
            </div>
            <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setLocation("choose");
                }}
              >
                <ArrowLeft aria-hidden />
                {t("sidebar.projectBack")}
              </Button>
              <Button type="submit" disabled={busy || !address.trim()}>
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                {t("sidebar.openCloud")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
