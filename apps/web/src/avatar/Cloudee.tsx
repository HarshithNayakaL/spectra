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
 * Where he drifts to, as viewport percentages. He hugs the perimeter: the
 * report is a dense reading column and a mascot parked on a paragraph is a
 * nuisance, not a personality.
 */
const WAYPOINTS = [
  { x: 91, y: 22 },
  { x: 94, y: 58 },
  { x: 88, y: 84 },
  { x: 58, y: 92 },
  { x: 14, y: 86 },
  { x: 6, y: 56 },
  { x: 8, y: 22 },
  { x: 93, y: 40 },
];

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
  const [spot, setSpot] = useState(0);
  const [lean, setLean] = useState({ x: 0, y: 0 });

  // Drift.
  useEffect(() => {
    if (reduced()) return;
    const jump = () =>
      setSpot((n) => {
        // Never repeat the same waypoint twice in a row.
        let next = n;
        while (next === n) next = Math.floor(Math.random() * WAYPOINTS.length);
        return next;
      });
    const timer = setInterval(jump, 6200);
    const first = setTimeout(jump, 1800);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
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

  const point = WAYPOINTS[spot];
  return (
    <div className="cloudeeLayer" aria-hidden={false}>
      <div
        ref={host}
        className="cloudee"
        style={
          {
            "--to-x": `${point.x}vw`,
            "--to-y": `${point.y}svh`,
            "--lean-x": `${lean.x}px`,
            "--lean-y": `${lean.y}px`,
          } as never
        }
      >
        <button
          type="button"
          className="cloudeePoke"
          onClick={onPoke}
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
