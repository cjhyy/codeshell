import {
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Plain-text version used for type-ahead and search matching. Defaults to String(label) when label is a string. */
  searchText?: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectOptionGroup<V extends string = string> {
  label: string;
  options: SelectOption<V>[];
}

export type SelectItems<V extends string = string> =
  | SelectOption<V>[]
  | SelectOptionGroup<V>[];

export interface SelectProps<V extends string = string> {
  value: V | "";
  onChange: (value: V) => void;
  options: SelectItems<V>;
  placeholder?: string;
  /** Show a search box inside the popover. Recommended when options.length > 8. */
  searchable?: boolean;
  /** Custom no-match message when searchable filter yields nothing. */
  emptyLabel?: ReactNode;
  /** Show a loading row instead of options. */
  loading?: boolean;
  loadingLabel?: ReactNode;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}

interface FlatRow<V extends string> {
  kind: "option";
  option: SelectOption<V>;
  groupLabel?: string;
  /** Absolute index across the flattened list (used for arrow nav). */
  index: number;
}

interface HeaderRow {
  kind: "header";
  label: string;
}

type Row<V extends string> = FlatRow<V> | HeaderRow;

function isGrouped<V extends string>(items: SelectItems<V>): items is SelectOptionGroup<V>[] {
  return items.length > 0 && (items[0] as SelectOptionGroup<V>).options !== undefined;
}

function flatten<V extends string>(items: SelectItems<V>): Row<V>[] {
  const rows: Row<V>[] = [];
  let optionIndex = 0;
  if (isGrouped(items)) {
    for (const g of items) {
      if (g.options.length === 0) continue;
      rows.push({ kind: "header", label: g.label });
      for (const opt of g.options) {
        rows.push({ kind: "option", option: opt, groupLabel: g.label, index: optionIndex++ });
      }
    }
  } else {
    for (const opt of items) {
      rows.push({ kind: "option", option: opt, index: optionIndex++ });
    }
  }
  return rows;
}

function searchTextOf<V extends string>(opt: SelectOption<V>): string {
  if (opt.searchText != null) return opt.searchText;
  if (typeof opt.label === "string") return opt.label;
  return String(opt.value);
}

function findOptionByValue<V extends string>(
  items: SelectItems<V>,
  value: V | "",
): SelectOption<V> | undefined {
  if (value === "") return undefined;
  if (isGrouped(items)) {
    for (const g of items) {
      for (const o of g.options) if (o.value === value) return o;
    }
  } else {
    for (const o of items) if (o.value === value) return o;
  }
  return undefined;
}

export function Select<V extends string = string>(props: SelectProps<V>) {
  const {
    value,
    onChange,
    options,
    placeholder = "选择...",
    searchable = false,
    emptyLabel = "没有匹配项",
    loading = false,
    loadingLabel = "加载中…",
    disabled = false,
    size = "md",
    className,
    ariaLabel,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const filteredItems = useMemo<SelectItems<V>>(() => {
    if (!query.trim()) return options;
    const needle = query.toLowerCase();
    const match = (o: SelectOption<V>) => searchTextOf(o).toLowerCase().includes(needle);
    if (isGrouped(options)) {
      return options
        .map((g) => ({ ...g, options: g.options.filter(match) }))
        .filter((g) => g.options.length > 0);
    }
    return options.filter(match);
  }, [options, query]);

  const rows = useMemo(() => flatten(filteredItems), [filteredItems]);
  const optionRows = useMemo(() => rows.filter((r): r is FlatRow<V> => r.kind === "option"), [rows]);

  // Reset active index when popover opens or query changes.
  useEffect(() => {
    if (!open) return;
    const selectedIdx = optionRows.findIndex((r) => r.option.value === value);
    setActiveIdx(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, value, optionRows]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", handlePointer, true);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer, true);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  // Auto-focus search input on open.
  useLayoutEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  // Scroll active row into view on arrow nav.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-select-row="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  const commit = useCallback(
    (opt: SelectOption<V>) => {
      if (opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const handleTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const handlePopoverKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, optionRows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(optionRows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = optionRows[activeIdx];
      if (row) commit(row.option);
    }
  };

  const selected = findOptionByValue(options, value);
  const sizeClass = size === "sm" ? "select-trigger-sm" : "select-trigger-md";

  return (
    <div className={`select-root ${className ?? ""}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger ${sizeClass} ${open ? "is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={handleTriggerKey}
      >
        <span className={`select-value ${selected ? "" : "is-placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="select-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          className="select-popover"
          role="dialog"
          onKeyDown={handlePopoverKey}
        >
          {searchable && (
            <div className="select-search-row">
              <input
                ref={searchRef}
                className="select-search"
                value={query}
                placeholder="搜索…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <div ref={listRef} className="select-list" role="listbox">
            {loading ? (
              <div className="select-empty">{loadingLabel}</div>
            ) : optionRows.length === 0 ? (
              <div className="select-empty">{emptyLabel}</div>
            ) : (
              rows.map((row, i) =>
                row.kind === "header" ? (
                  <div key={`h-${row.label}-${i}`} className="select-group-label">
                    {row.label}
                  </div>
                ) : (
                  <SelectRow
                    key={`o-${row.option.value}`}
                    row={row}
                    selected={row.option.value === value}
                    active={row.index === activeIdx}
                    onHover={() => setActiveIdx(row.index)}
                    onPick={() => commit(row.option)}
                  />
                ),
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface SelectRowProps<V extends string> {
  row: FlatRow<V>;
  selected: boolean;
  active: boolean;
  onHover: () => void;
  onPick: (e: MouseEvent) => void;
}

function SelectRow<V extends string>({ row, selected, active, onHover, onPick }: SelectRowProps<V>) {
  const { option, index } = row;
  return (
    <div
      role="option"
      aria-selected={selected}
      data-select-row={index}
      className={`select-row${active ? " is-active" : ""}${selected ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!option.disabled) onPick(e);
      }}
    >
      <span className="select-row-main">
        <span className="select-row-label">{option.label}</span>
        {option.description && (
          <span className="select-row-desc">{option.description}</span>
        )}
      </span>
      {selected && <span className="select-row-check" aria-hidden="true">✓</span>}
    </div>
  );
}
