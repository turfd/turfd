/**
 * DOM UI root: hotbar, pause actions, and future overlays.
 */
import type { AudioEngine } from "../audio/AudioEngine";
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { CachedMod } from "../mods/workshopTypes";
import type { IndexedDBStore } from "../persistence/IndexedDBStore";
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
  private deathOverlay: HTMLDivElement | null = null;

  constructor(
    bus: EventBus,
    mount: HTMLElement,
    saveGame: SaveGame | null,
    audio: AudioEngine,
    texturePacks?: {
      store: IndexedDBStore;
      getInstalled: () => readonly CachedMod[];
    },
  ) {
    this.hud = new HUD();
    this.hud.init(mount, bus);
    this.pauseMenu = new PauseMenu();
    this.pauseMenu.init(mount, bus, texturePacks);

    const sess = document.createElement("div");
    sess.className = "stratum-session-overlay";
    sess.setAttribute("aria-hidden", "true");
    sess.setAttribute("role", "alertdialog");
    sess.setAttribute("aria-modal", "true");
    sess.setAttribute("aria-labelledby", "stratum-session-ended-msg");

    const card = document.createElement("div");
    card.className = "stratum-session-card";
    card.addEventListener("click", (e) => e.stopPropagation());

    const msg = document.createElement("p");
    msg.id = "stratum-session-ended-msg";
    msg.style.cssText = [
      "margin:0 0 1.15rem",
      "font-family:'M5x7',monospace",
      "font-size:20px",
      "line-height:1.5",
      "color:#f2f2f7",
    ].join(";");

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.textContent = "Return to main menu";
    backBtn.style.cssText = [
      "padding:11px 18px",
      "font-family:'BoldPixels',monospace",
      "font-size:17px",
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

    const death = document.createElement("div");
    death.className = "stratum-death-overlay";
    death.setAttribute("aria-hidden", "true");
    death.setAttribute("role", "dialog");
    death.setAttribute("aria-modal", "true");
    death.setAttribute("aria-labelledby", "stratum-death-title");

    const deathCard = document.createElement("div");
    deathCard.className = "stratum-session-card";
    deathCard.addEventListener("click", (e) => e.stopPropagation());

    const deathTitle = document.createElement("h2");
    deathTitle.id = "stratum-death-title";
    deathTitle.textContent = "You died";
    deathTitle.style.cssText = [
      "margin:0 0 0.65rem",
      "font-family:'BoldPixels',monospace",
      "font-size:22px",
      "font-weight:normal",
      "text-transform:uppercase",
      "letter-spacing:0.06em",
      "color:#f2f2f7",
    ].join(";");

    const deathMsg = document.createElement("p");
    deathMsg.style.cssText = [
      "margin:0 0 1.25rem",
      "font-family:'M5x7',monospace",
      "font-size:18px",
      "line-height:1.45",
      "color:#c7c7cc",
    ].join(";");
    deathMsg.textContent = "Respawn at world spawn or return to the main menu.";

    const deathActions = document.createElement("div");
    deathActions.style.cssText =
      "display:flex;flex-wrap:wrap;gap:10px;justify-content:center;";

    const respawnBtn = document.createElement("button");
    respawnBtn.type = "button";
    respawnBtn.textContent = "Respawn";
    respawnBtn.style.cssText = [
      "padding:11px 18px",
      "font-family:'BoldPixels',monospace",
      "font-size:17px",
      "text-transform:uppercase",
      "letter-spacing:0.06em",
      "cursor:pointer",
      "border-radius:10px",
      "border:1px solid #f2f2f7",
      "background:#f2f2f7",
      "color:#1c1c1e",
    ].join(";");
    respawnBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:death-respawn" } satisfies GameEvent);
    });

    const deathMenuBtn = document.createElement("button");
    deathMenuBtn.type = "button";
    deathMenuBtn.textContent = "Main menu";
    deathMenuBtn.style.cssText = [
      "padding:11px 18px",
      "font-family:'BoldPixels',monospace",
      "font-size:17px",
      "text-transform:uppercase",
      "letter-spacing:0.06em",
      "cursor:pointer",
      "border-radius:10px",
      "border:1px solid rgba(242,242,247,0.45)",
      "background:transparent",
      "color:#f2f2f7",
    ].join(";");
    deathMenuBtn.addEventListener("click", () => {
      bus.emit({ type: "ui:quit" } satisfies GameEvent);
    });

    deathActions.appendChild(respawnBtn);
    deathActions.appendChild(deathMenuBtn);
    deathCard.appendChild(deathTitle);
    deathCard.appendChild(deathMsg);
    deathCard.appendChild(deathActions);
    death.appendChild(deathCard);
    mount.appendChild(death);
    this.deathOverlay = death;

    this.unsubSessionEnded = bus.on("ui:session-ended", (e) => {
      if (this.sessionEndedShown) {
        return;
      }
      this.sessionEndedShown = true;
      msg.textContent = e.message;
      sess.classList.add("stratum-session-overlay--open");
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

  /** Death prompt: respawn at world spawn or quit to menu. */
  setDeathOverlayOpen(open: boolean): void {
    const el = this.deathOverlay;
    if (el === null) {
      return;
    }
    el.classList.toggle("stratum-death-overlay--open", open);
    el.setAttribute("aria-hidden", open ? "false" : "true");
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
    this.deathOverlay?.remove();
    this.deathOverlay = null;
    this.pauseMenu.destroy();
    this.hud.destroy();
  }
}
