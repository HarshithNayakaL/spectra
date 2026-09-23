import { useEffect, useRef, useState } from "react";
import { createAvatar } from "@bible-strong/avatar-react";
import "@bible-strong/avatar-react/styles.css";
import definition from "./cloudee.avatar.json";

const CloudeeAvatar = createAvatar(definition);

export type Mood = keyof typeof definition.animations;

/** What Cloudee is doing, derived from what the page is doing. */
export type PageState = "idle" | "typing" | "running" | "done" | "error";

const MOOD_FOR: Record<PageState, Mood> = {
  idle: "idle",
  typing: "curious",
  running: "searching",
  done: "celebrate",
  error: "sad",
};

/** Cycled when someone pokes him. He is a resident, not a button. */
const POKED: Mood[] = [
  "playful",
  "laughing",
  "surprised",
  "proud",
  "shy",
  "excited",
];

/** Rotated while an audit runs, so a long wait reads as work, not a hang. */
const WORKING: Mood[] = ["searching", "thinking", "working"];

/**
 * What he must never sit on: anything that takes a tap or a keystroke, the
 * header, the phone action bar and an open drop-down. Covering one of these
 * makes the control underneath untappable, which is a bug, not a personality.
 */
const BLOCKING =
  "a, button, input, textarea, select, label, summary, [role='button'], [role='listbox'], [role='option'], .picker, .pickerList, .top, .rail, .mobileBar, .skipLink";
/** Reading matter: allowed when nothing better exists, but avoided. */
const READING = "p, h1, h2, h3, li, td, th, dd, blockquote, pre, code";

type Spot = { x: number; y: number };

/**
 * Picks the next place to drift to, measured against the page as it is now.
 * Candidates run around the whole viewport; each is scored by what lies under
 * the mascot's footprint there. Any candidate over a control is discarded;
 * among the rest, the emptiest win, and one of those is chosen at random so
 * he still wanders rather than oscillating between two spots.
 */
function pickSpot(size: number, current: Spot | null): Spot | null {
  if (typeof document === "undefined") return null;
  const view = window.visualViewport;
  const width = view?.width ?? window.innerWidth;
  const height = view?.height ?? window.innerHeight;
  const header = document.querySelector(".top")?.getBoundingClientRect();
  const bar = document.querySelector(".mobileBar")?.getBoundingClientRect();
  const half = size / 2;
  const pad = 8;
  const minY = (header ? header.bottom : 0) + half + pad;
  const maxY = (bar && bar.height ? bar.top : height) - half - pad;
  const minX = half + pad;
  const maxX = width - half - pad;
  if (maxY <= minY || maxX <= minX) return null;

  const columns = width < 640 ? 4 : 7;
  const rows = 7;
  const candidates: Array<Spot & { cost: number }> = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = minX + ((maxX - minX) * column) / (columns - 1);
      const y = minY + ((maxY - minY) * row) / (rows - 1);
      const cost = costAt(x, y, half);
      if (cost === Infinity) continue;
      // Edges read as "resting"; the middle of the screen reads as "in the way".
      const edge = Math.min(x - minX, maxX - x) / (maxX - minX || 1);
      candidates.push({ x, y, cost: cost + edge * 2 });
    }
  // Peeking in from the side edge, three-quarters off screen, overlaps only
  // the page gutter. Less charming than a full view, so it costs more; on a
  // phone report made of full-width rows it is often the only clear place.
  if (!candidates.length || width < 640)
    for (let row = 0; row < rows; row++) {
      const y = minY + ((maxY - minY) * row) / (rows - 1);
      for (const [x, probe] of [
        [width + half * 0.4, width - half * 0.3],
        [-half * 0.4, half * 0.3],
      ]) {
        // Only the sliver still on screen is measured.
        const cost = costAt(probe, y, half * 0.3);
        if (cost !== Infinity) candidates.push({ x, y, cost: cost + 6 });
      }
    }
  const fresh = candidates.filter(
    (spot) =>
      !current || Math.hypot(spot.x - current.x, spot.y - current.y) > size,
  );
  const pool = fresh.length ? fresh : candidates;
  if (!pool.length) return null;
  pool.sort((a, b) => a.cost - b.cost);
  const best = pool[0].cost;
  const near = pool.filter((spot) => spot.cost <= best + 1);
  const chosen = near[Math.floor(Math.random() * near.length)];
  return { x: chosen.x, y: chosen.y };
}

/** How far the idle bob lifts him (the bob keyframes in styles.css). */
const BOB = 14;

/**
 * Infinity when a control is under the footprint; otherwise how much text.
 * The footprint is everywhere he will be while he rests there, so it spans the
 * whole bob, not just the resting frame.
 */
function costAt(x: number, y: number, half: number) {
  let cost = 0;
  const reach = half * 0.85;
  for (const dx of [-reach, 0, reach])
    for (const dy of [-reach - BOB, -BOB / 2, reach]) {
      for (const element of document.elementsFromPoint(x + dx, y + dy)) {
        if (element.closest(".cloudeeLayer")) continue;
        if (element.closest(BLOCKING)) return Infinity;
        if (element.closest(READING)) cost += 1;
        break;
      }
    }
  return cost;
}

/** True when the footprint at this spot now covers a control. */
function blocked(spot: Spot, size: number) {
  return costAt(spot.x, spot.y, size / 2) === Infinity;
}

export function useCloudeeMood(
  state: PageState,
  progressCount: number,
  /** Used when nothing else is happening, e.g. a verdict on a finished audit. */
  resting?: Mood,
) {
  const [poked, setPoked] = useState<Mood | null>(null);
  const pokeCount = useRef(0);

  useEffect(() => {
    if (!poked) return;
    const timer = setTimeout(() => setPoked(null), 2800);
    return () => clearTimeout(timer);
  }, [poked]);

  const poke = () => {
    const next = POKED[pokeCount.current % POKED.length];
    pokeCount.current += 1;
    setPoked(next);
  };

  const mood: Mood =
    poked ??
    (state === "running"
      ? WORKING[Math.min(progressCount, WORKING.length - 1)]
      : state === "idle" && resting
        ? resting
        : MOOD_FOR[state]);

  return { mood, poke };
}

const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Cloudee floats over the whole site rather than sitting in a box: he drifts
 * between waypoints around the edges of the viewport, bobs on the way, and
 * leans toward the pointer. Only he takes clicks; the layer around him does
 * not, so he never blocks the page underneath.
 */
export function FloatingCloudee({
  mood,
  onPoke,
}: {
  mood: Mood;
  onPoke?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [lean, setLean] = useState({ x: 0, y: 0 });
  const [typing, setTyping] = useState(false);
  // True while drifting. He takes no taps in transit, so crossing a button on
  // the way somewhere never swallows the tap meant for it.
  const [moving, setMoving] = useState(false);
  // No clear spot anywhere, not even peeking from an edge: he steps away until
  // the page gives him room again.
  const [stranded, setStranded] = useState(false);
  const spotRef = useRef<Spot | null>(null);
  spotRef.current = spot;

  // Drift: every few seconds, and at once whenever the page under him moves
  // so that he now covers something. With reduced motion he still finds a
  // safe place; he just does not wander between them.
  useEffect(() => {
    const sizeOf = () => host.current?.getBoundingClientRect().width || 72;
    let arrive = 0;
    const move = () => {
      if (document.hidden) return;
      const next = pickSpot(sizeOf(), spotRef.current);
      if (!next) {
        const current = spotRef.current;
        setStranded(!current || blocked(current, sizeOf()));
        return;
      }
      setStranded(false);
      setSpot(next);
      setMoving(true);
      clearTimeout(arrive);
      // The CSS drift takes under 3.4s; he is at rest after that.
      arrive = window.setTimeout(() => setMoving(false), reduced() ? 0 : 3500);
    };
    const settle = () => {
      const current = spotRef.current;
      if (!current || blocked(current, sizeOf())) move();
    };
    // Entrance animations slide the page into place over the first second;
    // a spot measured before they finish is measured against the wrong page.
    const first = setTimeout(move, 1300);
    const timer = reduced() ? 0 : window.setInterval(move, 7000);
    // Anything can slide under him without a scroll or a DOM change: a
    // transition, a font swap, a sticky bar. A cheap check catches all of it.
    const watch = window.setInterval(settle, 1500);
    let idle = 0;
    // Scrolling slides content under him; check once it stops.
    const onScroll = () => {
      clearTimeout(idle);
      idle = window.setTimeout(settle, 180);
    };
    const onResize = () => {
      clearTimeout(idle);
      idle = window.setTimeout(move, 180);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    // A drop-down opening or a report arriving changes what is under him.
    // His own animation mutates his own markup constantly; only changes to
    // the page itself count.
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !(record.target as Element).closest?.(".cloudeeLayer") &&
            !record.target.parentElement?.closest(".cloudeeLayer"),
        )
      )
        onScroll();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      clearTimeout(first);
      clearTimeout(arrive);
      clearInterval(timer);
      clearInterval(watch);
      clearTimeout(idle);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, []);

  // While someone is typing on a phone the keyboard takes half the screen;
  // he steps out of the way entirely rather than squat on the field.
  useEffect(() => {
    const coarse = matchMedia("(pointer: coarse)");
    const update = () => {
      const active = document.activeElement;
      setTyping(
        coarse.matches &&
          !!active &&
          active.matches("input, textarea, select, [contenteditable='true']"),
      );
    };
    // Focus moves after focusout fires; read it once it has landed.
    const later = () => setTimeout(update, 0);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, []);

  // Lean toward the pointer, damped and clamped. A lean, not a chase.
  useEffect(() => {
    if (reduced() || matchMedia("(pointer: coarse)").matches) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const node = host.current;
        if (!node) return;
        const box = node.getBoundingClientRect();
        const dx = event.clientX - (box.left + box.width / 2);
        const dy = event.clientY - (box.top + box.height / 2);
        const limit = 20;
        setLean({
          x: Math.max(-limit, Math.min(limit, dx / 14)),
          y: Math.max(-limit, Math.min(limit, dy / 18)),
        });
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return (
    <div className={`cloudeeLayer ${typing || stranded ? "away" : ""}`}>
      <div
        ref={host}
        className={`cloudee ${spot ? "placed" : ""} ${moving ? "moving" : ""}`}
        data-moving={moving ? "true" : undefined}
        style={
          {
            ...(spot
              ? { "--to-x": `${spot.x}px`, "--to-y": `${spot.y}px` }
              : {}),
            "--lean-x": `${lean.x}px`,
            "--lean-y": `${lean.y}px`,
          } as never
        }
      >
        <button
          type="button"
          className="cloudeePoke"
          onClick={onPoke}
          tabIndex={typing || stranded ? -1 : 0}
          aria-label={`Say hello to Cloudee. He is currently ${mood}.`}
          title="Poke Cloudee"
        >
          <CloudeeAvatar
            animation={mood}
            size="100%"
            ariaLabel={`Cloudee, the SPECTRA mascot. Currently ${mood}.`}
          />
        </button>
        <span className="cloudeeTag">{mood.replaceAll("-", " ")}</span>
      </div>
    </div>
  );
}
