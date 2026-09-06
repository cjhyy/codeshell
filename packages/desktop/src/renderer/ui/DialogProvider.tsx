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
  useLayoutEffect,
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
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  const pendingRef = useRef(new Set<DialogRequest>());

  const open = useCallback(
    (req: Omit<DialogRequest, "resolve">) =>
      new Promise<unknown>((resolve) => {
        if (openerRef.current === undefined) {
          openerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        const request = { ...req, resolve };
        pendingRef.current.add(request);
        setState((s) => enqueue(s, request));
      }),
    [],
  );

  const close = useCallback((request: DialogRequest, value: unknown) => {
    // An old event or repeated callback belongs only to the dialog that
    // produced it; it must never resolve the next item in the queue.
    setState((s) => {
      if (s.active !== request) return s;
      pendingRef.current.delete(request);
      return resolveActive(s, value);
    });
  }, []);

  const restoreFocus = useCallback((event: Event) => {
    // Imperative dialogs have no Radix Trigger. Keep the batch's persistent
    // opener until its final request closes, including newly queued requests
    // that have not rendered yet.
    event.preventDefault();
    if (pendingRef.current.size > 0) return;
    const opener = openerRef.current;
    openerRef.current = undefined;
    const focused = document.activeElement;
    if (opener?.isConnected && (!focused || focused === document.body || !focused.isConnected)) {
      opener.focus({ preventScroll: true });
    }
  }, []);

  const api: DialogApi = {
    confirm: (options) => open({ kind: "confirm", options }) as Promise<boolean>,
    alert: (options) => open({ kind: "alert", options }).then(() => undefined),
    prompt: (options) => open({ kind: "prompt", options }) as Promise<string | null>,
  };

  const active = state.active;

  return (
    <DialogContextRef.Provider value={api}>
      {children}
      {active?.kind === "confirm" && (
        <ConfirmModal
          request={active}
          options={active.options as ConfirmDialogOptions}
          onResult={(ok) => close(active, ok)}
          onCloseAutoFocus={restoreFocus}
        />
      )}
      {active?.kind === "alert" && (
        <AlertModal
          request={active}
          options={active.options as AlertDialogOptions}
          onClose={() => close(active, undefined)}
          onCloseAutoFocus={restoreFocus}
        />
      )}
      {active?.kind === "prompt" && (
        <PromptModal
          request={active}
          options={active.options as PromptDialogOptions}
          onResult={(v) => close(active, v)}
          onCloseAutoFocus={restoreFocus}
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

const denyConfirmationWithoutProvider = async (): Promise<boolean> => false;

/**
 * Root-level shells are also rendered directly by a few isolated tests and
 * embedders. Keep those render paths safe while failing closed if they ever
 * try to perform an action that requires confirmation.
 */
export function useOptionalConfirm(): (opts: ConfirmDialogOptions) => Promise<boolean> {
  return useContext(DialogContextRef)?.confirm ?? denyConfirmationWithoutProvider;
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
        <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs leading-5 text-muted-foreground">
          {detail}
        </p>
      )}
    </DialogHeader>
  );
}

function ConfirmModal({
  request,
  options,
  onResult,
  onCloseAutoFocus,
}: {
  request: DialogRequest;
  options: ConfirmDialogOptions;
  onResult: (ok: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useT();
  const confirmRef = useDialogButtonFocus(request);
  return (
    <Dialog open onOpenChange={(o) => !o && onResult(false)}>
      <DialogContent
        className={options.detail?.includes("\n") ? "max-w-2xl" : "max-w-sm"}
        onEscapeKeyDown={preventComposingEscape}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ModalHead title={options.title} message={options.message} detail={options.detail} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onResult(false)}>
            {options.cancelLabel ?? t("misc.dialog.cancel")}
          </Button>
          <Button
            ref={confirmRef}
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
  request,
  options,
  onClose,
  onCloseAutoFocus,
}: {
  request: DialogRequest;
  options: AlertDialogOptions;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useT();
  const okRef = useDialogButtonFocus(request);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-sm"
        onEscapeKeyDown={preventComposingEscape}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ModalHead title={options.title} message={options.message} detail={options.detail} />
        <DialogFooter>
          <Button ref={okRef} variant="solid" onClick={onClose} autoFocus>
            {options.okLabel ?? t("misc.dialog.ok")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromptModal({
  request,
  options,
  onResult,
  onCloseAutoFocus,
}: {
  request: DialogRequest;
  options: PromptDialogOptions;
  onResult: (value: string | null) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useT();
  const [value, setValue] = useState(options.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  // Consecutive prompts reuse this component, even when they share options.
  // Reset before paint, then select the new draft after Radix moves focus.
  useLayoutEffect(() => {
    setValue(options.defaultValue ?? "");
    composingRef.current = false;
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [request, options.defaultValue]);

  const submit = () => onResult(value);

  return (
    <Dialog open onOpenChange={(o) => !o && onResult(null)}>
      <DialogContent
        className="max-w-sm"
        onEscapeKeyDown={(event) => preventComposingEscape(event, composingRef.current)}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ModalHead title={options.title} message={options.message} detail={options.detail} />
        <Input
          ref={inputRef}
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
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

/** Radix handles dismissal through onOpenChange; composition only vetoes it. */
function preventComposingEscape(event: KeyboardEvent, composing = false) {
  if (composing || event.isComposing || event.keyCode === 229) event.preventDefault();
}

function useDialogButtonFocus(request: DialogRequest) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [request]);
  return ref;
}
