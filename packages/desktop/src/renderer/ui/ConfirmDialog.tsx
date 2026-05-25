import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type Resolver = (ok: boolean) => void;

interface OpenState {
  options: ConfirmOptions;
  resolve: Resolver;
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OpenState | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ options, resolve });
      }),
    [],
  );

  const close = (ok: boolean): void => {
    if (!state) return;
    state.resolve(ok);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <ConfirmDialog
          options={state.options}
          onConfirm={() => close(true)}
          onCancel={() => close(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}

function ConfirmDialog({
  options,
  onConfirm,
  onCancel,
}: {
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    // Default focus on Cancel so destructive enter doesn't fire by accident.
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="confirm-backdrop" onMouseDown={onCancel}>
      <div
        className="confirm-modal"
        role="alertdialog"
        aria-label={options.title ?? "确认"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {options.title && <div className="confirm-title">{options.title}</div>}
        <div className="confirm-message">{options.message}</div>
        {options.detail && <div className="confirm-detail">{options.detail}</div>}
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn-cancel"
            onClick={onCancel}
            autoFocus
          >
            {options.cancelLabel ?? "取消"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`confirm-btn confirm-btn-primary${options.destructive ? " destructive" : ""}`}
            onClick={onConfirm}
          >
            {options.confirmLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Truncate a free-form title so it fits in a dialog headline.
 * Cuts on grapheme-like boundary (chars), keeps ASCII-safe.
 */
export function truncateTitle(input: string, max = 28): string {
  const t = input.trim().replace(/\s+/g, " ");
  if ([...t].length <= max) return t;
  return [...t].slice(0, max).join("") + "…";
}
