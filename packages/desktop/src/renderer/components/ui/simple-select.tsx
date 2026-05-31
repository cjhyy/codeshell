import * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Drop-in adapter matching the OLD custom `ui/Select` API
 * (`value` / `onChange` / `options` / `placeholder` / `size` / groups /
 * per-option `description` / `disabled`) but rendered with the shadcn Select
 * underneath. Lets the large settings sections migrate off the legacy
 * black-bordered Select with a one-line import swap instead of rewriting every
 * call site. `searchable` / `searchText` are accepted but ignored (shadcn
 * Select has no built-in search; no current call site depends on it).
 */
export interface SimpleSelectOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  searchText?: string;
}

export interface SimpleSelectOptionGroup<V extends string = string> {
  label: string;
  options: SimpleSelectOption<V>[];
}

export type SimpleSelectItems<V extends string = string> =
  | SimpleSelectOption<V>[]
  | SimpleSelectOptionGroup<V>[];

export interface SimpleSelectProps<V extends string = string> {
  value: V | "";
  onChange: (value: V) => void;
  options: SimpleSelectItems<V>;
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  searchable?: boolean;
  emptyLabel?: React.ReactNode;
  loading?: boolean;
  loadingLabel?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}

function isGroup<V extends string>(
  item: SimpleSelectOption<V> | SimpleSelectOptionGroup<V>,
): item is SimpleSelectOptionGroup<V> {
  return (item as SimpleSelectOptionGroup<V>).options !== undefined;
}

function renderOption<V extends string>(o: SimpleSelectOption<V>) {
  return (
    <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
      {o.description ? (
        <span className="flex flex-col">
          <span>{o.label}</span>
          <span className="text-xs text-muted-foreground">{o.description}</span>
        </span>
      ) : (
        o.label
      )}
    </SelectItem>
  );
}

export function SimpleSelect<V extends string = string>({
  value,
  onChange,
  options,
  placeholder,
  size = "md",
  disabled,
  ariaLabel,
  className,
}: SimpleSelectProps<V>) {
  const grouped = options.length > 0 && isGroup(options[0]);
  return (
    <Select
      value={value === "" ? undefined : value}
      onValueChange={(v) => onChange(v as V)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn(size === "sm" && "h-8 text-xs", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {grouped
          ? (options as SimpleSelectOptionGroup<V>[]).map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.options.map(renderOption)}
              </SelectGroup>
            ))
          : (options as SimpleSelectOption<V>[]).map(renderOption)}
      </SelectContent>
    </Select>
  );
}
