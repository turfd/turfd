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
  "Room codes in multiplayer are six characters—double-check before joining a friend.",
  "If loading ever feels stuck, check the stage text above for what the game is doing.",
];

const STYLE_ID = "turfd-world-loading-styles";

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
    }

    .turfd-loading-overlay {
      --tl-ink: #f2f2f7;
      --tl-ink-mid: #aeaeb2;
      --tl-ink-soft: #8e8e93;
      --tl-surface: rgba(44, 44, 46, 0.88);
      --tl-surface-deep: rgba(36, 36, 38, 0.94);
      --tl-border: rgba(255, 255, 255, 0.1);
      --tl-border-strong: rgba(255, 255, 255, 0.16);
      --tl-danger: #ff6b6b;
      --tl-radius-sm: 10px;
      --tl-radius-md: 14px;
      --tl-radius-lg: 18px;

      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      flex-direction: column;
      background: rgba(24, 24, 26, 0.55);
      font-family: 'BoldPixels', 'Courier New', monospace;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: unset;
      text-rendering: optimizeSpeed;
      color: var(--tl-ink);
      padding: clamp(1rem, 4vw, 1.75rem);
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .turfd-loading-overlay.turfd-loading-overlay--entered {
      opacity: 1;
    }

    .turfd-loading-main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }

    .turfd-loading-card {
      width: min(32rem, 100%);
      border-radius: var(--tl-radius-md);
      corner-shape: squircle;
      border: 1px solid var(--tl-border);
      background: var(--tl-surface);
      padding: clamp(1.35rem, 3.5vw, 1.75rem) clamp(1.5rem, 4vw, 2rem);
      box-sizing: border-box;
      transform: translateY(14px);
      opacity: 0;
      transition:
        transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.28s ease;
    }

    .turfd-loading-overlay.turfd-loading-overlay--entered .turfd-loading-card {
      transform: translateY(0);
      opacity: 1;
    }

    .turfd-loading-card.turfd-loading-card--error {
      border-color: rgba(255, 69, 58, 0.35);
    }

    .turfd-loading-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 1.25rem;
    }

    .turfd-loading-logo {
      display: block;
      width: min(200px, 52vw);
      height: auto;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .turfd-loading-kicker {
      margin: 0.65rem 0 0;
      font-family: 'M5x7', monospace;
      font-size: 14px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--tl-ink-soft);
    }

    .turfd-loading-title {
      margin: 0 0 1rem;
      font-family: 'BoldPixels', monospace;
      font-size: 19px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--tl-ink);
      text-align: center;
    }

    .turfd-loading-stage {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--tl-ink-mid);
      text-align: center;
      line-height: 1.35;
    }

    .turfd-loading-detail {
      min-height: 1.35em;
      margin-top: 0.5rem;
      font-family: 'M5x7', monospace;
      font-size: 16px;
      line-height: 1.45;
      color: var(--tl-ink-soft);
      text-align: center;
    }

    .turfd-loading-progress {
      margin-top: 1.35rem;
    }

    .turfd-loading-track {
      width: 100%;
      height: 10px;
      border-radius: var(--tl-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--tl-border);
      background: var(--tl-surface-deep);
      overflow: hidden;
    }

    .turfd-loading-fill {
      height: 100%;
      width: 0%;
      background: var(--tl-ink-mid);
      transform-origin: left center;
    }

    .turfd-loading-percent {
      margin-top: 0.5rem;
      min-height: 1.35em;
      text-align: right;
      font-family: 'M5x7', monospace;
      font-size: 14px;
      color: var(--tl-ink-soft);
    }

    .turfd-loading-stage--error {
      color: var(--tl-danger);
    }

    .turfd-loading-tip-wrap {
      flex-shrink: 0;
      max-width: 40rem;
      width: 100%;
      margin: 0 auto;
      padding: 0.5rem 0.5rem 0;
      box-sizing: border-box;
    }

    .turfd-loading-tip-label {
      margin: 0 0 0.35rem;
      font-family: 'BoldPixels', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--tl-ink-soft);
      text-align: center;
    }

    .turfd-loading-tip {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: 15px;
      line-height: 1.5;
      color: var(--tl-ink-mid);
      text-align: center;
    }

    @media (prefers-reduced-motion: reduce) {
      .turfd-loading-fill {
        transition: none;
      }
      .turfd-loading-overlay {
        transition: none;
        opacity: 1;
      }
      .turfd-loading-card {
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
    this.root.className = "turfd-loading-overlay";

    const main = document.createElement("div");
    main.className = "turfd-loading-main";

    this.card = document.createElement("div");
    this.card.className = "turfd-loading-card";

    const brand = document.createElement("div");
    brand.className = "turfd-loading-brand";
    const logo = document.createElement("img");
    logo.className = "turfd-loading-logo";
    logo.src = `${base}assets/textures/logo.png`;
    logo.alt = "Turf'd";
    const kicker = document.createElement("p");
    kicker.className = "turfd-loading-kicker";
    kicker.textContent = "Loading";
    brand.appendChild(logo);
    brand.appendChild(kicker);

    this.titleEl = document.createElement("h2");
    this.titleEl.className = "turfd-loading-title";
    this.titleEl.textContent = "Preparing World";

    this.stageEl = document.createElement("div");
    this.stageEl.className = "turfd-loading-stage";
    this.stageEl.textContent = "Loading...";

    this.detailEl = document.createElement("div");
    this.detailEl.className = "turfd-loading-detail";
    this.detailEl.textContent = "";

    const progressWrap = document.createElement("div");
    progressWrap.className = "turfd-loading-progress";
    const track = document.createElement("div");
    track.className = "turfd-loading-track";
    this.barFillEl = document.createElement("div");
    this.barFillEl.className = "turfd-loading-fill";
    track.appendChild(this.barFillEl);
    this.percentEl = document.createElement("div");
    this.percentEl.className = "turfd-loading-percent";
    this.percentEl.textContent = "0%";
    progressWrap.appendChild(track);
    progressWrap.appendChild(this.percentEl);

    this.card.appendChild(brand);
    this.card.appendChild(this.titleEl);
    this.card.appendChild(this.stageEl);
    this.card.appendChild(this.detailEl);
    this.card.appendChild(progressWrap);
    main.appendChild(this.card);

    const tipWrap = document.createElement("div");
    tipWrap.className = "turfd-loading-tip-wrap";
    const tipLabel = document.createElement("p");
    tipLabel.className = "turfd-loading-tip-label";
    tipLabel.textContent = "Tip";
    this.tipEl = document.createElement("p");
    this.tipEl.className = "turfd-loading-tip";
    this.tipEl.textContent = this._pickRandomTip();
    tipWrap.appendChild(tipLabel);
    tipWrap.appendChild(this.tipEl);

    this.root.appendChild(main);
    this.root.appendChild(tipWrap);
    mount.appendChild(this.root);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.root.classList.add("turfd-loading-overlay--entered");
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
        i = Math.floor(Math.random() * LOADING_TIPS.length);
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
      const display = Math.round(this.shownPct);
      this.barFillEl.style.width = `${display}%`;
      this.percentEl.textContent = `${display}%`;
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
    this.card.classList.remove("turfd-loading-card--error");
    this.stageEl.classList.remove("turfd-loading-stage--error");
    this.barFillEl.style.opacity = "";
    this.titleEl.textContent = "Preparing World";
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
    this.card.classList.add("turfd-loading-card--error");
    this.titleEl.textContent = "Unable to Start";
    this.stageEl.classList.add("turfd-loading-stage--error");
    this.stageEl.textContent = "Loading failed";
    this.detailEl.textContent = message;
    this.barFillEl.style.width = "100%";
    this.barFillEl.style.opacity = "0.35";
    this.percentEl.textContent = "—";
    this.tipEl.textContent = "";
    const tipLabel = this.root.querySelector(".turfd-loading-tip-label");
    if (tipLabel instanceof HTMLElement) {
      tipLabel.style.display = "none";
    }
  }

  destroy(): void {
    this.stopped = true;
    this._stopBarLoop();
    this._stopTips();
    this.root.remove();
  }
}
