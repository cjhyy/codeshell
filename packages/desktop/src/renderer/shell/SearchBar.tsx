import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <div className="absolute right-3 top-3 z-20 flex items-center gap-2 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
      <Input
        ref={inputRef}
        className="h-8 w-64"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        placeholder="搜索 transcript…"
      />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{matchCount} 处</span>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label="关闭">
        <X size={14} />
      </Button>
    </div>
  );
}
