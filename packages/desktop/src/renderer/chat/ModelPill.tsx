import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Zap } from "lucide-react";

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
    <div className="composer-pill-wrap" ref={ref}>
      <button
        type="button"
        className="composer-pill composer-model-pill"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Zap size={12} />
        <span>{label}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <ul className="composer-popover composer-popover-wide">
          {options.length === 0 ? (
            <li className="composer-popover-empty">
              settings.json 里还没声明 models
            </li>
          ) : (
            options.map((o) => (
              <li
                key={o.key}
                className={`composer-popover-item${o.key === activeKey ? " active" : ""}`}
                onClick={() => {
                  onSelect(o);
                  setOpen(false);
                }}
              >
                <span className="composer-popover-prov">{o.provider}</span>
                <span>{o.label}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
