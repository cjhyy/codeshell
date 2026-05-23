import React, { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  matchCount: number;
}

export function SearchBar({ open, value, onChange, onClose, matchCount }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  if (!open) return null;
  return (
    <div className="searchbar">
      <input
        ref={inputRef}
        className="searchbar-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        placeholder="搜索 transcript…"
      />
      <span className="searchbar-count">{matchCount} 处</span>
      <button className="searchbar-close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
