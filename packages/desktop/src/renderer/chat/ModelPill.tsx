import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Zap } from "lucide-react";

export interface ModelOption {
  provider: string;
  model: string;
  /** Optional UI label override. Defaults to model id. */
  label?: string;
}

interface Props {
  active: { provider: string; model: string } | null;
  options: ModelOption[];
  onSelect: (opt: ModelOption) => void;
  disabled?: boolean;
}

export function ModelPill({ active, options, onSelect, disabled }: Props) {
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

  const label =
    active
      ? options.find((o) => o.provider === active.provider && o.model === active.model)?.label
        ?? active.model
      : "选择模型";

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
              settings.json 里还没声明 providers
            </li>
          ) : (
            options.map((o) => {
              const isActive = active?.provider === o.provider && active?.model === o.model;
              return (
                <li
                  key={`${o.provider}::${o.model}`}
                  className={`composer-popover-item${isActive ? " active" : ""}`}
                  onClick={() => {
                    onSelect(o);
                    setOpen(false);
                  }}
                >
                  <span className="composer-popover-prov">{o.provider}</span>
                  <span>{o.label ?? o.model}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
