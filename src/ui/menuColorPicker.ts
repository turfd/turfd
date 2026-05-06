/**
 * In-menu color picker: squircle preset swatches + optional custom HSV panel (no native color input).
 */

const STYLES_ID = "stratum-menu-color-picker-styles";

/** Call before using `.stratum-cp-swatch` outside the modal (e.g. Skins tab). */
export function ensureMenuColorPickerStyles(): void {
  injectStyles();
}

function injectStyles(): void {
  if (document.getElementById(STYLES_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLES_ID;
  style.textContent = `
    .stratum-cp-backdrop {
      position: fixed;
      inset: 0;
      z-index: 5000;
      background: rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      animation: stratum-cp-fade-in 0.18s ease forwards;
    }
    @keyframes stratum-cp-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .stratum-cp-card {
      width: min(360px, 100%);
      max-height: min(92dvh, 620px);
      overflow: hidden;
      box-sizing: border-box;
      padding: 0;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.14));
      border-radius: var(--mm-radius-sm, 8px);
      background: var(--mm-surface-deep, #1c1c1e);
      corner-shape: squircle;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
    }
    .stratum-cp-card-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 18px 18px 8px;
      box-sizing: border-box;
    }
    .stratum-cp-title {
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), var(--mm-type-label, 12px));
      line-height: 22px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft, #aeaeb2);
      margin: 0 0 12px;
    }
    .stratum-cp-note {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(16px + var(--mm-m5-nudge, 4px)));
      color: var(--mm-ink-mid, #8e8e93);
      line-height: 28px;
      margin: 0 0 14px;
    }
    .stratum-cp-presets {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 14px;
    }
    .stratum-cp-swatch {
      width: 36px;
      height: 36px;
      padding: 0;
      border: 2px solid var(--mm-border, rgba(255,255,255,0.18));
      border-radius: var(--mm-radius-sm, 6px);
      corner-shape: squircle;
      cursor: pointer;
      box-sizing: border-box;
      flex-shrink: 0;
      transition: border-color 0.12s ease, transform 0.12s ease;
    }
    .stratum-cp-swatch:hover {
      border-color: var(--mm-ink-mid, #aeaeb2);
      transform: scale(1.04);
    }
    .stratum-cp-swatch.stratum-cp-swatch--active {
      border-color: var(--mm-accent, #6ec6ff);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.5) inset;
    }
    .stratum-cp-swatch.stratum-cp-swatch--compact {
      width: 30px;
      height: 30px;
    }
    .stratum-cp-custom {
      margin-top: 4px;
      padding-top: 14px;
      border-top: 1px solid var(--mm-border, rgba(255,255,255,0.1));
    }
    .stratum-cp-custom-label {
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 11px);
      line-height: 16px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--mm-ink-soft, #aeaeb2);
      margin: 0 0 8px;
    }
    .stratum-cp-sv-wrap {
      position: relative;
      width: 100%;
      max-width: 260px;
      aspect-ratio: 1;
      border-radius: var(--mm-radius-sm, 6px);
      corner-shape: squircle;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.12));
      overflow: hidden;
      cursor: crosshair;
      touch-action: none;
    }
    /** Inline picker: JS sets explicit width/height so the gradient fills the box */
    .stratum-cp-sv-wrap.stratum-cp-sv-wrap--fit {
      aspect-ratio: auto;
      width: auto;
      max-width: 100%;
    }
    .stratum-cp-sv {
      display: block;
      width: 100%;
      height: 100%;
    }
    .stratum-cp-sv-cursor {
      position: absolute;
      width: 14px;
      height: 14px;
      margin: -7px 0 0 -7px;
      border: 2px solid #fff;
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.75);
      pointer-events: none;
    }
    .stratum-cp-hue-wrap {
      position: relative;
      margin-top: 10px;
      max-width: 260px;
      height: 22px;
      border-radius: var(--mm-radius-sm, 6px);
      corner-shape: squircle;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.12));
      overflow: hidden;
      cursor: pointer;
      touch-action: none;
    }
    .stratum-cp-hue {
      display: block;
      width: 100%;
      height: 100%;
    }
    .stratum-cp-hue-cursor {
      position: absolute;
      width: 6px;
      margin-left: -3px;
      top: 2px;
      bottom: 2px;
      border-radius: 2px;
      border: 2px solid #fff;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.8);
      pointer-events: none;
    }
    .stratum-cp-hex-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      max-width: 260px;
    }
    .stratum-cp-hex {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      padding: 10px 12px;
      background: var(--mm-surface-raised, rgba(255,255,255,0.06));
      border: 1px solid var(--mm-border, rgba(255,255,255,0.12));
      border-radius: var(--mm-radius-sm, 6px);
      color: var(--mm-ink, #f2f2f7);
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(18px + var(--mm-m5-nudge, 4px)));
      line-height: 28px;
    }
    .stratum-cp-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      flex-shrink: 0;
      margin-top: 0;
      padding: 12px 18px 18px;
      justify-content: flex-end;
      border-top: 1px solid var(--mm-border, rgba(255,255,255,0.08));
      box-sizing: border-box;
      background: var(--mm-surface-deep, #1c1c1e);
    }
    .stratum-cp-inline {
      margin-top: 10px;
      padding: 12px 14px;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.12));
      border-radius: var(--mm-radius-sm, 6px);
      background: var(--mm-surface-deep, rgba(0,0,0,0.25));
      corner-shape: squircle;
    }
    .stratum-cp-inline .stratum-cp-hex-row {
      max-width: 100%;
    }
    .stratum-cp-inline .stratum-cp-hex {
      min-width: 0;
    }
  `;
  document.head.appendChild(style);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m === null) {
    return null;
  }
  const n = Number.parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number): string =>
    Math.round(clamp01(v / 255) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rn) {
      h = 60 * (((gn - bn) / d) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / d + 2);
    } else {
      h = 60 * ((rn - gn) / d + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }
  const s = max > 1e-6 ? d / max : 0;
  const v = max;
  return { h, s, v };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) {
    rp = c;
    gp = x;
  } else if (h < 120) {
    rp = x;
    gp = c;
  } else if (h < 180) {
    gp = c;
    bp = x;
  } else if (h < 240) {
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

export type ColorPickerDialogOptions = {
  title: string;
  emptyMessage?: string;
  presetHexes: readonly string[];
  customAllowed: boolean;
  initialHex: string;
  onPick: (hex: string) => void;
};

/**
 * Modal color picker. Presets are squircle buttons; optional HSV slab when customAllowed.
 */
export function openColorPickerDialog(opts: ColorPickerDialogOptions): void {
  injectStyles();
  const backdrop = document.createElement("div");
  backdrop.className = "stratum-cp-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", opts.title);

  const card = document.createElement("div");
  card.className = "stratum-cp-card";
  const cardBody = document.createElement("div");
  cardBody.className = "stratum-cp-card-body";

  const titleEl = document.createElement("p");
  titleEl.className = "stratum-cp-title";
  titleEl.textContent = opts.title;
  cardBody.appendChild(titleEl);

  let currentHex = opts.initialHex;
  const rgbInit = hexToRgb(currentHex);
  let hsv =
    rgbInit !== null ? rgbToHsv(rgbInit.r, rgbInit.g, rgbInit.b) : { h: 0, s: 1, v: 1 };

  let unregisterResize: (() => void) | null = null;
  const close = (): void => {
    unregisterResize?.();
    unregisterResize = null;
    backdrop.remove();
    window.removeEventListener("keydown", onKey);
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      close();
    }
  };
  window.addEventListener("keydown", onKey);

  if (opts.presetHexes.length === 0) {
    const note = document.createElement("p");
    note.className = "stratum-cp-note";
    note.textContent =
      opts.emptyMessage ??
      "Name colors are a donor perk. Link Discord from this screen after you have the role.";
    cardBody.appendChild(note);
  } else {
    const presets = document.createElement("div");
    presets.className = "stratum-cp-presets";
    const activeLower = currentHex.toLowerCase();
    for (const hex of opts.presetHexes) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "stratum-cp-swatch";
      sw.style.backgroundColor = hex;
      sw.setAttribute("data-hex", hex);
      sw.title = hex;
      if (hex.toLowerCase() === activeLower) {
        sw.classList.add("stratum-cp-swatch--active");
      }
      sw.addEventListener("click", () => {
        currentHex = hex;
        const rgb = hexToRgb(hex);
        if (rgb !== null) {
          hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
          redrawCustomFromHsv();
        }
        opts.onPick(hex);
        updatePresetActiveRing();
      });
      presets.appendChild(sw);
    }
    cardBody.appendChild(presets);
  }

  let svCanvas: HTMLCanvasElement | null = null;
  let hueCanvas: HTMLCanvasElement | null = null;
  let svCursor: HTMLDivElement | null = null;
  let hueCursor: HTMLDivElement | null = null;
  let hexInput: HTMLInputElement | null = null;

  function redrawHueStrip(): void {
    if (hueCanvas === null) {
      return;
    }
    const w = hueCanvas.width;
    const h = hueCanvas.height;
    const ctx = hueCanvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    for (let x = 0; x < w; x++) {
      const hue = (x / Math.max(1, w - 1)) * 360;
      const { r, g, b } = hsvToRgb(hue, 1, 1);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, 0, 1, h);
    }
  }

  function redrawSvField(): void {
    if (svCanvas === null) {
      return;
    }
    const w = svCanvas.width;
    const h = svCanvas.height;
    const ctx = svCanvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const img = ctx.createImageData(w, h);
    const hh = hsv.h;
    for (let y = 0; y < h; y++) {
      const v = 1 - y / Math.max(1, h - 1);
      for (let x = 0; x < w; x++) {
        const s = x / Math.max(1, w - 1);
        const { r, g, b } = hsvToRgb(hh, s, v);
        const i = (y * w + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function syncCursors(): void {
    if (svCursor !== null && svCanvas !== null) {
      const w = svCanvas.clientWidth;
      const h = svCanvas.clientHeight;
      svCursor.style.left = `${hsv.s * w}px`;
      svCursor.style.top = `${(1 - hsv.v) * h}px`;
    }
    if (hueCursor !== null && hueCanvas !== null) {
      const w = hueCanvas.clientWidth;
      hueCursor.style.left = `${(hsv.h / 360) * w}px`;
    }
  }

  function updatePresetActiveRing(): void {
    const low = currentHex.toLowerCase();
    for (const sw of card.querySelectorAll(".stratum-cp-swatch")) {
      const btn = sw as HTMLButtonElement;
      const hx = btn.getAttribute("data-hex");
      if (hx !== null && hx.toLowerCase() === low) {
        btn.classList.add("stratum-cp-swatch--active");
      } else {
        btn.classList.remove("stratum-cp-swatch--active");
      }
    }
  }

  function applyHsvToHex(): void {
    const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
    currentHex = rgbToHex(r, g, b);
    if (hexInput !== null) {
      hexInput.value = currentHex;
    }
    opts.onPick(currentHex);
    updatePresetActiveRing();
  }

  function redrawCustomFromHsv(): void {
    if (svCanvas !== null) {
      redrawSvField();
    }
    if (hueCanvas !== null) {
      redrawHueStrip();
    }
    syncCursors();
    const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
    currentHex = rgbToHex(r, g, b);
    if (hexInput !== null) {
      hexInput.value = currentHex;
    }
    updatePresetActiveRing();
  }

  if (opts.customAllowed) {
    const customWrap = document.createElement("div");
    customWrap.className = "stratum-cp-custom";
    const lbl = document.createElement("p");
    lbl.className = "stratum-cp-custom-label";
    lbl.textContent = "Custom";
    customWrap.appendChild(lbl);

    const svWrap = document.createElement("div");
    svWrap.className = "stratum-cp-sv-wrap";
    svCanvas = document.createElement("canvas");
    svCanvas.className = "stratum-cp-sv";
    svCursor = document.createElement("div");
    svCursor.className = "stratum-cp-sv-cursor";
    svWrap.appendChild(svCanvas);
    svWrap.appendChild(svCursor);

    const resizeSv = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = svWrap.getBoundingClientRect();
      const side = Math.max(120, Math.floor(Math.min(rect.width, 260)));
      svCanvas!.width = Math.floor(side * dpr);
      svCanvas!.height = Math.floor(side * dpr);
      svCanvas!.style.width = `${side}px`;
      svCanvas!.style.height = `${side}px`;
      redrawSvField();
      syncCursors();
    };

    const pickSv = (clientX: number, clientY: number): void => {
      const r = svWrap.getBoundingClientRect();
      const x = clamp01((clientX - r.left) / r.width);
      const y = clamp01((clientY - r.top) / r.height);
      hsv.s = x;
      hsv.v = 1 - y;
      applyHsvToHex();
      redrawSvField();
      syncCursors();
    };

    let svDrag = false;
    svWrap.addEventListener("pointerdown", (e) => {
      svWrap.setPointerCapture(e.pointerId);
      svDrag = true;
      pickSv(e.clientX, e.clientY);
    });
    svWrap.addEventListener("pointermove", (e) => {
      if (!svDrag) {
        return;
      }
      pickSv(e.clientX, e.clientY);
    });
    svWrap.addEventListener("pointerup", () => {
      svDrag = false;
    });
    svWrap.addEventListener("pointercancel", () => {
      svDrag = false;
    });

    const hueWrap = document.createElement("div");
    hueWrap.className = "stratum-cp-hue-wrap";
    hueWrap.style.position = "relative";
    hueCanvas = document.createElement("canvas");
    hueCanvas.className = "stratum-cp-hue";
    hueCursor = document.createElement("div");
    hueCursor.className = "stratum-cp-hue-cursor";
    hueWrap.appendChild(hueCanvas);
    hueWrap.appendChild(hueCursor);

    const resizeHue = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = hueWrap.getBoundingClientRect();
      const w = Math.max(160, Math.floor(rect.width));
      hueCanvas!.width = Math.floor(w * dpr);
      hueCanvas!.height = Math.floor(22 * dpr);
      hueCanvas!.style.height = "22px";
      redrawHueStrip();
      syncCursors();
    };

    const pickHue = (clientX: number): void => {
      const r = hueWrap.getBoundingClientRect();
      hsv.h = clamp01((clientX - r.left) / r.width) * 360;
      redrawSvField();
      syncCursors();
      applyHsvToHex();
    };

    let hueDrag = false;
    hueWrap.addEventListener("pointerdown", (e) => {
      hueWrap.setPointerCapture(e.pointerId);
      hueDrag = true;
      pickHue(e.clientX);
    });
    hueWrap.addEventListener("pointermove", (e) => {
      if (!hueDrag) {
        return;
      }
      pickHue(e.clientX);
    });
    hueWrap.addEventListener("pointerup", () => {
      hueDrag = false;
    });
    hueWrap.addEventListener("pointercancel", () => {
      hueDrag = false;
    });

    const hexRow = document.createElement("div");
    hexRow.className = "stratum-cp-hex-row";
    hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "stratum-cp-hex";
    hexInput.spellcheck = false;
    hexInput.autocomplete = "off";
    hexInput.value = currentHex;
    hexInput.addEventListener("input", () => {
      const parsed = hexToRgb(hexInput!.value.startsWith("#") ? hexInput!.value : `#${hexInput!.value}`);
      if (parsed !== null) {
        hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
        currentHex = rgbToHex(parsed.r, parsed.g, parsed.b);
        hexInput!.value = currentHex;
        redrawCustomFromHsv();
        opts.onPick(currentHex);
      }
    });
    hexRow.appendChild(hexInput);

    customWrap.appendChild(svWrap);
    customWrap.appendChild(hueWrap);
    customWrap.appendChild(hexRow);
    cardBody.appendChild(customWrap);

    requestAnimationFrame(() => {
      resizeSv();
      resizeHue();
    });
    window.addEventListener("resize", resizeSv);
    window.addEventListener("resize", resizeHue);
    unregisterResize = (): void => {
      window.removeEventListener("resize", resizeSv);
      window.removeEventListener("resize", resizeHue);
    };
  }

  const actions = document.createElement("div");
  actions.className = "stratum-cp-actions";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "mm-btn mm-btn-subtle";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", close);
  actions.appendChild(doneBtn);
  card.appendChild(cardBody);
  card.appendChild(actions);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      close();
    }
  });
  card.addEventListener("click", (e) => e.stopPropagation());

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

export type InlineCustomColorPickerOptions = {
  initialHex: string;
  onChange: (hex: string) => void;
  /** Cap SV square side (CSS px) for narrow columns (e.g. Skins preview rail). */
  maxSvSidePx?: number;
  /** Hue strip height in CSS pixels (default 22). */
  hueStripCssPx?: number;
};

/**
 * Inline HSV + hex field for embedding under squircle presets (e.g. Skins outline).
 */
export function mountInlineCustomColorPicker(
  host: HTMLElement,
  opts: InlineCustomColorPickerOptions,
): () => void {
  injectStyles();
  host.replaceChildren();
  host.classList.add("stratum-cp-inline");

  let hsv = (() => {
    const rgb = hexToRgb(opts.initialHex);
    if (rgb === null) {
      return { h: 200, s: 0.85, v: 0.95 };
    }
    return rgbToHsv(rgb.r, rgb.g, rgb.b);
  })();

  const lbl = document.createElement("p");
  lbl.className = "stratum-cp-custom-label";
  lbl.textContent = "Custom color";
  host.appendChild(lbl);

  const svWrap = document.createElement("div");
  svWrap.className = "stratum-cp-sv-wrap stratum-cp-sv-wrap--fit";
  const svCanvas = document.createElement("canvas");
  svCanvas.className = "stratum-cp-sv";
  const svCursor = document.createElement("div");
  svCursor.className = "stratum-cp-sv-cursor";
  svWrap.appendChild(svCanvas);
  svWrap.appendChild(svCursor);

  const hueWrap = document.createElement("div");
  hueWrap.className = "stratum-cp-hue-wrap";
  hueWrap.style.position = "relative";
  const hueCanvas = document.createElement("canvas");
  hueCanvas.className = "stratum-cp-hue";
  const hueCursor = document.createElement("div");
  hueCursor.className = "stratum-cp-hue-cursor";
  hueWrap.appendChild(hueCanvas);
  hueWrap.appendChild(hueCursor);

  const hexRow = document.createElement("div");
  hexRow.className = "stratum-cp-hex-row";
  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "stratum-cp-hex";
  hexInput.spellcheck = false;
  hexInput.autocomplete = "off";

  function emitHex(): void {
    const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = rgbToHex(r, g, b);
    hexInput.value = hex;
    opts.onChange(hex);
  }

  function redrawHueStrip(): void {
    const w = hueCanvas.width;
    const h = hueCanvas.height;
    const ctx = hueCanvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    for (let x = 0; x < w; x++) {
      const hue = (x / Math.max(1, w - 1)) * 360;
      const { r, g, b } = hsvToRgb(hue, 1, 1);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, 0, 1, h);
    }
  }

  function redrawSvField(): void {
    const w = svCanvas.width;
    const h = svCanvas.height;
    const ctx = svCanvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const img = ctx.createImageData(w, h);
    const hh = hsv.h;
    for (let y = 0; y < h; y++) {
      const v = 1 - y / Math.max(1, h - 1);
      for (let x = 0; x < w; x++) {
        const s = x / Math.max(1, w - 1);
        const { r, g, b } = hsvToRgb(hh, s, v);
        const i = (y * w + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function syncCursors(): void {
    const w = svWrap.clientWidth;
    const h = svWrap.clientHeight;
    svCursor.style.left = `${hsv.s * w}px`;
    svCursor.style.top = `${(1 - hsv.v) * h}px`;
    const hw = hueWrap.clientWidth;
    hueCursor.style.left = `${(hsv.h / 360) * hw}px`;
  }

  const layoutInline = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cap = opts.maxSvSidePx ?? 240;
    const hostW = Math.floor(host.getBoundingClientRect().width);
    const side = Math.max(64, Math.min(cap, hostW > 0 ? hostW : cap));
    const hueH = opts.hueStripCssPx ?? 22;
    svWrap.style.width = `${side}px`;
    svWrap.style.height = `${side}px`;
    svCanvas.width = Math.floor(side * dpr);
    svCanvas.height = Math.floor(side * dpr);
    svCanvas.style.width = `${side}px`;
    svCanvas.style.height = `${side}px`;
    redrawSvField();
    hueWrap.style.width = `${side}px`;
    hueWrap.style.maxWidth = "100%";
    hueWrap.style.height = `${hueH}px`;
    hueCanvas.width = Math.floor(side * dpr);
    hueCanvas.height = Math.floor(hueH * dpr);
    hueCanvas.style.height = `${hueH}px`;
    hueCanvas.style.width = `${side}px`;
    redrawHueStrip();
    syncCursors();
  };

  const pickSv = (clientX: number, clientY: number): void => {
    const r = svWrap.getBoundingClientRect();
    hsv.s = clamp01((clientX - r.left) / r.width);
    hsv.v = 1 - clamp01((clientY - r.top) / r.height);
    redrawSvField();
    syncCursors();
    emitHex();
  };

  let svDrag = false;
  svWrap.addEventListener("pointerdown", (e) => {
    svWrap.setPointerCapture(e.pointerId);
    svDrag = true;
    pickSv(e.clientX, e.clientY);
  });
  svWrap.addEventListener("pointermove", (e) => {
    if (svDrag) {
      pickSv(e.clientX, e.clientY);
    }
  });
  svWrap.addEventListener("pointerup", () => {
    svDrag = false;
  });
  svWrap.addEventListener("pointercancel", () => {
    svDrag = false;
  });

  const pickHue = (clientX: number): void => {
    const r = hueWrap.getBoundingClientRect();
    hsv.h = clamp01((clientX - r.left) / r.width) * 360;
    redrawSvField();
    syncCursors();
    emitHex();
  };

  let hueDrag = false;
  hueWrap.addEventListener("pointerdown", (e) => {
    hueWrap.setPointerCapture(e.pointerId);
    hueDrag = true;
    pickHue(e.clientX);
  });
  hueWrap.addEventListener("pointermove", (e) => {
    if (hueDrag) {
      pickHue(e.clientX);
    }
  });
  hueWrap.addEventListener("pointerup", () => {
    hueDrag = false;
  });
  hueWrap.addEventListener("pointercancel", () => {
    hueDrag = false;
  });

  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.trim();
    const parsed = hexToRgb(raw.startsWith("#") ? raw : `#${raw}`);
    if (parsed !== null) {
      hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
      hexInput.value = rgbToHex(parsed.r, parsed.g, parsed.b);
      redrawSvField();
      redrawHueStrip();
      syncCursors();
      opts.onChange(hexInput.value);
    }
  });

  hexRow.appendChild(hexInput);
  host.appendChild(svWrap);
  host.appendChild(hueWrap);
  host.appendChild(hexRow);

  emitHex();
  requestAnimationFrame(() => {
    layoutInline();
  });
  const ro = new ResizeObserver(() => {
    layoutInline();
  });
  ro.observe(host);
  window.addEventListener("resize", layoutInline);

  return () => {
    ro.disconnect();
    window.removeEventListener("resize", layoutInline);
    host.replaceChildren();
  };
}
