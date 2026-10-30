import React from "react";
import { createPortal } from "react-dom";
import "./model-choice-picker.css";

export interface ModelChoice {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
  description?: string;
}

/** A bounded, searchable list stays scrollable above the composer and phone keyboard. */
export function ModelChoicePicker({
  label,
  value,
  choices,
  placeholder = "选择模型连接",
  disabled,
  className = "",
  triggerRef,
  status,
  onChange,
}: {
  label: string;
  value: string;
  choices: ModelChoice[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
  status?: string;
  onChange(value: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(80);
  const [active, setActive] = React.useState(value);
  const [viewport, setViewport] = React.useState<{ top: number; height: number }>();
  const trigger = React.useRef<HTMLButtonElement>(null);
  const assignTrigger = React.useCallback(
    (node: HTMLButtonElement | null) => {
      trigger.current = node;
      if (typeof triggerRef === "function") triggerRef(node);
      else if (triggerRef) triggerRef.current = node;
    },
    [triggerRef],
  );
  const dialog = React.useRef<HTMLDialogElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const selected = choices.find((choice) => choice.value === value);
  const filtered = choices.filter((choice) =>
    `${choice.label} ${choice.group ?? ""} ${choice.value}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const visible = filtered.slice(0, visibleCount);
  // Keep a selected saved item reachable without mounting an entire catalog.
  const selectedOutside = filtered.find(
    (choice) => choice.value === value && !visible.includes(choice),
  );
  if (selectedOutside) visible.unshift(selectedOutside);
  const focusValue = visible.some((choice) => choice.value === active && !choice.disabled)
    ? active
    : visible.find((choice) => !choice.disabled)?.value;

  React.useLayoutEffect(() => {
    if (!open) return;
    const node = dialog.current!;
    node.showModal();
    const current = list.current?.querySelector<HTMLButtonElement>('[tabindex="0"]');
    current?.focus({ preventScroll: true });
    current?.scrollIntoView({ block: "nearest" });
    // visualViewport also follows the software keyboard on browsers whose dvh
    // still describes the layout viewport while an input has focus.
    const visual = window.visualViewport;
    const update = () =>
      setViewport({ top: visual?.offsetTop ?? 0, height: visual?.height ?? window.innerHeight });
    update();
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    return () => {
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      node.close();
      if (trigger.current?.isConnected && !trigger.current.disabled)
        trigger.current.focus({ preventScroll: true });
    };
  }, [open]);
  React.useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function move(event: React.KeyboardEvent<HTMLDivElement>) {
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]"),
    ].filter((node) => !node.disabled);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(index + 1, options.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    options[next]?.focus();
  }

  return (
    <>
      <button
        ref={assignTrigger}
        type="button"
        className={`model-choice-trigger ${className}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={selected?.label ?? placeholder}
        disabled={disabled}
        value={value}
        onClick={() => {
          setQuery("");
          setVisibleCount(80);
          setActive(value);
          setOpen(true);
        }}
      >
        <span>{selected?.label ?? placeholder}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            id={id}
            className="model-choice-dialog"
            aria-labelledby={`${id}-title`}
            style={
              viewport
                ? ({
                    "--picker-viewport-top": `${viewport.top}px`,
                    "--picker-viewport-height": `${viewport.height}px`,
                  } as React.CSSProperties)
                : undefined
            }
            onCancel={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
            onClose={(event) => {
              if (!event.currentTarget.open) setOpen(false);
            }}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
              )
                setOpen(false);
            }}
          >
            <div className="model-choice-head">
              <h2 id={`${id}-title`}>{label}</h2>
              <button type="button" aria-label="关闭模型选择" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <input
              className="model-choice-search"
              type="search"
              aria-label="搜索模型"
              placeholder="搜索模型或运行时"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(80);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                } else if (event.key === "Enter") event.preventDefault();
              }}
            />
            <div
              ref={list}
              className="model-choice-list"
              role="listbox"
              aria-label={label}
              onKeyDown={move}
            >
              {visible.map((choice, index) => (
                <React.Fragment key={choice.value}>
                  {choice.group && choice.group !== visible[index - 1]?.group && (
                    <div className="model-choice-group" role="presentation">
                      {choice.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === choice.value}
                    tabIndex={choice.value === focusValue ? 0 : -1}
                    disabled={choice.disabled || disabled}
                    value={choice.value}
                    onFocus={() => setActive(choice.value)}
                    onClick={() => {
                      if (disabled || choice.disabled) return;
                      setOpen(false);
                      if (choice.value !== value) onChange(choice.value);
                    }}
                  >
                    <span>
                      {choice.label}
                      {choice.description ? (
                        <small className="model-choice-description">{choice.description}</small>
                      ) : null}
                    </span>
                    <span className="model-choice-check" aria-hidden="true">
                      {value === choice.value ? "✓" : ""}
                    </span>
                  </button>
                </React.Fragment>
              ))}
              {filtered.length > visibleCount && (
                <button
                  type="button"
                  className="model-choice-more"
                  onClick={() => setVisibleCount((count) => count + 80)}
                >
                  显示更多模型（还有 {filtered.length - visibleCount} 项）
                </button>
              )}
              {!filtered.length && (
                <p className="model-choice-empty" role="status">
                  没有匹配的模型
                </p>
              )}
            </div>
            {status && (
              <p className="model-choice-status" role="status">
                {status}
              </p>
            )}
          </dialog>,
          document.body,
        )}
    </>
  );
}
