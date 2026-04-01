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

    .stratum-loading-overlay {
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

    .stratum-loading-overlay.stratum-loading-overlay--entered {
      opacity: 1;
    }

    .stratum-loading-main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }

    .stratum-loading-card {
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

    .stratum-loading-overlay.stratum-loading-overlay--entered .stratum-loading-card {
      transform: translateY(0);
      opacity: 1;
    }

    .stratum-loading-card.stratum-loading-card--error {
      border-color: rgba(255, 69, 58, 0.35);
    }

    .stratum-loading-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 1.25rem;
    }

    .stratum-loading-logo {
      display: block;
      width: min(200px, 52vw);
      height: auto;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .stratum-loading-kicker {
      margin: 0.65rem 0 0;
      font-family: 'M5x7', monospace;
      font-size: 14px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--tl-ink-soft);
    }

    .stratum-loading-title {
      margin: 0 0 1rem;
      font-family: 'BoldPixels', monospace;
      font-size: 19px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--tl-ink);
      text-align: center;
    }

    .stratum-loading-stage {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--tl-ink-mid);
      text-align: center;
      line-height: 1.35;
    }

    .stratum-loading-detail {
      min-height: 1.35em;
      margin-top: 0.5rem;
      font-family: 'M5x7', monospace;
      font-size: 16px;
      line-height: 1.45;
      color: var(--tl-ink-soft);
      text-align: center;
    }

    .stratum-loading-progress {
      margin-top: 1.35rem;
    }

    .stratum-loading-track {
      width: 100%;
      height: 10px;
      border-radius: var(--tl-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--tl-border);
      background: var(--tl-surface-deep);
      overflow: hidden;
    }

    .stratum-loading-fill {
      height: 100%;
      width: 0%;
      background: var(--tl-ink-mid);
      transform-origin: left center;
    }

    .stratum-loading-percent {
      margin-top: 0.5rem;
      min-height: 1.35em;
      text-align: right;
      font-family: 'M5x7', monospace;
      font-size: 14px;
      color: var(--tl-ink-soft);
    }

    .stratum-loading-stage--error {
      color: var(--tl-danger);
    }

    .stratum-loading-tip-wrap {
      flex-shrink: 0;
      max-width: 40rem;
      width: 100%;
      margin: 0 auto;
      padding: 0.5rem 0.5rem 0;
      box-sizing: border-box;
    }

    .stratum-loading-tip-label {
      margin: 0 0 0.35rem;
      font-family: 'BoldPixels', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--tl-ink-soft);
      text-align: center;
    }

    .stratum-loading-tip {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: 15px;
      line-height: 1.5;
      color: var(--tl-ink-mid);
      text-align: center;
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

    const main = document.createElement("div");
    main.className = "stratum-loading-main";

    this.card = document.createElement("div");
    this.card.className = "stratum-loading-card";

    const brand = document.createElement("div");
    brand.className = "stratum-loading-brand";
    const logo = document.createElement("img");
    logo.className = "stratum-loading-logo";
    logo.src = `${base}assets/textures/logo.png`;
    logo.alt = "Stratum";
    const kicker = document.createElement("p");
    kicker.className = "stratum-loading-kicker";
    kicker.textContent = "Loading";
    brand.appendChild(logo);
    brand.appendChild(kicker);

    this.titleEl = document.createElement("h2");
    this.titleEl.className = "stratum-loading-title";
    this.titleEl.textContent = "Preparing World";

    this.stageEl = document.createElement("div");
    this.stageEl.className = "stratum-loading-stage";
    this.stageEl.textContent = "Loading...";

    this.detailEl = document.createElement("div");
    this.detailEl.className = "stratum-loading-detail";
    this.detailEl.textContent = "";

    const progressWrap = document.createElement("div");
    progressWrap.className = "stratum-loading-progress";
    const track = document.createElement("div");
    track.className = "stratum-loading-track";
    this.barFillEl = document.createElement("div");
    this.barFillEl.className = "stratum-loading-fill";
    track.appendChild(this.barFillEl);
    this.percentEl = document.createElement("div");
    this.percentEl.className = "stratum-loading-percent";
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
    tipWrap.className = "stratum-loading-tip-wrap";
    const tipLabel = document.createElement("p");
    tipLabel.className = "stratum-loading-tip-label";
    tipLabel.textContent = "Tip";
    this.tipEl = document.createElement("p");
    this.tipEl.className = "stratum-loading-tip";
    this.tipEl.textContent = this._pickRandomTip();
    tipWrap.appendChild(tipLabel);
    tipWrap.appendChild(this.tipEl);

    this.root.appendChild(main);
    this.root.appendChild(tipWrap);
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
    this.card.classList.remove("stratum-loading-card--error");
    this.stageEl.classList.remove("stratum-loading-stage--error");
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
    this.card.classList.add("stratum-loading-card--error");
    this.titleEl.textContent = "Unable to Start";
    this.stageEl.classList.add("stratum-loading-stage--error");
    this.stageEl.textContent = "Loading failed";
    this.detailEl.textContent = message;
    this.barFillEl.style.width = "100%";
    this.barFillEl.style.opacity = "0.35";
    this.percentEl.textContent = "—";
    this.tipEl.textContent = "";
    const tipLabel = this.root.querySelector(".stratum-loading-tip-label");
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
