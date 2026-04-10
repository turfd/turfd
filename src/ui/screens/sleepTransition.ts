/**
 * Full-screen low-opacity fade for bed sleep transitions.
 */
export const SLEEP_FADE_CLASS = "stratum-sleep-fade";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function waitTransitionEnd(el: HTMLElement, nominalMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(done, nominalMs + 120);
    el.addEventListener("transitionend", done, { once: true });
  });
}

/**
 * Fade to a dim black, run `duringDim`, then fade to clear.
 */
export async function runSleepTransition(
  mount: HTMLElement,
  duringDim: () => void | Promise<void>,
  opts?: {
    inMs?: number;
    holdMs?: number;
    outMs?: number;
    /** 0..1 */
    dimOpacity?: number;
  },
): Promise<void> {
  const reduce = prefersReducedMotion();
  const inMs = reduce ? 0 : (opts?.inMs ?? 260);
  const outMs = reduce ? 0 : (opts?.outMs ?? 320);
  const holdMs = reduce ? 0 : (opts?.holdMs ?? 160);
  const dimOpacity = Math.min(1, Math.max(0, opts?.dimOpacity ?? 0.6));

  const el = document.createElement("div");
  el.className = SLEEP_FADE_CLASS;
  el.setAttribute("aria-hidden", "true");
  mount.appendChild(el);

  try {
    el.style.opacity = "0";
    void el.offsetHeight;

    el.style.transition =
      inMs > 0 ? `opacity ${inMs}ms cubic-bezier(0.4, 0, 0.2, 1)` : "none";
    el.style.opacity = String(dimOpacity);
    if (inMs > 0) {
      await waitTransitionEnd(el, inMs);
    }

    await Promise.resolve(duringDim());
    if (holdMs > 0) {
      await new Promise((r) => window.setTimeout(r, holdMs));
    }

    el.style.transition =
      outMs > 0 ? `opacity ${outMs}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";
    el.style.opacity = "0";
    if (outMs > 0) {
      await waitTransitionEnd(el, outMs);
    }
  } finally {
    el.remove();
  }
}

