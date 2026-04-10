import { stratumCoreTextureAssetUrl } from "../../core/textureManifest";
import { unixRandom01 } from "../../core/unixRandom";

export type LoadingProgressUpdate = {
  stage: string;
  detail?: string;
  current?: number;
  total?: number;
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Shown while loading; rotate for variety. */
const LOADING_TIPS: string[] = [
  "Hold attack to break blocks—some materials take longer to chip through.",
  "Use the mouse wheel or number keys to change your hotbar slot.",
  "Press E to open your inventory and move stacks between slots.",
  "Torches brighten dark caves; place them to keep mobs and yourself safer.",
  "Your world saves when you use Save, on autosave, or when you quit to the menu.",
  "Different biomes mean different blocks—explore to find new resources.",
  "Fall damage hurts—drop carefully from high ledges.",
  "Glass lets light through but breaks easily; plan windows accordingly.",
  "Room codes are six characters—double-check before joining a friend.",
  "If loading ever feels stuck, check the stage text above for what the game is doing.",
];

const STYLE_ID = "stratum-world-loading-styles";

/** Discrete bar steps so the fill reads as chunky / pixel-style, not a smooth gradient strip. */
const BAR_PIXEL_SEGMENTS = 32;

const TIP_ROTATE_MS = 4500;
/** Smoothing factor per frame (~60fps → comfortable ramp). */
const BAR_LERP = 0.085;
/** Real load can finish fast; the bar still eases upward over ~this many ms. */
const TIME_RAMP_MS = 3800;

function injectLoadingStyles(base: string): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const fontUrl = (name: string): string => `${base}assets/fonts/${name}`;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @font-face {
      font-family: 'BoldPixels';
      src: url('${fontUrl("BoldPixels.ttf")}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    @font-face {
      font-family: 'M5x7';
      src: url('${fontUrl("m5x7.ttf")}') format('truetype');
      font-weight: normal;
      font-style: normal;
      font-display: swap;
    }

    .stratum-loading-overlay {
      --mm-m5-nudge: 4px;
      --mm-ink: #f2f2f7;
      --mm-ink-mid: #aeaeb2;
      --mm-ink-soft: #8e8e93;
      --mm-surface: rgba(44, 44, 46, 0.78);
      --mm-surface-deep: rgba(36, 36, 38, 0.9);
      --mm-border: rgba(255, 255, 255, 0.1);
      --mm-border-strong: rgba(255, 255, 255, 0.16);
      --mm-danger: #ff453a;
      --mm-radius-sm: 10px;
      --mm-radius-md: 14px;
      --mm-radius-lg: 18px;
      --mm-shell-max: min(900px, 96vw);
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      flex-direction: column;
      font-family: 'BoldPixels', 'Courier New', monospace;
      font-weight: normal;
      font-synthesis: none;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeSpeed;
      color: var(--mm-ink, #f2f2f7);
      pointer-events: none;
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 0.32s ease;
      /* Let the menu-style world backdrop read through; darken edges for contrast */
      background:
        radial-gradient(
          ellipse 120% 85% at 50% 36%,
          rgba(18, 20, 26, 0.12) 0%,
          rgba(10, 11, 14, 0.48) 52%,
          rgba(5, 6, 9, 0.82) 100%
        );
    }

    .stratum-loading-actions {
      margin-top: 1.15rem;
      display: flex;
      flex-direction: row;
      justify-content: flex-end;
    }

    .stratum-loading-btn {
      pointer-events: auto;
      font-family: 'BoldPixels', monospace;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 10px 14px;
      border-radius: var(--mm-radius-sm, 10px);
      corner-shape: squircle;
      cursor: pointer;
      border: 1px solid var(--mm-border-strong, rgba(255, 255, 255, 0.16));
      background: rgba(36, 36, 38, 0.95);
      color: var(--mm-ink, #f2f2f7);
      transition: opacity 0.12s ease, border-color 0.12s ease;
    }

    .stratum-loading-btn:hover { opacity: 0.92; }
    .stratum-loading-btn:active { opacity: 0.85; }

    .stratum-loading-overlay.stratum-loading-overlay--entered {
      opacity: 1;
    }

    .stratum-loading-inner {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: clamp(1.1rem, 4vw, 2rem);
      box-sizing: border-box;
    }

    .stratum-loading-main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }

    .stratum-loading-shell {
      width: 100%;
      max-width: var(--mm-shell-max, min(900px, 96vw));
      container-type: inline-size;
      container-name: loading-shell;
    }

    .stratum-loading-card {
      width: 100%;
      border-radius: var(--mm-radius-lg, 18px);
      corner-shape: squircle;
      border: 1px solid var(--mm-border, rgba(255, 255, 255, 0.1));
      background: linear-gradient(
        165deg,
        rgba(52, 52, 56, 0.88) 0%,
        var(--mm-surface, rgba(44, 44, 46, 0.78)) 45%,
        rgba(38, 38, 42, 0.86) 100%
      );
      padding: 1.35rem 1.55rem 1.35rem;
      box-sizing: border-box;
      backdrop-filter: blur(18px) saturate(1.15);
      -webkit-backdrop-filter: blur(18px) saturate(1.15);
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.04) inset,
        0 4px 28px rgba(0, 0, 0, 0.26),
        0 24px 64px rgba(0, 0, 0, 0.32);
      transform: translateY(12px);
      opacity: 0;
      transition:
        transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.28s ease;
    }

    .stratum-loading-overlay.stratum-loading-overlay--entered .stratum-loading-card {
      transform: translateY(0);
      opacity: 1;
    }

    .stratum-loading-card.stratum-loading-card--error {
      border-color: rgba(255, 69, 58, 0.38);
      box-shadow:
        0 4px 24px rgba(0, 0, 0, 0.22),
        0 20px 56px rgba(80, 20, 20, 0.15);
    }

    .stratum-loading-brand {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 1.05rem;
      margin-bottom: 1.15rem;
      padding-bottom: 1.05rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }

    .stratum-loading-logo {
      display: block;
      width: min(88px, 20vw);
      height: auto;
      flex-shrink: 0;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .stratum-loading-brand-text {
      flex: 1;
      min-width: 0;
      text-align: left;
    }

    .stratum-loading-kicker {
      margin: 0 0 0.2rem;
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge, 4px));
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--mm-ink-soft, #8e8e93);
    }

    .stratum-loading-title {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: clamp(20px, 4.2vw, 26px);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink, #f2f2f7);
      line-height: 1.12;
    }

    .stratum-loading-stage {
      font-family: 'BoldPixels', monospace;
      font-size: clamp(15px, 3.4vw, 17px);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-mid, #aeaeb2);
      text-align: left;
      line-height: 1.35;
    }

    .stratum-loading-detail {
      min-height: 1.35em;
      margin-top: 0.45rem;
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--mm-m5-nudge, 4px));
      line-height: 1.45;
      color: var(--mm-ink-soft, #8e8e93);
      text-align: left;
    }

    .stratum-loading-progress {
      margin-top: 1.2rem;
    }

    .stratum-loading-progress-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 0.9rem;
      min-width: 0;
    }

    .stratum-loading-track {
      flex: 1;
      min-width: 0;
      height: 10px;
      border-radius: var(--mm-radius-sm, 10px);
      border: 1px solid var(--mm-border-strong, rgba(255, 255, 255, 0.16));
      background: var(--mm-surface-deep, rgba(36, 36, 38, 0.9));
      overflow: hidden;
      box-sizing: border-box;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
    }

    .stratum-loading-fill {
      height: 100%;
      width: 0%;
      border-radius: calc(var(--mm-radius-sm, 10px) - 1px);
      transform-origin: left center;
      background: linear-gradient(
        180deg,
        rgba(168, 205, 255, 0.98) 0%,
        rgba(98, 152, 228, 0.92) 48%,
        rgba(72, 118, 198, 0.9) 100%
      );
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.28),
        0 0 12px rgba(120, 180, 255, 0.22);
      transition: width 0.1s ease-out;
    }

    .stratum-loading-percent {
      margin: 0;
      min-width: 3.25ch;
      min-height: 1.35em;
      text-align: right;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge, 4px));
      font-variant-numeric: tabular-nums;
      color: var(--mm-ink-soft, #8e8e93);
      flex-shrink: 0;
      line-height: 1.2;
    }

    .stratum-loading-stage--error {
      color: var(--mm-danger, #ff453a);
    }

    .stratum-loading-tip-panel {
      margin-top: 1.2rem;
      padding: 0.85rem 1rem;
      border-radius: var(--mm-radius-md, 14px);
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 0.85rem;
      min-width: 0;
    }

    .stratum-loading-tip-label {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: rgba(180, 200, 230, 0.95);
      text-align: center;
      flex-shrink: 0;
      padding: 0.28rem 0.55rem;
      border-radius: var(--mm-radius-sm, 10px);
      background: rgba(100, 150, 220, 0.14);
      border: 1px solid rgba(120, 170, 235, 0.22);
      line-height: 1.2;
    }

    .stratum-loading-tip {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge, 4px));
      line-height: 1.45;
      letter-spacing: 0.02em;
      color: var(--mm-ink-mid, #aeaeb2);
      text-align: left;
      flex: 1;
      min-width: 0;
    }

    @container loading-shell (min-width: 780px) {
      .stratum-loading-tip {
        white-space: nowrap;
      }
    }

    @container loading-shell (max-width: 779px) {
      .stratum-loading-tip-panel {
        flex-direction: column;
        align-items: stretch;
        gap: 0.55rem;
      }

      .stratum-loading-tip-label {
        align-self: flex-start;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .stratum-loading-fill {
        transition: none;
      }
      .stratum-loading-overlay {
        transition: none;
        opacity: 1;
      }
      .stratum-loading-card {
        transition: none;
        transform: none;
        opacity: 1;
      }
    }
  `;
  document.head.appendChild(style);
}

export class WorldLoadingScreen {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly stageEl: HTMLDivElement;
  private readonly detailEl: HTMLDivElement;
  private readonly barFillEl: HTMLDivElement;
  private readonly percentEl: HTMLDivElement;
  private readonly tipEl: HTMLParagraphElement;
  private readonly backBtn: HTMLButtonElement;
  private backResolve: (() => void) | null = null;

  private readonly startedAt = performance.now();
  private reportedPct = 0;
  private shownPct = 0;
  private finishing = false;
  private rafId: number | null = null;
  private tipIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastTipIndex = -1;
  private stopped = false;

  constructor(mount: HTMLElement) {
    const base = import.meta.env.BASE_URL;
    injectLoadingStyles(base);

    this.root = document.createElement("div");
    this.root.className = "stratum-loading-overlay";

    const inner = document.createElement("div");
    inner.className = "stratum-loading-inner";

    const main = document.createElement("div");
    main.className = "stratum-loading-main";

    const shell = document.createElement("div");
    shell.className = "stratum-loading-shell";

    this.card = document.createElement("div");
    this.card.className = "stratum-loading-card";

    const brand = document.createElement("div");
    brand.className = "stratum-loading-brand";
    const logo = document.createElement("img");
    logo.className = "stratum-loading-logo";
    logo.src = stratumCoreTextureAssetUrl("logo.png");
    logo.alt = "Stratum";
    const brandText = document.createElement("div");
    brandText.className = "stratum-loading-brand-text";
    const kicker = document.createElement("p");
    kicker.className = "stratum-loading-kicker";
    kicker.textContent = "Please wait";
    this.titleEl = document.createElement("h2");
    this.titleEl.className = "stratum-loading-title";
    this.titleEl.textContent = "Preparing world";
    brandText.appendChild(kicker);
    brandText.appendChild(this.titleEl);
    brand.appendChild(logo);
    brand.appendChild(brandText);

    this.stageEl = document.createElement("div");
    this.stageEl.className = "stratum-loading-stage";
    this.stageEl.textContent = "Loading...";

    this.detailEl = document.createElement("div");
    this.detailEl.className = "stratum-loading-detail";
    this.detailEl.textContent = "";

    const progressWrap = document.createElement("div");
    progressWrap.className = "stratum-loading-progress";
    const progressRow = document.createElement("div");
    progressRow.className = "stratum-loading-progress-row";
    const track = document.createElement("div");
    track.className = "stratum-loading-track";
    this.barFillEl = document.createElement("div");
    this.barFillEl.className = "stratum-loading-fill";
    track.appendChild(this.barFillEl);
    this.percentEl = document.createElement("div");
    this.percentEl.className = "stratum-loading-percent";
    this.percentEl.textContent = "0%";
    progressRow.appendChild(track);
    progressRow.appendChild(this.percentEl);
    progressWrap.appendChild(progressRow);

    const tipPanel = document.createElement("div");
    tipPanel.className = "stratum-loading-tip-panel";
    const tipLabel = document.createElement("p");
    tipLabel.className = "stratum-loading-tip-label";
    tipLabel.textContent = "Tip";
    this.tipEl = document.createElement("p");
    this.tipEl.className = "stratum-loading-tip";
    this.tipEl.textContent = this._pickRandomTip();
    tipPanel.appendChild(tipLabel);
    tipPanel.appendChild(this.tipEl);

    const actions = document.createElement("div");
    actions.className = "stratum-loading-actions";
    this.backBtn = document.createElement("button");
    this.backBtn.type = "button";
    this.backBtn.className = "stratum-loading-btn";
    this.backBtn.textContent = "Back to menu";
    this.backBtn.hidden = true;
    this.backBtn.addEventListener("click", () => {
      this.backResolve?.();
      this.backResolve = null;
    });
    actions.appendChild(this.backBtn);

    this.card.appendChild(brand);
    this.card.appendChild(this.stageEl);
    this.card.appendChild(this.detailEl);
    this.card.appendChild(progressWrap);
    this.card.appendChild(tipPanel);
    this.card.appendChild(actions);
    shell.appendChild(this.card);
    main.appendChild(shell);
    inner.appendChild(main);
    this.root.appendChild(inner);
    mount.appendChild(this.root);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.root.classList.add("stratum-loading-overlay--entered");
      });
    });

    this._startBarLoop();
    this.tipIntervalId = setInterval(() => {
      this.tipEl.textContent = this._pickRandomTip();
    }, TIP_ROTATE_MS);
  }

  private _pickRandomTip(): string {
    if (LOADING_TIPS.length === 0) {
      return "";
    }
    let i = this.lastTipIndex;
    if (LOADING_TIPS.length > 1) {
      while (i === this.lastTipIndex) {
        i = Math.floor(unixRandom01() * LOADING_TIPS.length);
      }
    } else {
      i = 0;
    }
    this.lastTipIndex = i;
    return LOADING_TIPS[i] ?? "";
  }

  private _startBarLoop(): void {
    const tick = (): void => {
      if (this.stopped) {
        return;
      }
      const elapsed = performance.now() - this.startedAt;
      const timeEase = Math.min(92, (elapsed / TIME_RAMP_MS) * 92);
      let target = Math.max(this.reportedPct, timeEase);
      if (this.finishing) {
        target = 100;
      }
      this.shownPct += (target - this.shownPct) * BAR_LERP;
      if (this.finishing && 100 - this.shownPct < 0.25) {
        this.shownPct = 100;
      }
      const seg = 100 / BAR_PIXEL_SEGMENTS;
      const display = Math.min(100, Math.round(this.shownPct / seg) * seg);
      this.barFillEl.style.width = `${display}%`;
      this.percentEl.textContent = `${Math.round(display)}%`;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private _stopBarLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private _stopTips(): void {
    if (this.tipIntervalId !== null) {
      clearInterval(this.tipIntervalId);
      this.tipIntervalId = null;
    }
  }

  /**
   * Drive the bar to 100% and wait briefly so the transition reads cleanly.
   */
  finishAndHold(): Promise<void> {
    this.finishing = true;
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 420);
    });
  }

  update(progress: LoadingProgressUpdate): void {
    this.card.classList.remove("stratum-loading-card--error");
    this.stageEl.classList.remove("stratum-loading-stage--error");
    this.barFillEl.style.opacity = "";
    this.titleEl.textContent = "Preparing world";
    this.stageEl.textContent = progress.stage;
    this.detailEl.textContent = progress.detail ?? "";
    if (
      progress.current !== undefined &&
      progress.total !== undefined &&
      progress.total > 0
    ) {
      const pct = clamp01(progress.current / progress.total) * 100;
      this.reportedPct = Math.max(this.reportedPct, pct);
    }
  }

  setError(message: string): void {
    this.stopped = true;
    this._stopBarLoop();
    this._stopTips();
    this.card.classList.add("stratum-loading-card--error");
    this.titleEl.textContent = "Unable to Start";
    this.stageEl.classList.add("stratum-loading-stage--error");
    this.stageEl.textContent = "Loading failed";
    this.detailEl.textContent = message;
    this.barFillEl.style.width = "100%";
    this.barFillEl.style.opacity = "0.35";
    this.percentEl.textContent = "—";
    this.tipEl.textContent = "";
    const tipLabel = this.card.querySelector(".stratum-loading-tip-label");
    if (tipLabel instanceof HTMLElement) {
      tipLabel.style.display = "none";
    }
    // Allow the user to interact with the error card.
    this.root.style.pointerEvents = "auto";
    this.backBtn.hidden = false;
  }

  waitForBackToMenu(): Promise<void> {
    if (!this.backBtn.hidden) {
      // already in error mode
    } else {
      this.backBtn.hidden = false;
    }
    this.root.style.pointerEvents = "auto";
    return new Promise<void>((resolve) => {
      this.backResolve = resolve;
    });
  }

  destroy(): void {
    this.stopped = true;
    this._stopBarLoop();
    this._stopTips();
    this.root.remove();
  }
}
