/**
 * Escape: full-screen pause overlay (main-menu styling). Volume lives on the main menu only.
 */
import {
  DAWN_LENGTH_MS,
  DAYLIGHT_LENGTH_MS,
  DAY_LENGTH_MS,
  DUSK_LENGTH_MS,
} from "../../core/constants";
import type { EventBus } from "../../core/EventBus";
import type { GameEvent } from "../../core/types";

const U_DAWN_END = DAWN_LENGTH_MS / DAY_LENGTH_MS;
const U_DAY_END = (DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS) / DAY_LENGTH_MS;
const U_DUSK_END =
  (DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS + DUSK_LENGTH_MS) / DAY_LENGTH_MS;

const TIME_SLIDER_STEPS = 1000;

const PAUSE_STYLE_ID = "stratum-pause-styles";

function skyPeriodLabel(phase: number): string {
  if (phase < U_DAWN_END) {
    return "Dawn";
  }
  if (phase < U_DAY_END) {
    return "Day";
  }
  if (phase < U_DUSK_END) {
    return "Dusk";
  }
  return "Night";
}

function injectPauseStyles(base: string): void {
  if (document.getElementById(PAUSE_STYLE_ID)) {
    return;
  }
  const fontUrl = (name: string): string => `${base}assets/fonts/${name}`;
  const style = document.createElement("style");
  style.id = PAUSE_STYLE_ID;
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

    .pm-overlay {
      position: fixed;
      inset: 0;
      z-index: 1150;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: clamp(1rem, 4vw, 2rem);
      box-sizing: border-box;
      background: rgba(24, 24, 26, 0.55);
      font-family: 'BoldPixels', 'Courier New', monospace;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: unset;
      text-rendering: optimizeSpeed;
      color: #f2f2f7;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition:
        opacity 0.24s ease,
        visibility 0.24s ease;
    }
    .pm-overlay.pm-overlay--open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    .pm-card {
      width: min(26rem, 100%);
      max-height: min(90vh, 100%);
      overflow-y: auto;
      border-radius: 14px;
      corner-shape: squircle;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(44, 44, 46, 0.92);
      padding: clamp(1.25rem, 3vw, 1.6rem) clamp(1.35rem, 3.5vw, 1.75rem);
      box-sizing: border-box;
      transform: translateY(16px);
      opacity: 0;
      transition:
        transform 0.3s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.26s ease;
    }
    .pm-overlay.pm-overlay--open .pm-card {
      transform: translateY(0);
      opacity: 1;
    }

    .pm-brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 0.85rem;
    }
    .pm-logo {
      width: min(120px, 40vw);
      height: auto;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .pm-title {
      margin: 0 0 1rem;
      font-size: 20px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: center;
    }

    .pm-actions {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .pm-btn {
      padding: 11px 18px;
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: 10px;
      corner-shape: squircle;
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: opacity 0.12s ease, border-color 0.12s ease;
    }
    .pm-btn:hover { opacity: 0.92; }
    .pm-btn:active { opacity: 0.85; }
    .pm-btn-primary {
      background: #f2f2f7;
      color: #1c1c1e;
      border-color: #f2f2f7;
    }
    .pm-btn-secondary {
      background: rgba(36, 36, 38, 0.95);
      color: #aeaeb2;
    }
    .pm-btn-secondary:hover {
      color: #f2f2f7;
      border-color: rgba(255, 255, 255, 0.16);
    }

    .pm-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .pm-section-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #8e8e93;
      margin-bottom: 0.55rem;
    }
    .pm-mp-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 0.45rem;
    }
    .pm-mp-col .pm-section-title {
      width: 100%;
      text-align: center;
      margin-bottom: 0.25rem;
    }
    .pm-mp-btn {
      width: 100%;
      box-sizing: border-box;
    }
    .pm-mp-status {
      font-family: 'M5x7', monospace;
      font-size: 17px;
      line-height: 1.45;
      color: #aeaeb2;
      margin-top: 0.15rem;
      min-height: 1.35em;
      word-break: break-all;
      width: 100%;
      text-align: center;
    }

    .pm-label {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #8e8e93;
      margin-bottom: 0.35rem;
    }
    .pm-range {
      width: 100%;
      accent-color: #aeaeb2;
    }
    .pm-hint {
      font-family: 'M5x7', monospace;
      font-size: 13px;
      color: #8e8e93;
      margin-top: 0.35rem;
      min-height: 1.2em;
    }

    .pm-hint-note {
      margin: 0.75rem 0 0;
      font-family: 'M5x7', monospace;
      font-size: 13px;
      line-height: 1.45;
      color: #8e8e93;
      text-align: center;
    }

    @media (prefers-reduced-motion: reduce) {
      .pm-overlay,
      .pm-card {
        transition: none;
      }
      .pm-overlay.pm-overlay--open .pm-card {
        transform: none;
      }
    }
  `;
  document.head.appendChild(style);
}

export class PauseMenu {
  private overlay: HTMLDivElement | null = null;
  private readonly unsubs: (() => void)[] = [];

  private adjustingWorldTime = false;
  private networkRole: "offline" | "host" | "client" = "offline";
  private roomCode: string | null = null;
  private mpBtn: HTMLButtonElement | null = null;
  private mpStatusEl: HTMLDivElement | null = null;

  init(mount: HTMLElement, bus: EventBus): void {
    const base = import.meta.env.BASE_URL;
    injectPauseStyles(base);

    const overlay = document.createElement("div");
    overlay.id = "pause-menu";
    overlay.className = "pm-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        bus.emit({ type: "ui:close-pause" } satisfies GameEvent);
      }
    });

    const card = document.createElement("div");
    card.className = "pm-card";
    card.addEventListener("click", (e) => e.stopPropagation());

    const brand = document.createElement("div");
    brand.className = "pm-brand";
    const logo = document.createElement("img");
    logo.className = "pm-logo";
    logo.src = `${base}assets/textures/logo.png`;
    logo.alt = "";
    brand.appendChild(logo);

    const title = document.createElement("h2");
    title.className = "pm-title";
    title.textContent = "Paused";

    const actions = document.createElement("div");
    actions.className = "pm-actions";

    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "pm-btn pm-btn-primary";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:close-pause" } satisfies GameEvent);
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "pm-btn pm-btn-secondary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:save" } satisfies GameEvent);
    });

    const quitBtn = document.createElement("button");
    quitBtn.type = "button";
    quitBtn.className = "pm-btn pm-btn-secondary";
    quitBtn.textContent = "Save and Quit";
    quitBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:quit" } satisfies GameEvent);
    });

    actions.appendChild(resumeBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(quitBtn);

    const mpSection = document.createElement("div");
    mpSection.className = "pm-section pm-mp-col";
    const mpTitle = document.createElement("div");
    mpTitle.className = "pm-section-title";
    mpTitle.textContent = "Room";
    const mpBtn = document.createElement("button");
    mpBtn.type = "button";
    mpBtn.className = "pm-btn pm-btn-secondary pm-mp-btn";
    mpBtn.textContent = "Open room to players";
    mpBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:toggle-multiplayer" } satisfies GameEvent);
    });
    const mpStatusEl = document.createElement("div");
    mpStatusEl.className = "pm-mp-status";
    mpSection.appendChild(mpTitle);
    mpSection.appendChild(mpBtn);
    mpSection.appendChild(mpStatusEl);
    this.mpBtn = mpBtn;
    this.mpStatusEl = mpStatusEl;

    this.unsubs.push(
      bus.on("game:network-role", (e) => {
        this.networkRole = e.role;
        this._syncMultiplayerPanel();
      }),
    );
    this.unsubs.push(
      bus.on("net:room-code", (e) => {
        this.roomCode = e.roomCode;
        this._syncMultiplayerPanel();
      }),
    );

    const timeSection = document.createElement("div");
    timeSection.className = "pm-section";
    const timeTitle = document.createElement("div");
    timeTitle.className = "pm-section-title";
    timeTitle.textContent = "Time of day";
    const timeLab = document.createElement("label");
    timeLab.className = "pm-label";
    timeLab.textContent = "Cycle";
    const timeInput = document.createElement("input");
    timeInput.type = "range";
    timeInput.min = "0";
    timeInput.max = String(TIME_SLIDER_STEPS);
    timeInput.step = "1";
    timeInput.value = "0";
    timeInput.className = "pm-range";
    const timeHint = document.createElement("div");
    timeHint.className = "pm-hint";
    timeHint.textContent = "—";

    const syncTimeUi = (worldTimeMs: number): void => {
      const phase = worldTimeMs / DAY_LENGTH_MS;
      timeHint.textContent = `${skyPeriodLabel(phase)} · ${Math.round(phase * 100)}% of cycle`;
      if (!this.adjustingWorldTime) {
        timeInput.value = String(
          Math.min(
            TIME_SLIDER_STEPS,
            Math.max(0, Math.round(phase * TIME_SLIDER_STEPS)),
          ),
        );
      }
    };

    const applyTimeDisabled = (): void => {
      const client = this.networkRole === "client";
      timeInput.disabled = client;
      timeLab.style.opacity = client ? "0.55" : "1";
      timeHint.style.opacity = client ? "0.55" : "1";
    };

    timeInput.addEventListener("focus", () => {
      this.adjustingWorldTime = true;
    });
    timeInput.addEventListener("blur", () => {
      this.adjustingWorldTime = false;
    });

    timeInput.addEventListener("input", () => {
      if (this.networkRole === "client") {
        return;
      }
      const raw = parseInt(timeInput.value, 10);
      if (!Number.isFinite(raw)) {
        return;
      }
      const phase = raw / TIME_SLIDER_STEPS;
      syncTimeUi(phase * DAY_LENGTH_MS);
      bus.emit({
        type: "ui:set-world-time-phase",
        phase,
      } satisfies GameEvent);
    });

    this.unsubs.push(
      bus.on("game:tick", (e) => {
        syncTimeUi(e.worldTimeMs);
      }),
    );
    this.unsubs.push(
      bus.on("game:network-role", () => {
        applyTimeDisabled();
      }),
    );

    timeSection.appendChild(timeTitle);
    timeSection.appendChild(timeLab);
    timeSection.appendChild(timeInput);
    timeSection.appendChild(timeHint);
    applyTimeDisabled();

    const settingsNote = document.createElement("p");
    settingsNote.className = "pm-hint-note";
    settingsNote.textContent =
      "Audio and other settings are on the main menu (Settings tab).";

    card.appendChild(brand);
    card.appendChild(title);
    card.appendChild(actions);
    card.appendChild(mpSection);
    card.appendChild(timeSection);
    card.appendChild(settingsNote);
    overlay.appendChild(card);
    mount.appendChild(overlay);
    this.overlay = overlay;

    this._syncMultiplayerPanel();
  }

  setOpen(open: boolean): void {
    const el = this.overlay;
    if (el === null) {
      return;
    }
    el.classList.toggle("pm-overlay--open", open);
    el.setAttribute("aria-hidden", open ? "false" : "true");
  }

  private _syncMultiplayerPanel(): void {
    const btn = this.mpBtn;
    const status = this.mpStatusEl;
    if (btn === null || status === null) {
      return;
    }

    if (this.networkRole === "client") {
      btn.disabled = true;
      btn.textContent = "Room";
      status.style.color = "#aeaeb2";
      status.textContent = "Joined another player's room.";
      return;
    }

    if (this.networkRole === "host" && this.roomCode !== null) {
      btn.disabled = false;
      btn.textContent = "Close room";
      status.style.color = "#f2f2f7";
      status.textContent = `Code: ${this.roomCode}`;
      return;
    }

    btn.disabled = false;
    btn.textContent = "Open room to players";
    status.style.color = "#aeaeb2";
    status.textContent =
      "Open your room so friends can join with your code.";
  }

  destroy(): void {
    for (const u of this.unsubs) {
      u();
    }
    this.unsubs.length = 0;
    this.mpBtn = null;
    this.mpStatusEl = null;
    this.overlay?.remove();
    this.overlay = null;
  }
}
