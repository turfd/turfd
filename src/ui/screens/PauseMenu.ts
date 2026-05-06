/**
 * Escape: full-screen pause overlay (main-menu styling). Settings opens from a
 * secondary action button (same style as Save) and shares the main-menu panel.
 */
import type { EventBus } from "../../core/EventBus";
import type { GameEvent } from "../../core/types";
import type { CachedMod } from "../../mods/workshopTypes";
import type { IndexedDBStore } from "../../persistence/IndexedDBStore";
import { stratumCoreTextureAssetUrl } from "../../core/textureManifest";
import { blurFocusContainedBy } from "../blurOverlayFocus";
import { mountSettingsPanel } from "../settings/mountSettingsPanel";

const PAUSE_STYLE_ID = "stratum-pause-styles";

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
      --mm-ink: #f2f2f7;
      --mm-ink-mid: #aeaeb2;
      --mm-ink-soft: #8e8e93;
      --mm-surface: rgba(44, 44, 46, 0.82);
      --mm-surface-deep: rgba(36, 36, 38, 0.9);
      --mm-border: rgba(255, 255, 255, 0.1);
      --mm-border-strong: rgba(255, 255, 255, 0.16);
      --mm-radius-sm: 10px;
      --mm-radius-md: 14px;
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
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: auto;
      text-rendering: geometricPrecision;
      color: var(--mm-ink);
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
      overflow: hidden;
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background: rgba(44, 44, 46, 0.92);
      padding: clamp(1.25rem, 3vw, 1.6rem) clamp(1.35rem, 3.5vw, 1.75rem);
      box-sizing: border-box;
      transform: translateY(16px);
      opacity: 0;
      transition:
        transform 0.3s cubic-bezier(0.22, 1, 0.36, 1),
        opacity 0.26s ease;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .pm-card.pm-card--wide {
      width: min(44rem, 100%);
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
      flex-shrink: 0;
    }
    .pm-logo {
      width: min(120px, 40vw);
      height: auto;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .pm-body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .pm-pane {
      display: none;
      flex-direction: column;
      min-height: 0;
      flex: 1;
      overflow-y: auto;
    }
    .pm-pane--active {
      display: flex;
    }
    .pm-pane::-webkit-scrollbar { width: 4px; }
    .pm-pane::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 4px;
    }

    .pm-settings-host {
      flex: 1;
      min-height: min(48vh, 440px);
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
    }
    .pm-settings-host.mm-panel {
      padding: 1.1rem 1.25rem;
    }

    .pm-title {
      margin: 0 0 1rem;
      font-size: max(var(--mm-bold-min), 24px);
      line-height: 30px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: center;
      flex-shrink: 0;
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
      font-size: max(var(--mm-bold-min), 17px);
      line-height: 22px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      transition: opacity 0.12s ease, border-color 0.12s ease;
    }
    .pm-btn:hover { opacity: 0.92; }
    .pm-btn:active { opacity: 0.85; }
    .pm-btn-primary {
      background: var(--mm-ink);
      color: #1c1c1e;
      border-color: var(--mm-ink);
    }
    .pm-btn-secondary {
      background: var(--mm-surface-deep);
      color: var(--mm-ink-mid);
    }
    .pm-btn-secondary:hover {
      color: var(--mm-ink);
      border-color: var(--mm-border-strong);
    }

    .pm-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--mm-border);
    }
    .pm-section-title {
      font-size: max(var(--mm-bold-min), 15px);
      line-height: 20px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mm-ink-soft);
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
      font-size: 20px;
      line-height: 30px;
      color: var(--mm-ink-mid);
      margin-top: 0.15rem;
      min-height: 1.35em;
      word-break: break-all;
      width: 100%;
      text-align: center;
    }

    .pm-label {
      display: block;
      font-size: max(var(--mm-bold-min), 15px);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
      margin-bottom: 0.35rem;
    }
    .pm-range {
      width: 100%;
      accent-color: var(--mm-ink-mid);
    }
    .pm-hint {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), 16px);
      line-height: 24px;
      color: var(--mm-ink-soft);
      margin-top: 0.35rem;
      min-height: 1.2em;
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
  private pauseSettingsAbort: AbortController | null = null;

  private networkRole: "offline" | "host" | "client" = "offline";
  private roomCode: string | null = null;
  private mpBtn: HTMLButtonElement | null = null;
  private mpStatusEl: HTMLDivElement | null = null;
  private resumeBtn: HTMLButtonElement | null = null;

  init(
    mount: HTMLElement,
    bus: EventBus,
    texturePacks?: {
      store: IndexedDBStore;
      getInstalled: () => readonly CachedMod[];
    },
  ): void {
    const base = import.meta.env.BASE_URL;
    injectPauseStyles(base);

    this.pauseSettingsAbort = new AbortController();

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
    logo.src = stratumCoreTextureAssetUrl("logo.png");
    logo.alt = "";
    brand.appendChild(logo);

    const body = document.createElement("div");
    body.className = "pm-body";

    const paneGame = document.createElement("div");
    paneGame.className = "pm-pane pm-pane--active";

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
    this.resumeBtn = resumeBtn;

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
      if (quitBtn.disabled) {
        return;
      }
      quitBtn.disabled = true;
      quitBtn.style.opacity = "0.55";
      bus.emit({ type: "ui:quit" } satisfies GameEvent);
    });

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "pm-btn pm-btn-secondary";
    settingsBtn.textContent = "Settings";
    settingsBtn.addEventListener("click", () => {
      setPauseView("settings");
    });

    actions.appendChild(resumeBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(quitBtn);
    actions.appendChild(settingsBtn);

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
    paneGame.append(title, actions, mpSection);

    const paneSettings = document.createElement("div");
    paneSettings.className = "pm-pane";
    const settingsActions = document.createElement("div");
    settingsActions.className = "pm-actions";
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "pm-btn pm-btn-secondary";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", () => {
      setPauseView("game");
    });
    settingsActions.appendChild(backBtn);
    const settingsHost = document.createElement("div");
    settingsHost.className = "mm-panel mm-settings-panel pm-settings-host";
    paneSettings.append(settingsActions, settingsHost);

    function setPauseView(which: "game" | "settings"): void {
      const gameOn = which === "game";
      paneGame.classList.toggle("pm-pane--active", gameOn);
      paneSettings.classList.toggle("pm-pane--active", !gameOn);
      card.classList.toggle("pm-card--wide", !gameOn);
    }

    body.append(paneGame, paneSettings);

    card.append(brand, body);
    overlay.appendChild(card);
    mount.appendChild(overlay);
    this.overlay = overlay;

    if (texturePacks !== undefined) {
      void mountSettingsPanel(settingsHost, {
        store: texturePacks.store,
        getInstalled: texturePacks.getInstalled,
        bus,
        applyKeyBindingsLive: true,
        signal: this.pauseSettingsAbort.signal,
      });
    } else {
      settingsHost.textContent =
        "Settings are unavailable (no local store). Return to the main menu.";
      settingsHost.style.fontFamily = "'M5x7', monospace";
      settingsHost.style.fontSize = "20px";
      settingsHost.style.color = "#8e8e93";
      settingsHost.style.textAlign = "center";
      settingsHost.style.justifyContent = "center";
    }

    this._syncMultiplayerPanel();
  }

  setOpen(open: boolean): void {
    const el = this.overlay;
    if (el === null) {
      return;
    }
    if (!open) {
      blurFocusContainedBy(el);
    }
    el.classList.toggle("pm-overlay--open", open);
    el.setAttribute("aria-hidden", open ? "false" : "true");
    if (open) {
      queueMicrotask(() => {
        this.resumeBtn?.focus();
      });
    }
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
      status.style.color = "";
      status.textContent = "Joined another player's room.";
      return;
    }

    if (this.networkRole === "host" && this.roomCode !== null) {
      btn.disabled = false;
      btn.textContent = "Close room";
      status.style.color = "var(--mm-ink)";
      status.textContent = `Code: ${this.roomCode}`;
      return;
    }

    btn.disabled = false;
    btn.textContent = "Open room to players";
    status.style.color = "";
    status.textContent =
      "Open your room so friends can join with your code.";
  }

  destroy(): void {
    this.pauseSettingsAbort?.abort();
    this.pauseSettingsAbort = null;
    for (const u of this.unsubs) {
      u();
    }
    this.unsubs.length = 0;
    this.mpBtn = null;
    this.mpStatusEl = null;
    this.resumeBtn = null;
    this.overlay?.remove();
    this.overlay = null;
  }
}
