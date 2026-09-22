import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
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
 *
 * The list is portalled to the body and placed against the button. Every card
 * on this site is its own stacking context, so a list rendered inside one is
 * painted under the next card whatever its z-index; outside all of them it
 * cannot be covered or clipped.
 */
/** The list's own tallest; below that it scrolls. */
const LIST_MAX = 320;

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
  const [place, setPlace] = useState<CSSProperties | null>(null);
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

  // Placed before paint, and again whenever the page under it moves, so the
  // list stays attached to its button through a scroll or a resize.
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 6;
      const edge = 12;
      const below = window.innerHeight - rect.bottom - gap - edge;
      const above = rect.top - gap - edge;
      const want = Math.min(LIST_MAX, list.current?.scrollHeight ?? LIST_MAX);
      // Open downward unless the list fits better above.
      const up = below < want && above > below;
      const room = Math.max(120, up ? above : below);
      setPlace({
        position: "fixed",
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(LIST_MAX, room),
        ...(up
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
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
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
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
        {open &&
          createPortal(
            <ul
              className="pickerList"
              style={place ?? { position: "fixed", visibility: "hidden" }}
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
                      <span className="pickerOptionMeta mono">
                        {option.meta}
                      </span>
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
            </ul>,
            document.body,
          )}
      </div>
    </div>
  );
}
