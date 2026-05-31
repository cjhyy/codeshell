import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Zap, Image } from "lucide-react";

/**
 * One row in the model dropdown.
 *
 * `key` is the engine-side identifier the user has in their
 * settings.json under `models[].key` — same value as the top-level
 * `activeKey` field that code-shell uses to pick the active model.
 * `provider` is just `providerKey` from the same entry; we keep it
 * for UI grouping (left chip in the dropdown).
 */
export interface ModelOption {
  key: string;
  label: string;
  provider: string;
  maxContextTokens?: number;
  /** Whether this model accepts image content blocks. */
  supportsVision?: boolean;
}

interface Props {
  /** Active model key (matches ModelOption.key). */
  activeKey: string | null;
  options: ModelOption[];
  onSelect: (opt: ModelOption) => void;
  disabled?: boolean;
}

export function ModelPill({ activeKey, options, onSelect, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = options.find((o) => o.key === activeKey) ?? null;
  const label = active?.label ?? (activeKey ?? "选择模型");

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Zap size={12} />
        <span>{label}</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>
      {open && (
        <ul className="absolute bottom-full z-50 mb-1 max-h-80 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {options.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">
              settings.json 里还没声明 models
            </li>
          ) : (
            options.map((o) => (
              <li
                key={o.key}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent " +
                  (o.key === activeKey ? "bg-accent" : "")
                }
                onClick={() => {
                  onSelect(o);
                  setOpen(false);
                }}
              >
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{o.provider}</span>
                <span className="flex-1 truncate">{o.label}</span>
                {o.supportsVision && (
                  <Image size={11} aria-label="支持图片输入" className="opacity-60" />
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
