/**
 * DOM UI root: hotbar, pause actions, and future overlays.
 */
import type { AudioEngine } from "../audio/AudioEngine";
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { SaveGame } from "../persistence/SaveGame";
import { HUD } from "./screens/HUD";
import { PauseMenu } from "./screens/PauseMenu";

export class UIShell {
  private readonly hud: HUD;
  private readonly pauseMenu: PauseMenu;
  private unsubSave: (() => void) | null = null;
  private unsubVolume: (() => void) | null = null;
  private unsubSessionEnded: (() => void) | null = null;
  private sessionOverlay: HTMLDivElement | null = null;
  private sessionEndedShown = false;

  constructor(
    bus: EventBus,
    mount: HTMLElement,
    saveGame: SaveGame | null,
    audio: AudioEngine,
  ) {
    this.hud = new HUD();
    this.hud.init(mount, bus);
    this.pauseMenu = new PauseMenu();
    this.pauseMenu.init(mount, bus);

    const sess = document.createElement("div");
    sess.className = "turfd-session-overlay";
    sess.setAttribute("aria-hidden", "true");
    sess.setAttribute("role", "alertdialog");
    sess.setAttribute("aria-modal", "true");
    sess.setAttribute("aria-labelledby", "turfd-session-ended-msg");

    const card = document.createElement("div");
    card.className = "turfd-session-card";
    card.addEventListener("click", (e) => e.stopPropagation());

    const msg = document.createElement("p");
    msg.id = "turfd-session-ended-msg";
    msg.style.cssText = [
      "margin:0 0 1.15rem",
      "font-family:'M5x7',monospace",
      "font-size:17px",
      "line-height:1.5",
      "color:#f2f2f7",
    ].join(";");

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.textContent = "Return to main menu";
    backBtn.style.cssText = [
      "padding:11px 18px",
      "font-family:'BoldPixels',monospace",
      "font-size:14px",
      "text-transform:uppercase",
      "letter-spacing:0.06em",
      "cursor:pointer",
      "border-radius:10px",
      "border:1px solid #f2f2f7",
      "background:#f2f2f7",
      "color:#1c1c1e",
    ].join(";");
    backBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:quit" } satisfies GameEvent);
    });

    card.appendChild(msg);
    card.appendChild(backBtn);
    sess.appendChild(card);
    mount.appendChild(sess);
    this.sessionOverlay = sess;

    this.unsubSessionEnded = bus.on("ui:session-ended", (e) => {
      if (this.sessionEndedShown) {
        return;
      }
      this.sessionEndedShown = true;
      msg.textContent = e.message;
      sess.classList.add("turfd-session-overlay--open");
      sess.setAttribute("aria-hidden", "false");
      bus.emit({ type: "ui:close-pause" } satisfies GameEvent);
    });

    this.unsubSave = bus.on("ui:save", () => {
      if (saveGame !== null) {
        void saveGame.save();
      }
    });

    this.unsubVolume = bus.on("settings:volume", (e) => {
      audio.setMasterVolume(e.master / 100);
      audio.setMusicVolume(e.music / 100);
      audio.setSfxVolume(e.sfx / 100);
    });
  }

  /** Full-screen pause overlay (Escape). */
  setPauseOverlayOpen(open: boolean): void {
    this.pauseMenu.setOpen(open);
  }

  /** Tab background wall edit mode indicator. */
  setBackgroundEditMode(active: boolean): void {
    this.hud.setBackgroundEditMode(active);
  }

  destroy(): void {
    this.unsubSave?.();
    this.unsubSave = null;
    this.unsubVolume?.();
    this.unsubVolume = null;
    this.unsubSessionEnded?.();
    this.unsubSessionEnded = null;
    this.sessionOverlay?.remove();
    this.sessionOverlay = null;
    this.sessionEndedShown = false;
    this.pauseMenu.destroy();
    this.hud.destroy();
  }
}
