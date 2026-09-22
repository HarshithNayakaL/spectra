import { useEffect, useId, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";

export type PickerOption = {
  value: string;
  label: string;
  /** A short word on the row: "Default", "Google AI Mode". */
  badge?: string;
  /** One line of detail under the label. */
  meta?: string;
};

/**
 * The model picker, and every other choice on this product.
 *
 * A native select cannot carry a badge, a second line or the product's own
 * type, and on a phone it hands the choice to the operating system. This is the
 * listbox pattern instead: one button, one list, full keyboard control, and
 * nothing on screen that the page did not draw.
 */
export function Picker({
  label,
  hint,
  value,
  options,
  onChange,
  icon,
  empty = "Nothing to choose from",
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  icon?: Parameters<typeof HugeiconsIcon>[0]["icon"];
  empty?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const selected = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const current = selected >= 0 ? options[selected] : undefined;

  // Opening always starts on the current choice, never on the first row.
  function show() {
    if (disabled || !options.length) return;
    const rect = button.current?.getBoundingClientRect();
    // 300px is the list's own maximum height; flip up only when it cannot fit.
    setAbove(
      Boolean(rect && window.innerHeight - rect.bottom < 300 && rect.top > 320),
    );
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }

  function pick(index: number) {
    const option = options[index];
    if (!option) return close();
    onChange(option.value);
    close();
  }

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
  }, [open]);

  // Keep the active row in view while the list is being walked with the keys.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target))
        setOpen(false);
    };
    // A scroll or a resize invalidates the position this list was placed at.
    const onMove = () => setOpen(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    const last = options.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) return show();
        return setActive((index) => Math.min(last, index + 1));
      case "ArrowUp":
        event.preventDefault();
        if (!open) return show();
        return setActive((index) => Math.max(0, index - 1));
      case "Home":
        if (!open) return;
        event.preventDefault();
        return setActive(0);
      case "End":
        if (!open) return;
        event.preventDefault();
        return setActive(last);
      case "PageDown":
        if (!open) return;
        event.preventDefault();
        return setActive((index) => Math.min(last, index + 5));
      case "PageUp":
        if (!open) return;
        event.preventDefault();
        return setActive((index) => Math.max(0, index - 5));
      case "Enter":
      case " ":
        event.preventDefault();
        return open ? pick(active) : show();
      case "Escape":
        if (!open) return;
        event.preventDefault();
        return close();
      case "Tab":
        // Tab keeps its meaning: the list closes and focus moves on.
        if (open) setOpen(false);
        return;
      default:
        break;
    }
    // Typeahead: "ge" jumps to the first option starting with those letters.
    if (
      event.key.length !== 1 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const now = Date.now();
    const text =
      (now - typed.current.at < 800 ? typed.current.text : "") +
      event.key.toLowerCase();
    typed.current = { text, at: now };
    const found = options.findIndex((option) =>
      option.label.toLowerCase().startsWith(text),
    );
    if (found < 0) return;
    event.preventDefault();
    if (open) setActive(found);
    else onChange(options[found].value);
  }

  return (
    <div className="fieldRow">
      <span className="fieldLabel" id={`${id}-label`}>
        {label}
        {hint && <span className="labelHint">{hint}</span>}
      </span>
      <div className={`picker ${open ? "open" : ""}`}>
        <button
          type="button"
          ref={button}
          className="pickerButton"
          disabled={disabled || !options.length}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby={`${id}-label ${id}-value`}
          onClick={() => (open ? close() : show())}
          onKeyDown={onKeyDown}
        >
          {icon && (
            <HugeiconsIcon
              icon={icon}
              size={17}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          )}
          <span className="pickerValue" id={`${id}-value`}>
            <span className="pickerValueLabel">
              {current?.label ?? (options.length ? value : empty)}
            </span>
            {current?.meta && (
              <span className="pickerValueMeta mono">{current.meta}</span>
            )}
          </span>
          {current?.badge && (
            <span className="pickerBadge">{current.badge}</span>
          )}
          <HugeiconsIcon
            className="pickerCaret"
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>
        {open && (
          <ul
            className={`pickerList ${above ? "up" : ""}`}
            role="listbox"
            ref={list}
            tabIndex={-1}
            aria-labelledby={`${id}-label`}
            aria-activedescendant={`${id}-option-${active}`}
            onKeyDown={onKeyDown}
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${id}-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                className={`pickerOption ${index === active ? "active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                <span className="pickerOptionMain">
                  <span className="pickerOptionLabel">{option.label}</span>
                  {option.meta && (
                    <span className="pickerOptionMeta mono">{option.meta}</span>
                  )}
                </span>
                {option.badge && (
                  <span className="pickerBadge">{option.badge}</span>
                )}
                <span className="pickerTick" aria-hidden="true">
                  {option.value === value ? "✓" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
