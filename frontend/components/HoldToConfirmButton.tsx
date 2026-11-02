"use client";

import { Hand, LoaderCircle } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Big press-and-hold confirmation button (used for SOS) — prevents accidental triggering
 * from a pocket tap while staying fast in a real emergency.
 *
 * Interaction:
 * - Pointer (mouse / touch / pen): press and hold for `holdMs` (default 2 s). A progress ring
 *   fills up; releasing, sliding off or cancelling the pointer before the end cancels.
 * - Keyboard: hold Space or Enter (key repeat is ignored); releasing early or Escape cancels.
 * - Accessibility alternative: "Tap to arm" → a separate "Confirm" button appears for
 *   `armTimeoutMs` (default 8 s) — two deliberate taps instead of a hold (switch access,
 *   screen readers, motor impairments).
 * - Losing focus or hiding the page cancels a hold in progress.
 *
 * Progress is announced to assistive tech through a live region; vibration feedback is used
 * where available. The decorative pulse respects `prefers-reduced-motion`.
 */

export interface HoldToConfirmButtonProps {
  /** Called once when the hold completes or the armed "Confirm" button is pressed. */
  onConfirm: () => void;
  /** Main label, e.g. "Hold to send SOS". */
  label: string;
  /** Shown while holding. */
  holdingLabel?: string;
  /** Small text under the label (e.g. "to 3 contacts"). */
  sublabel?: string;
  /** Hold duration in milliseconds (default 2000). */
  holdMs?: number;
  /** How long the two-step "armed" state lasts before it cancels itself (default 8000). */
  armTimeoutMs?: number;
  /** Label of the armed confirm button. */
  confirmLabel?: string;
  /** Label of the "arm" link-style button. */
  armLabel?: string;
  disabled?: boolean;
  /** Shows a spinner and blocks interaction (e.g. while the request is in flight). */
  busy?: boolean;
  busyLabel?: string;
  /** Icon inside the button (defaults to a hand). */
  icon?: React.ReactNode;
  /** Explains how to use the control; rendered below the button and linked via aria-describedby. */
  hint?: string;
  className?: string;
}

type HoldSource = "pointer" | "keyboard";

const RING_RADIUS = 46;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // Vibration is best-effort (blocked in iframes / unsupported on iOS).
  }
}

function isActivationKey(key: string): boolean {
  return key === " " || key === "Spacebar" || key === "Enter";
}

export function HoldToConfirmButton({
  onConfirm,
  label,
  holdingLabel = "Keep holding…",
  sublabel,
  holdMs = 2000,
  armTimeoutMs = 8000,
  confirmLabel = "Confirm — send now",
  armLabel = "Can't press and hold? Tap here to arm instead",
  disabled = false,
  busy = false,
  busyLabel = "Sending…",
  icon,
  hint,
  className,
}: HoldToConfirmButtonProps) {
  const hintId = React.useId();
  const blocked = disabled || busy;
  const seconds = Math.round(holdMs / 100) / 10;
  const hintText =
    hint ?? `Press and hold for ${seconds} seconds (or hold Space / Enter) until the ring is full.`;

  const [holding, setHolding] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [armed, setArmed] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");

  const sourceRef = React.useRef<HoldSource | null>(null);
  const startedAtRef = React.useRef(0);
  const completeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmButtonRef = React.useRef<HTMLButtonElement>(null);
  // Latest callback without re-creating handlers on every render.
  const onConfirmRef = React.useRef(onConfirm);
  React.useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  const stopAnimation = React.useCallback(() => {
    if (frameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = null;
    if (intervalRef.current !== null) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  const clearHoldTimers = React.useCallback(() => {
    if (completeTimerRef.current !== null) clearTimeout(completeTimerRef.current);
    completeTimerRef.current = null;
    stopAnimation();
  }, [stopAnimation]);

  const clearArmTimer = React.useCallback(() => {
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
  }, []);

  // Clean up everything on unmount.
  React.useEffect(
    () => () => {
      clearHoldTimers();
      clearArmTimer();
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    },
    [clearHoldTimers, clearArmTimer],
  );

  const complete = React.useCallback(() => {
    clearHoldTimers();
    sourceRef.current = null;
    setHolding(false);
    setProgress(1);
    setAnnouncement("Confirmed.");
    vibrate([120, 60, 120]);
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setProgress(0), 600);
    onConfirmRef.current();
  }, [clearHoldTimers]);

  const start = React.useCallback(
    (source: HoldSource) => {
      if (blocked || sourceRef.current) return;
      sourceRef.current = source;
      startedAtRef.current = Date.now();
      setHolding(true);
      setProgress(0);
      setAnnouncement(`${holdingLabel} ${seconds} seconds.`);
      vibrate(30);

      completeTimerRef.current = setTimeout(complete, holdMs);

      const tick = () => {
        const elapsed = Date.now() - startedAtRef.current;
        setProgress(Math.min(1, elapsed / holdMs));
      };
      if (typeof requestAnimationFrame === "function") {
        const loop = () => {
          tick();
          frameRef.current = requestAnimationFrame(loop);
        };
        frameRef.current = requestAnimationFrame(loop);
      } else {
        intervalRef.current = setInterval(tick, 50);
      }
    },
    [blocked, complete, holdMs, holdingLabel, seconds],
  );

  const cancel = React.useCallback(
    (source?: HoldSource) => {
      if (!sourceRef.current || (source && sourceRef.current !== source)) return;
      const elapsed = Date.now() - startedAtRef.current;
      clearHoldTimers();
      sourceRef.current = null;
      setHolding(false);
      setProgress(0);
      setAnnouncement(
        elapsed < 400
          ? `Press and hold for ${seconds} seconds to confirm.`
          : "Released too early — nothing was sent.",
      );
    },
    [clearHoldTimers, seconds],
  );

  // A hold must never survive the page being hidden (app switch, screen lock).
  React.useEffect(() => {
    if (!holding) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [holding, cancel]);

  // Becoming disabled/busy cancels any interaction in progress.
  React.useEffect(() => {
    if (!blocked) return;
    cancel();
    clearArmTimer();
    setArmed(false);
  }, [blocked, cancel, clearArmTimer]);

  // ---- two-step alternative -------------------------------------------------------------

  const disarm = React.useCallback(
    (message = "Cancelled.") => {
      clearArmTimer();
      setArmed(false);
      setAnnouncement(message);
    },
    [clearArmTimer],
  );

  const arm = () => {
    if (blocked) return;
    clearArmTimer();
    setArmed(true);
    const secondsToConfirm = Math.round(armTimeoutMs / 1000);
    setAnnouncement(`Armed. Press “${confirmLabel}” within ${secondsToConfirm} seconds.`);
    armTimerRef.current = setTimeout(() => disarm("Timed out — nothing was sent."), armTimeoutMs);
  };

  React.useEffect(() => {
    if (armed) confirmButtonRef.current?.focus();
  }, [armed]);

  const confirmArmed = () => {
    if (blocked || !armed) return;
    clearArmTimer();
    setArmed(false);
    setAnnouncement("Confirmed.");
    vibrate([120, 60, 120]);
    onConfirmRef.current();
  };

  // ---- event handlers -------------------------------------------------------------------

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    // Primary button / touch / pen contact only.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    start("pointer");
  };
  const onPointerEnd = () => cancel("pointer");

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      cancel();
      return;
    }
    if (!isActivationKey(event.key)) return;
    // Stop the native "click on Enter/Space" and page scrolling on Space.
    event.preventDefault();
    if (event.repeat) return;
    start("keyboard");
  };
  const onKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isActivationKey(event.key)) return;
    event.preventDefault();
    cancel("keyboard");
  };

  const dashOffset = RING_CIRCUMFERENCE * (1 - progress);
  const mainLabel = busy ? busyLabel : holding ? holdingLabel : label;

  return (
    <div data-slot="hold-to-confirm" className={cn("flex flex-col items-center gap-4", className)}>
      <div className="relative size-56 sm:size-64">
        {/* Decorative pulse (idle only, disabled for reduced motion). */}
        {!blocked && !holding && (
          <span
            aria-hidden="true"
            className="absolute inset-[9%] rounded-full bg-red-500/25 motion-safe:animate-ping"
          />
        )}
        <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
          <circle cx="50" cy="50" r={RING_RADIUS} fill="none" strokeWidth="5" className="stroke-white/10" />
          <circle
            data-testid="hold-progress"
            data-progress={progress.toFixed(2)}
            cx="50"
            cy="50"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            className={cn("stroke-white", progress === 0 && "opacity-0")}
          />
        </svg>
        <button
          type="button"
          disabled={blocked}
          aria-describedby={hintId}
          aria-busy={busy || undefined}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerEnd}
          onPointerLeave={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => cancel()}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            "absolute inset-[9%] flex touch-none flex-col items-center justify-center gap-2 rounded-full px-6 text-center font-extrabold tracking-wide text-white select-none [-webkit-touch-callout:none]",
            "bg-gradient-to-br from-red-500 to-red-700 shadow-2xl shadow-red-900/60 ring-4 ring-red-400/30",
            "transition-transform duration-150 motion-reduce:transition-none",
            "focus-visible:ring-4 focus-visible:ring-white focus-visible:outline-none",
            holding && "scale-95 from-red-600 to-red-800",
            blocked && "cursor-not-allowed from-red-900 to-red-950 text-red-200/80 shadow-none",
          )}
        >
          <span aria-hidden="true" className="[&>svg]:size-10 sm:[&>svg]:size-12">
            {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : (icon ?? <Hand />)}
          </span>
          <span className="text-xl leading-tight sm:text-2xl">{mainLabel}</span>
          {sublabel && !busy && <span className="text-xs font-medium text-red-100/90 sm:text-sm">{sublabel}</span>}
        </button>
      </div>

      <p id={hintId} className="max-w-xs text-center text-sm text-slate-300">
        {hintText}
      </p>

      {armed ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={confirmArmed}
            disabled={blocked}
            className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-base font-bold text-white shadow-lg shadow-red-900/40 transition-colors hover:bg-red-500 focus-visible:ring-4 focus-visible:ring-white focus-visible:outline-none"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={() => disarm()}
            className="rounded-xl border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={arm}
          disabled={blocked}
          className="rounded-lg px-2 py-1 text-sm font-medium text-slate-300 underline decoration-slate-500 underline-offset-4 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {armLabel}
        </button>
      )}

      <p aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

export default HoldToConfirmButton;
