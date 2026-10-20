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
  textValue?: string;
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
  icon?: React.ReactNode;
  name?: string;
  required?: boolean;
  onCloseAutoFocus?: React.ComponentPropsWithoutRef<typeof SelectContent>["onCloseAutoFocus"];
  triggerProps?: Omit<
    React.ComponentPropsWithoutRef<typeof SelectTrigger>,
    "children" | "className" | "disabled" | "aria-label" | "onChange" | "value" | "defaultValue"
  > & { [key: `data-${string}`]: string | number | boolean | undefined };
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
    <SelectItem
      key={o.value || EMPTY_SENTINEL}
      value={toRadix(o.value)}
      disabled={o.disabled}
      textValue={o.textValue ?? (typeof o.label === "string" ? o.label : undefined)}
    >
      {o.description ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span
            className="cs-select-option-label font-medium"
            title={typeof o.label === "string" ? o.label : undefined}
          >
            {o.label}
          </span>
          <span
            className="cs-select-description text-[11px] leading-4 text-muted-foreground"
            title={typeof o.description === "string" ? o.description : undefined}
          >
            {o.description}
          </span>
        </span>
      ) : (
        <span
          className="cs-select-option-label"
          title={typeof o.label === "string" ? o.label : undefined}
        >
          {o.label}
        </span>
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
  icon,
  name,
  required,
  onCloseAutoFocus,
  triggerProps,
}: SimpleSelectProps<V>) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [invalid, setInvalid] = React.useState(false);
  React.useEffect(() => setInvalid(false), [value, disabled, required]);
  const grouped = options.length > 0 && isGroup(options[0]);
  // The trigger shows only the selected option's LABEL on a single line.
  // Radix's default <SelectValue> mirrors the whole item, including descriptions.
  // Keep the trigger to its label while the dropdown retains the extra detail.
  const flatOptions: SimpleSelectOption<V>[] = grouped
    ? (options as SimpleSelectOptionGroup<V>[]).flatMap((g) => g.options)
    : (options as SimpleSelectOption<V>[]);
  // Explicit empty options remain selectable, including inside a group.
  const hasEmptyOption = flatOptions.some((o) => o.value === "");
  const radixValue = value === "" ? (hasEmptyOption ? EMPTY_SENTINEL : "") : value;
  const selectedLabel = flatOptions.find((o) => o.value === value)?.label;

  return (
    <>
      <Select
        value={radixValue}
        onValueChange={(v) => onChange(fromRadix(v) as V)}
        disabled={disabled}
      >
        <SelectTrigger
          {...triggerProps}
          ref={triggerRef}
          aria-label={ariaLabel}
          aria-required={required || triggerProps?.["aria-required"]}
          aria-invalid={invalid || triggerProps?.["aria-invalid"]}
          className={cn(size === "sm" && "h-8 text-xs", className)}
        >
          {icon && (
            <span className="shrink-0 text-muted-foreground" aria-hidden="true">
              {icon}
            </span>
          )}
          {selectedLabel !== undefined ? (
            // Render the label ourselves as a leaf span. We deliberately do NOT
            // pass children to <SelectValue>: radix uses that node as its own
            // portal container (attaches a ref), so giving it React children is
            // ambiguous and warns under React 19. When nothing is selected we
            // fall back to a childless <SelectValue> purely for its placeholder.
            <span className="pointer-events-none min-w-0 flex-1 truncate text-left">
              {selectedLabel}
            </span>
          ) : (
            <SelectValue placeholder={placeholder} />
          )}
        </SelectTrigger>
        <SelectContent onCloseAutoFocus={onCloseAutoFocus}>
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
      {/* Radix's hidden select can default to the first real option while the
          trigger is empty. A separate, visually hidden form control preserves
          actual values, empty-option validation and native form submission. */}
      {(name || required) && (
        <select
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
          name={name}
          required={required}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value as V)}
          onInvalid={(event) => {
            event.preventDefault();
            setInvalid(true);
            triggerRef.current?.focus();
          }}
        >
          {!hasEmptyOption && <option value="" />}
          {flatOptions.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.textValue ?? (typeof option.label === "string" ? option.label : option.value)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
