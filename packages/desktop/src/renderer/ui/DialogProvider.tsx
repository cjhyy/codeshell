/**
 * Command-imperative dialog hooks — one Provider, three hooks:
 *
 *   useConfirm(opts) → Promise<boolean>       确认 / 取消
 *   useAlert(opts)   → Promise<void>          纯提示 / 报错(单个「知道了」)
 *   usePrompt(opts)  → Promise<string | null> 文本输入(取消 → null)
 *
 * Replaces the browser-native window.confirm/alert/prompt scattered across the
 * renderer with shadcn Dialog modals (consistent look, themeable, escapable).
 * Mounted once at the root; calls return a Promise so callers stay imperative:
 *
 *   if (await confirm({ message: "删除？", destructive: true })) …
 *   const name = await prompt({ message: "项目名", defaultValue: cur });
 *
 * The queueing/resolver logic lives in the pure ./dialogState reducer (unit
 * tested); this file is the thin React + shadcn rendering shell.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import {
  initialDialogState,
  enqueue,
  resolveActive,
  type DialogRequest,
  type ConfirmDialogOptions,
  type AlertDialogOptions,
  type PromptDialogOptions,
} from "./dialogState";

interface DialogApi {
  confirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
  alert: (opts: AlertDialogOptions) => Promise<void>;
  prompt: (opts: PromptDialogOptions) => Promise<string | null>;
}

const DialogContextRef = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(initialDialogState);

  const open = useCallback(
    (req: Omit<DialogRequest, "resolve">) =>
      new Promise<unknown>((resolve) => {
        setState((s) => enqueue(s, { ...req, resolve }));
      }),
    [],
  );

  const close = useCallback((value: unknown) => {
    setState((s) => resolveActive(s, value));
  }, []);

  const api: DialogApi = {
    confirm: (options) =>
      open({ kind: "confirm", options }) as Promise<boolean>,
    alert: (options) =>
      open({ kind: "alert", options }).then(() => undefined),
    prompt: (options) =>
      open({ kind: "prompt", options }) as Promise<string | null>,
  };

  const active = state.active;

  return (
    <DialogContextRef.Provider value={api}>
      {children}
      {active?.kind === "confirm" && (
        <ConfirmModal
          options={active.options as ConfirmDialogOptions}
          onResult={(ok) => close(ok)}
        />
      )}
      {active?.kind === "alert" && (
        <AlertModal
          options={active.options as AlertDialogOptions}
          onClose={() => close(undefined)}
        />
      )}
      {active?.kind === "prompt" && (
        <PromptModal
          options={active.options as PromptDialogOptions}
          onResult={(v) => close(v)}
        />
      )}
    </DialogContextRef.Provider>
  );
}

function useDialogApi(): DialogApi {
  const ctx = useContext(DialogContextRef);
  if (!ctx) throw new Error("dialog hooks must be used inside <DialogProvider>");
  return ctx;
}

export function useConfirm(): (opts: ConfirmDialogOptions) => Promise<boolean> {
  return useDialogApi().confirm;
}
export function useAlert(): (opts: AlertDialogOptions) => Promise<void> {
  return useDialogApi().alert;
}
export function usePrompt(): (opts: PromptDialogOptions) => Promise<string | null> {
  return useDialogApi().prompt;
}

/** A header shared by all three modals (title optional, message + detail). */
function ModalHead({
  title,
  message,
  detail,
}: {
  title?: string;
  message: string;
  detail?: string;
}) {
  return (
    <DialogHeader>
      {/* Radix requires a DialogTitle inside every DialogContent (a11y) —
          callers usually pass only `message`, so render it as an sr-only
          title then: screen readers get a name, visuals stay unchanged. */}
      <DialogTitle className={title ? undefined : "sr-only"}>{title ?? message}</DialogTitle>
      <DialogDescription className="text-foreground">{message}</DialogDescription>
      {detail && (
        <p className="text-xs text-muted-foreground">{detail}</p>
      )}
    </DialogHeader>
  );
}

function ConfirmModal({
  options,
  onResult,
}: {
  options: ConfirmDialogOptions;
  onResult: (ok: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Dialog open onOpenChange={(o) => !o && onResult(false)}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={() => onResult(false)}>
        <ModalHead title={options.title} message={options.message} detail={options.detail} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onResult(false)}>
            {options.cancelLabel ?? t("misc.dialog.cancel")}
          </Button>
          <Button
            variant={options.destructive ? "destructive" : "solid"}
            onClick={() => onResult(true)}
            autoFocus
          >
            {options.confirmLabel ?? t("misc.dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlertModal({
  options,
  onClose,
}: {
  options: AlertDialogOptions;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={() => onClose()}>
        <ModalHead title={options.title} message={options.message} detail={options.detail} />
        <DialogFooter>
          <Button variant="solid" onClick={onClose} autoFocus>
            {options.okLabel ?? t("misc.dialog.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromptModal({
  options,
  onResult,
}: {
  options: PromptDialogOptions;
  onResult: (value: string | null) => void;
}) {
  const { t } = useT();
  const [value, setValue] = useState(options.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  // Select the prefilled text on open so editing/replacing is one keystroke.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, []);

  const submit = () => onResult(value);

  return (
    <Dialog open onOpenChange={(o) => !o && onResult(null)}>
      <DialogContent className="max-w-sm" onEscapeKeyDown={() => onResult(null)}>
        <ModalHead title={options.title} message={options.message} detail={options.detail} />
        <Input
          ref={inputRef}
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onResult(null)}>
            {options.cancelLabel ?? t("misc.dialog.cancel")}
          </Button>
          <Button variant="solid" onClick={submit}>
            {options.confirmLabel ?? t("misc.dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
