/** Shift–quick-move: sprite flies along a curved path; size stays fixed (no scale). */

const DST_HIDE_CLASS = "inv-shift-fly-dst-pending";
const DST_HIDE_DEPTH = "data-inv-shift-fly-pending";

const FLY_Z = 12000;
const TOTAL_MS = 320;
const FADE_IN_FR = 0.12;
const MOVE_END_FR = 0.82;
const FADE_OUT_FR = 1;

function slotIconStyle(fromSlotEl: HTMLElement): {
  bg: string;
  bgPos: string;
  bgSize: string;
} {
  const icon = fromSlotEl.querySelector(".inv-slot-icon") as HTMLElement | null;
  if (icon === null) {
    return { bg: "none", bgPos: "50% 50%", bgSize: "contain" };
  }
  const cs = getComputedStyle(icon);
  return {
    bg: cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage : "none",
    bgPos: cs.backgroundPosition || "50% 50%",
    bgSize: cs.backgroundSize || "contain",
  };
}

function quadBezier(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * x0 + 2 * u * t * x1 + t * t * x2,
    y: u * u * y0 + 2 * u * t * y1 + t * t * y2,
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function beginHideDestinationStack(toSlotEl: HTMLElement): void {
  const raw = toSlotEl.getAttribute(DST_HIDE_DEPTH);
  const n = raw === null ? 0 : Number.parseInt(raw, 10) || 0;
  toSlotEl.setAttribute(DST_HIDE_DEPTH, String(n + 1));
  toSlotEl.classList.add(DST_HIDE_CLASS);
}

function endHideDestinationStack(toSlotEl: HTMLElement | null): void {
  if (toSlotEl === null) {
    return;
  }
  const raw = toSlotEl.getAttribute(DST_HIDE_DEPTH);
  const n = raw === null ? 0 : Number.parseInt(raw, 10) || 0;
  const next = n - 1;
  if (next <= 0) {
    toSlotEl.removeAttribute(DST_HIDE_DEPTH);
    toSlotEl.classList.remove(DST_HIDE_CLASS);
  } else {
    toSlotEl.setAttribute(DST_HIDE_DEPTH, String(next));
  }
}

/** Control point bulges perpendicular to the chord (arc “lift”). */
function curveControl(
  ax: number,
  ay: number,
  tx: number,
  ty: number,
): { cx: number; cy: number } {
  const midX = (ax + tx) / 2;
  const midY = (ay + ty) / 2;
  const dx = tx - ax;
  const dy = ty - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bulge = Math.min(80, len * 0.32);
  return { cx: midX + nx * bulge, cy: midY + ny * bulge };
}

function opacityAt(globalT: number): number {
  if (globalT <= FADE_IN_FR) {
    return globalT / FADE_IN_FR;
  }
  if (globalT >= MOVE_END_FR) {
    const u = (globalT - MOVE_END_FR) / (FADE_OUT_FR - MOVE_END_FR);
    return Math.max(0, 1 - u);
  }
  return 1;
}

function positionAt(
  globalT: number,
  ax: number,
  ay: number,
  tx: number,
  ty: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  if (globalT <= FADE_IN_FR) {
    return { x: ax, y: ay };
  }
  if (globalT >= MOVE_END_FR) {
    return { x: tx, y: ty };
  }
  const span = MOVE_END_FR - FADE_IN_FR;
  const u = (globalT - FADE_IN_FR) / span;
  const t = easeInOutCubic(u);
  return quadBezier(ax, ay, cx, cy, tx, ty, t);
}

/**
 * Animates a copy of the slot icon along a quadratic curve (fixed size).
 * If `toSlotEl` is null, uses a short curved nudge + fade.
 */
export function playShiftSlotFlyAnimation(
  fromSlotEl: HTMLElement,
  toSlotEl: HTMLElement | null,
  durationMs: number = TOTAL_MS,
): void {
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  if (toSlotEl !== null && toSlotEl !== fromSlotEl) {
    beginHideDestinationStack(toSlotEl);
  }
  const from = fromSlotEl.getBoundingClientRect();
  const { bg, bgPos, bgSize } = slotIconStyle(fromSlotEl);

  const fly = document.createElement("div");
  fly.className = "inv-shift-fly";
  fly.setAttribute("aria-hidden", "true");
  const w = from.width;
  const h = from.height;
  fly.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "pointer-events:none",
    `z-index:${FLY_Z}`,
    `width:${w}px`,
    `height:${h}px`,
    "transform-origin:0 0",
    "will-change:transform,opacity",
    "image-rendering:pixelated",
    "border-radius:6px",
  ].join(";");

  const inner = document.createElement("div");
  inner.style.cssText = [
    "width:100%",
    "height:100%",
    `background-image:${bg}`,
    `background-position:${bgPos}`,
    `background-size:${bgSize}`,
    "background-repeat:no-repeat",
    "image-rendering:pixelated",
    "image-rendering:crisp-edges",
  ].join(";");
  fly.appendChild(inner);
  document.body.appendChild(fly);

  const ax = from.left;
  const ay = from.top;

  let tx = ax + 14;
  let ty = ay - 10;
  let cx: number;
  let cy: number;
  if (toSlotEl !== null) {
    const to = toSlotEl.getBoundingClientRect();
    tx = to.left + (to.width - w) / 2;
    ty = to.top + (to.height - h) / 2;
    const c = curveControl(ax, ay, tx, ty);
    cx = c.cx;
    cy = c.cy;
  } else {
    const c = curveControl(ax, ay, tx, ty);
    cx = c.cx;
    cy = c.cy;
  }

  const steps = 28;
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const globalT = i / steps;
    const { x, y } = positionAt(globalT, ax, ay, tx, ty, cx, cy);
    keyframes.push({
      offset: globalT,
      transform: `translate(${x}px,${y}px)`,
      opacity: opacityAt(globalT),
    });
  }

  fly.style.transition = "none";
  const dstForCleanup =
    toSlotEl !== null && toSlotEl !== fromSlotEl ? toSlotEl : null;
  if (typeof fly.animate !== "function") {
    fly.remove();
    endHideDestinationStack(dstForCleanup);
    return;
  }
  const anim = fly.animate(keyframes, {
    duration: durationMs,
    easing: "linear",
    fill: "forwards",
  });
  const cleanup = (): void => {
    // Reveal the real slot first while the fly is still in-tree at opacity 0, then drop the
    // overlay on the next frame so the compositor does not flash empty / double-paint.
    endHideDestinationStack(dstForCleanup);
    requestAnimationFrame(() => {
      fly.remove();
    });
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}
