/**
 * Full-screen black fade between the world loading UI and the running game.
 * The overlay is a direct child of #app with class {@link GAME_ENTRY_FADE_CLASS}
 * so it stays visible while `stratum-game-loading` hides other nodes.
 */
export const GAME_ENTRY_FADE_CLASS = "stratum-game-entry-fade";

const FADE_IN_MS = 400;
const FADE_OUT_MS = 520;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function waitTransitionEnd(el: HTMLElement, nominalMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(done, nominalMs + 100);
    el.addEventListener("transitionend", done, { once: true });
  });
}

/**
 * Fade mount to black, run `duringBlack` (tear down loading, start game), then fade to clear.
 */
export async function runGameEntryBlackTransition(
  mount: HTMLElement,
  duringBlack: () => void | Promise<void>,
): Promise<void> {
  const reduce = prefersReducedMotion();
  const inMs = reduce ? 0 : FADE_IN_MS;
  const outMs = reduce ? 0 : FADE_OUT_MS;

  const el = document.createElement("div");
  el.className = GAME_ENTRY_FADE_CLASS;
  el.setAttribute("aria-hidden", "true");
  mount.appendChild(el);

  try {
    el.style.opacity = "0";
    void el.offsetHeight;

    if (inMs > 0) {
      el.style.transition = `opacity ${inMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
    } else {
      el.style.transition = "none";
    }
    el.style.opacity = "1";

    if (inMs > 0) {
      await waitTransitionEnd(el, inMs);
    }

    await Promise.resolve(duringBlack());

    if (outMs > 0) {
      el.style.transition = `opacity ${outMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    } else {
      el.style.transition = "none";
    }
    el.style.opacity = "0";

    if (outMs > 0) {
      await waitTransitionEnd(el, outMs);
    }
  } finally {
    el.remove();
  }
}
