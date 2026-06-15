/**
 * Data-driven param controls — renders a model's params[] (from the unified
 * catalog) into widgets. The connection page never branches on provider; it
 * switches on ParamSpec.control. One declaration → both the UI control here and
 * the tool-description doc on the core side.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §5.
 */
import React from "react";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ParamSpec } from "../../preload/types";
import { ConnField } from "./connUi";

export function ParamControls({
  params,
  values,
  onChange,
}: {
  params: ParamSpec[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  if (!params || params.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {params.map((p) => (
        <ParamControl key={p.name} spec={p} value={values[p.name]} onChange={onChange} />
      ))}
    </div>
  );
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}) {
  const label = spec.label ?? spec.name;

  switch (spec.control) {
    case "enum": {
      const options = (spec.options ?? []).map((o) => ({ value: o, label: o }));
      const current = typeof value === "string" ? value : (spec.default as string | undefined) ?? "";
      return (
        <ConnField label={label} hint={spec.doc}>
          <SimpleSelect
            value={current}
            onChange={(v) => onChange(spec.name, v)}
            options={options}
            placeholder={spec.name}
          />
        </ConnField>
      );
    }
    case "number": {
      const current =
        typeof value === "number" ? String(value) : value != null ? String(value) : "";
      return (
        <ConnField label={label} hint={spec.doc}>
          <Input
            type="number"
            value={current}
            min={spec.min}
            max={spec.max}
            placeholder={spec.name}
            onChange={(e) =>
              onChange(spec.name, e.target.value === "" ? undefined : Number(e.target.value))
            }
          />
        </ConnField>
      );
    }
    case "toggle": {
      const current = typeof value === "boolean" ? value : Boolean(spec.default);
      return (
        <label className="flex items-center gap-2 text-sm text-foreground" aria-label={spec.name}>
          <Switch checked={current} onCheckedChange={(c) => onChange(spec.name, c)} />
          <span>{label}</span>
          {spec.doc && <span className="text-xs text-muted-foreground">{spec.doc}</span>}
        </label>
      );
    }
    case "text": {
      const current = typeof value === "string" ? value : "";
      return (
        <ConnField label={label} hint={spec.doc}>
          <Input value={current} placeholder={spec.name} onChange={(e) => onChange(spec.name, e.target.value)} />
        </ConnField>
      );
    }
  }
}
