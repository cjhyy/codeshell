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
 * Drop-in adapter for the compact app-level Select API
 * (`value` / `onChange` / `options` / `placeholder` / `size` / groups /
 * per-option `description` / `disabled`) but rendered with the shadcn Select
 * underneath. `searchable` / `searchText` are accepted but ignored (shadcn
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

// radix Select forbids an empty-string item value (reserved for "cleared").
// The legacy Select allowed a `value: ""` option (e.g. "跟随当前模型（默认）").
// Map "" ↔ this sentinel internally so those options keep working unchanged.
const EMPTY_SENTINEL = "__simple_select_empty__";
const toRadix = (v: string) => (v === "" ? EMPTY_SENTINEL : v);
const fromRadix = (v: string) => (v === EMPTY_SENTINEL ? "" : v);

function renderOption<V extends string>(o: SimpleSelectOption<V>) {
  return (
    <SelectItem key={o.value || EMPTY_SENTINEL} value={toRadix(o.value)} disabled={o.disabled}>
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
  // Does the option set include an explicit "" option? If so, "" is a real
  // selectable value (→ sentinel); otherwise treat "" as "no selection".
  const hasEmptyOption = !grouped && (options as SimpleSelectOption<V>[]).some((o) => o.value === "");
  const radixValue =
    value === "" ? (hasEmptyOption ? EMPTY_SENTINEL : undefined) : value;

  // The trigger shows only the selected option's LABEL on a single line.
  // Radix's default <SelectValue> mirrors the whole selected <SelectItem> body,
  // which for description-bearing options is a two-line `flex flex-col`; inside
  // the trigger's `[&>span]:line-clamp-1` (a -webkit-box) that rendered
  // centered + clipped weirdly. Rendering just the label keeps the trigger a
  // clean single left-aligned line while the dropdown keeps the 2-line items.
  const flatOptions: SimpleSelectOption<V>[] = grouped
    ? (options as SimpleSelectOptionGroup<V>[]).flatMap((g) => g.options)
    : (options as SimpleSelectOption<V>[]);
  const selectedLabel = flatOptions.find((o) => o.value === value)?.label;

  return (
    <Select
      value={radixValue}
      onValueChange={(v) => onChange(fromRadix(v) as V)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn(size === "sm" && "h-8 text-xs", className)}>
        <SelectValue placeholder={placeholder}>{selectedLabel}</SelectValue>
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
