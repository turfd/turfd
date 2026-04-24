/**
 * Pre-game main menu — no Game / World imports; resolves via Promise only.
 * Visual: live PixiJS world background (MenuBackground) + pixel-art DOM overlay.
 */
import type { AudioEngine } from "../../audio/AudioEngine";
import type { IAuthProvider } from "../../auth/IAuthProvider";
import type { EventBus } from "../../core/EventBus";
import { unixRandom01 } from "../../core/unixRandom";
import type { ModRepository } from "../../mods/ModRepository";
import { mountProfileScreen } from "./ProfileScreen";
import { mountSkinScreen } from "./SkinScreen";
import type {
  IndexedDBStore,
  WorldMetadata,
} from "../../persistence/IndexedDBStore";
import { mountSettingsPanel } from "../settings/mountSettingsPanel";
import { HOST_PEER_SUFFIX_ALPHABET } from "../../network/hostPeerId";
import {
  getMyRoomRating,
  listStratumRoomComments,
  listStratumRooms,
  postStratumRoomComment,
  setStratumRoomRating,
  type ListedRoom,
} from "../../network/roomDirectoryApi";
import { createWorldPackEditorController } from "../worldEditPacksUi";
import { gunzipSync, gzipSync } from "fflate";
import { stratumCoreTextureAssetUrl } from "../../core/textureManifest";
import { MenuBackground } from "./MenuBackground";
import { runMainMenuStartupIntro } from "./mainMenuStartupIntro";
import { WorkshopScreen } from "./WorkshopScreen";

export type MainMenuResult =
  | { action: "new"; name: string; seed: number }
  | { action: "load"; uuid: string }
  | { action: "multiplayer-join"; roomCode: string; password?: string }
  | {
      action: "multiplayer-host";
      worldUuid: string;
      roomTitle: string;
      motd: string;
      isPrivate: boolean;
      roomPassword?: string;
    };

/** Returned when leaving the menu; reuse {@link menuBackground} behind the loading overlay. */
export type MainMenuExit = {
  result: MainMenuResult;
  menuBackground: MenuBackground;
};

const STRATUM_ROOM_HOST_PREFS_KEY = "stratum_room_host_prefs";
const ROOM_TITLE_MAX_LEN = 48;
const ROOM_MOTD_MAX_LEN = 280;
const ROOM_CODE_VALID = new RegExp(
  `^[${HOST_PEER_SUFFIX_ALPHABET}]{6}$`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomSixDigitSeed(): number {
  return Math.floor(unixRandom01() * 900_000) + 100_000;
}

function parseSeedInput(raw: string): number {
  const t = raw.trim();
  if (t === "") return randomSixDigitSeed();
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? Math.floor(unixRandom01() * 999_999) : n;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return String(ts);
  }
}

function sortWorldsByLastPlayed(a: WorldMetadata, b: WorldMetadata): number {
  return b.lastPlayedAt - a.lastPlayedAt;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const STYLES_ID = "stratum-mm2-styles";

function injectStyles(base: string): void {
  if (document.getElementById(STYLES_ID)) return;

  const fontUrl = (name: string): string =>
    `${base}assets/fonts/${name}`;

  const style = document.createElement("style");
  style.id = STYLES_ID;
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

    :root {
      /* +4px applied to M5x7 font-size rules below (bitmap font reads better ~22–26px body) */
      --mm-m5-nudge: 4px;
      --mm-ink: #f2f2f7;
      --mm-ink-mid: #aeaeb2;
      --mm-ink-soft: #8e8e93;
      --mm-surface: rgba(44, 44, 46, 0.82);
      --mm-surface-deep: rgba(36, 36, 38, 0.9);
      --mm-surface-raised: rgba(58, 58, 60, 0.92);
      --mm-border: rgba(255, 255, 255, 0.1);
      --mm-border-strong: rgba(255, 255, 255, 0.16);
      --mm-danger: #ff453a;
      --mm-radius-sm: 10px;
      --mm-radius-md: 14px;
      --mm-radius-lg: 18px;
    }

    /* -- Root overlay (no tint so in-game sky colors are exact) ---------- */
    .mm-root {
      position: fixed; inset: 0;
      z-index: 10;
      display: flex;
      flex-direction: column;
      pointer-events: none;
      font-family: 'BoldPixels', 'Courier New', monospace;
      font-weight: normal;
      font-synthesis: none;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeSpeed;
      color: var(--mm-ink);
      background: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    /* -- Top bar ---------------------------------------------------------- */
    .mm-topbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: 0.75rem 1.25rem 0;
      pointer-events: none;
    }
    .mm-discord {
      pointer-events: auto;
      padding: 0.55rem 1.05rem;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .mm-discord:hover {
      background: var(--mm-surface-raised);
      border-color: var(--mm-border-strong);
      color: var(--mm-ink);
    }
    .mm-discord:active { opacity: 0.92; }

    /* -- Body: nav + main column (tabs use full remaining width/height) -- */
    .mm-body {
      --mm-edge: clamp(1.25rem, 4vw, 2rem);
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: stretch;
      justify-content: flex-start;
      padding: 0.65rem var(--mm-edge) var(--mm-edge);
      gap: 1.25rem;
      pointer-events: none;
    }
    .mm-body-home {
      justify-content: flex-start;
    }

    /* -- Nav column ------------------------------------------------------- */
    .mm-nav {
      width: min(260px, 30vw);
      min-width: 220px;
      flex-shrink: 0;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      border-radius: var(--mm-radius-lg);
      corner-shape: squircle;
      background: var(--mm-surface);
      border: 1px solid var(--mm-border);
    }
    .mm-brand {
      border: none;
      border-radius: 0;
      padding: 2px 0 10px;
      background: transparent;
    }
    .mm-brand-logo {
      display: block;
      width: 100%;
      height: auto;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-brand-kicker {
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge));
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--mm-ink-soft);
    }
    .mm-brand-title {
      margin: 6px 0 2px;
      font-size: clamp(32px, 5vw, 48px);
      line-height: 0.95;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mm-ink);
    }
    .mm-brand-subtitle {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      line-height: 1.4;
      color: var(--mm-ink-mid);
    }
    .mm-nav-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .mm-nav-btn {
      display: block;
      width: 100%;
      padding: 14px 16px;
      background: var(--mm-surface-deep);
      border: 1px solid transparent;
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 20px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: left;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: border-color 130ms ease, background 130ms ease, color 130ms ease;
    }
    .mm-nav-btn:hover:not(.mm-nav-btn-disabled) {
      background: var(--mm-surface-raised);
      border-color: var(--mm-border);
      color: var(--mm-ink);
    }
    .mm-nav-btn:focus-visible:not(.mm-nav-btn-disabled) {
      outline: none;
      border-color: var(--mm-border-strong);
    }
    .mm-nav-btn-active {
      background: var(--mm-surface-raised) !important;
      border-color: var(--mm-border-strong) !important;
      color: var(--mm-ink) !important;
    }
    .mm-nav-btn-disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }
    .mm-nav-label-sub {
      display: block;
      margin-top: 3px;
      font-size: calc(14px + var(--mm-m5-nudge));
      letter-spacing: 0.06em;
      opacity: 0.7;
      font-family: 'M5x7', monospace;
    }
    .mm-nav-meta {
      margin-top: auto;
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-soft);
      border-top: 1px solid var(--mm-border);
      padding-top: 12px;
    }

    /* -- Content: full main column; home pins changelog bottom-right ------ */
    .mm-content {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      pointer-events: auto;
      align-items: stretch;
    }
    .mm-content-home {
      justify-content: flex-end;
      align-items: flex-end;
    }
    .mm-content-tab {
      justify-content: flex-start;
      align-items: stretch;
    }
    .mm-content-tab > .mm-panel {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    @keyframes mm-content-out {
      from {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      to {
        opacity: 0;
        transform: translateY(-10px) scale(0.988);
      }
    }
    @keyframes mm-content-in {
      from {
        opacity: 0;
        transform: translateY(14px) scale(0.985);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    .mm-content.mm-content-exit {
      animation: mm-content-out 0.18s cubic-bezier(0.4, 0, 1, 1) forwards;
      pointer-events: none;
    }
    .mm-content.mm-content-enter {
      animation: mm-content-in 0.34s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      pointer-events: none;
    }
    .mm-root.mm-root--content-transition .mm-nav {
      pointer-events: none;
    }

    /* -- Generic panel ---------------------------------------------------- */
    .mm-panel {
      background: var(--mm-surface);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      padding: 1.35rem 1.5rem;
      box-sizing: border-box;
    }
    .mm-panel-title {
      font-family: 'BoldPixels', monospace;
      font-size: clamp(22px, 2.6vw, 28px);
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--mm-ink);
      margin: 0 0 1.1rem;
      line-height: 1.15;
    }

    /* ── What's New: home = compact card, bottom-right of main column ----- */
    .mm-whats-new {
      min-width: 0;
      overflow-y: auto;
    }
    .mm-content-home .mm-whats-new.mm-home-changelog {
      flex: 0 0 auto;
      width: min(560px, 100%);
      margin-top: auto;
    }
    .mm-home-changelog {
      width: 100%;
    }
    .mm-home-changelog-card {
      display: flex;
      flex-direction: column;
      min-height: 0;
      max-height: min(42vh, 280px);
      overflow: hidden;
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      background: var(--mm-surface-deep);
    }
    .mm-home-changelog-copy {
      padding: 14px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .mm-home-changelog-media {
      display: none;
    }
    .mm-home-changelog-kicker {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--mm-ink-soft);
    }
    .mm-home-changelog-title {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 20px;
      line-height: 1.2;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mm-ink);
    }
    .mm-home-changelog-cta {
      align-self: flex-start;
      margin-top: 4px;
      padding: 10px 16px;
      font-size: 15px;
      letter-spacing: 0.06em;
      min-height: 0;
    }
    .mm-whats-new::-webkit-scrollbar { width: 4px; }
    .mm-whats-new::-webkit-scrollbar-track { background: transparent; }
    .mm-whats-new::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-whats-new-body {
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-mid);
      margin: 0;
      overflow-wrap: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .mm-whats-new-body strong {
      font-family: 'BoldPixels', monospace;
      font-size: 17px;
      color: var(--mm-ink);
      display: block;
      margin-top: 12px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .mm-whats-new-body strong:first-child { margin-top: 0; }

    /* ── World list (SOLO view) ────────────────────── */
    .mm-solo-panel {
      width: 100%;
      min-width: 0;
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .mm-worldlist {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      margin-bottom: 1rem;
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      background: var(--mm-surface-deep);
    }
    .mm-worldlist::-webkit-scrollbar { width: 4px; }
    .mm-worldlist::-webkit-scrollbar-track { background: transparent; }
    .mm-worldlist::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-world-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--mm-border);
      cursor: pointer;
      transition: background 120ms ease;
    }
    .mm-world-row:last-child { border-bottom: none; }
    .mm-world-row:hover { background: rgba(255, 255, 255, 0.04); }
    .mm-world-row:active { background: rgba(255, 255, 255, 0.06); }
    .mm-world-thumb {
      width: 88px;
      height: 56px;
      flex-shrink: 0;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--mm-border);
    }
    .mm-world-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .mm-world-thumb-empty {
      width: 100%;
      height: 100%;
      background: linear-gradient(145deg, #3a3a3c, #2c2c2e);
    }
    .mm-world-info { flex: 1; min-width: 0; }
    .mm-world-name {
      font-family: 'BoldPixels', monospace;
      font-size: 20px;
      color: var(--mm-ink);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mm-world-meta {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      margin-top: 4px;
      line-height: 1.3;
    }
    .mm-world-desc {
      margin-top: 6px;
      font-family: 'M5x7', monospace;
      font-size: calc(16px + var(--mm-m5-nudge));
      line-height: 1.4;
      color: var(--mm-ink-mid);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .mm-world-edit {
      padding: 10px 18px;
      background: var(--mm-surface-raised);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      flex-shrink: 0;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .mm-world-edit:hover {
      background: rgba(72, 72, 74, 0.95);
      border-color: var(--mm-border-strong);
      color: var(--mm-ink);
    }
    .mm-world-empty {
      padding: 2rem 1.25rem;
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      text-align: center;
      line-height: 1.45;
    }
    /* Host-world picker modal: same scroll + thumb behavior as Solo */
    .mm-host-world-modal-card {
      display: flex;
      flex-direction: column;
      max-height: min(88vh, 720px);
      min-height: 0;
    }
    .mm-host-world-modal-card .mm-worldlist {
      flex: 1;
      min-height: 140px;
      max-height: none;
      margin-bottom: 0;
    }
    .mm-host-world-modal-card .mm-modal-actions {
      margin-top: 12px;
      flex-shrink: 0;
    }
    .mm-host-world-editor-card {
      display: flex;
      flex-direction: column;
      max-height: min(92vh, 820px);
      min-height: 0;
      padding: 0;
      overflow: hidden;
    }
    .mm-host-world-editor-card .mm-bedrock-world-shell {
      flex: 1;
      min-height: min(560px, 78vh);
    }
    .mm-bedrock-world-section-subtitle {
      margin: 18px 0 8px;
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--mm-ink-soft);
    }
    .mm-solo-footer {
      display: flex;
      justify-content: flex-start;
      flex-shrink: 0;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .mm-import-feedback {
      font-family: 'M5x7', monospace;
      font-size: calc(16px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
      margin: 0 0 10px;
      min-height: 1.25em;
      line-height: 1.35;
    }
    .mm-import-feedback--error {
      color: #ff6b6b;
    }

    /* ── Action buttons ───────────────────────────── */
    .mm-btn {
      box-sizing: border-box;
      padding: 14px 22px;
      min-height: 44px;
      background: var(--mm-ink);
      border: 1px solid var(--mm-ink);
      color: #1c1c1e;
      font-family: 'BoldPixels', monospace;
      font-size: 17px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: opacity 120ms ease, background 120ms ease;
    }
    .mm-btn:hover { opacity: 0.92; }
    .mm-btn:active { opacity: 0.85; }
    .mm-btn:focus-visible {
      outline: none;
      border-color: var(--mm-border-strong);
    }
    .mm-btn-subtle {
      background: var(--mm-surface-deep);
      border-color: var(--mm-border);
      color: var(--mm-ink-mid);
    }
    .mm-btn-subtle:hover {
      background: var(--mm-surface-raised);
      color: var(--mm-ink);
      opacity: 1;
    }
    .mm-btn-danger {
      background: rgba(255, 69, 58, 0.2);
      border-color: rgba(255, 69, 58, 0.45);
      color: #ff6b6b;
    }
    .mm-btn-danger:hover {
      background: rgba(255, 69, 58, 0.28);
      opacity: 1;
    }
    .mm-btn.mm-btn-danger {
      padding: 14px 22px;
      min-height: 48px;
      font-size: 17px;
    }
    .mm-btn.mm-bedrock-pack-remove,
    .mm-btn.mm-bedrock-pack-add {
      padding: 10px 18px;
      font-size: 16px;
      min-height: 44px;
    }

    /* ── Fields ───────────────────────────────────── */
    .mm-field { margin-bottom: 14px; }
    .mm-field label {
      display: block;
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--mm-ink-soft);
      margin-bottom: 6px;
    }
    .mm-field input[type="text"],
    .mm-field input[type="search"],
    .mm-field input[type="number"],
    .mm-field input[type="email"],
    .mm-field input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 14px 16px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: calc(21px + var(--mm-m5-nudge));
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: border-color 0.14s ease;
    }
    .mm-field input[type="text"]:focus,
    .mm-field input[type="search"]:focus,
    .mm-field input[type="number"]:focus,
    .mm-field input[type="email"]:focus,
    .mm-field input[type="password"]:focus {
      outline: none;
      border-color: var(--mm-border-strong);
    }
    .mm-field input::placeholder { color: var(--mm-ink-soft); opacity: 0.7; }
    .mm-field input[type="range"] {
      width: 100%;
      accent-color: #aeaeb2;
      cursor: pointer;
    }
    .mm-field + .mm-btn { margin-top: 10px; }
    .mm-note {
      margin: 0 0 1rem;
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      line-height: 1.5;
      color: var(--mm-ink-mid);
    }
    .mm-field textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 88px;
      padding: 14px 16px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: calc(21px + var(--mm-m5-nudge));
      line-height: 1.4;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      resize: vertical;
      transition: border-color 0.14s ease;
    }
    .mm-field textarea:focus {
      outline: none;
      border-color: var(--mm-border-strong);
    }
    .mm-field textarea::placeholder {
      color: var(--mm-ink-soft);
      opacity: 0.7;
    }

    /* ── Workshop (Stratum menu aesthetic; no native select styling) ───────── */
    .mm-workshop-root {
      /* Workshop-only spacing tokens (pixel-perfect: whole px only) */
      --ws-1: 4px;
      --ws-2: 8px;
      --ws-3: 12px;
      --ws-4: 16px;
      --ws-5: 24px;
      --ws-6: 32px;

      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--ws-3);
      font-family: 'M5x7', monospace;
      color: var(--mm-ink);
      -webkit-font-smoothing: none;
    }
    .mm-workshop-root .mm-panel-title {
      margin-bottom: 0.35rem;
    }
    .mm-workshop-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ws-1);
    }
    .mm-workshop-tab {
      padding: 12px 16px;
      background: var(--mm-surface-deep);
      border: 1px solid transparent;
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 16px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: border-color 130ms ease, background 130ms ease, color 130ms ease;
    }
    .mm-workshop-tab:hover:not(:disabled) {
      background: var(--mm-surface-raised);
      border-color: var(--mm-border);
      color: var(--mm-ink);
    }
    .mm-workshop-tab-active {
      background: var(--mm-surface-raised) !important;
      border-color: var(--mm-border-strong) !important;
      color: var(--mm-ink) !important;
    }
    .mm-workshop-tab:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }
    .mm-workshop-tab-secondary {
      padding: 8px 12px;
      font-size: 13px;
      background: transparent;
      border: 1px dashed var(--mm-border);
      color: var(--mm-ink-soft);
    }
    .mm-workshop-tab-secondary:hover:not(:disabled) {
      background: var(--mm-surface-deep);
      border-style: solid;
      color: var(--mm-ink-mid);
    }
    .mm-workshop-tab-secondary.mm-workshop-tab-active {
      border-style: solid !important;
      border-color: var(--mm-border-strong) !important;
      color: var(--mm-ink) !important;
      background: var(--mm-surface-raised) !important;
    }
    .mm-workshop-root--mod-detail .mm-workshop-tab.mm-workshop-tab-active {
      box-shadow: inset 0 0 0 1px rgba(46, 204, 113, 0.35);
    }
    .mm-workshop-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding-right: var(--ws-1);
    }
    .mm-workshop-body::-webkit-scrollbar {
      width: 4px;
    }
    .mm-workshop-body::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-workshop-body:has(.mm-workshop-browser) {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding-right: 2px;
    }
    .mm-workshop-browser {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      flex: 1;
      min-height: 0;
    }
    .mm-workshop-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--ws-2);
      min-height: 0;
    }
    .mm-workshop-filter-strip {
      display: flex;
      flex-direction: column;
      gap: var(--ws-2);
      flex-shrink: 0;
      padding: var(--ws-3) var(--ws-3);
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: border-color 120ms ease;
    }
    .mm-workshop-controls-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--ws-2) var(--ws-3);
    }
    .mm-workshop-controls-bottom {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--ws-2);
    }
    .mm-workshop-type-pills {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ws-1);
    }
    .mm-workshop-sort-pills {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--ws-1);
      margin-left: auto;
    }
    .mm-workshop-sort-pills::before {
      content: "Sort";
      font-family: 'BoldPixels', monospace;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mm-ink-soft);
      margin-right: 2px;
      padding-right: 4px;
    }
    .mm-workshop-sort-pill {
      box-sizing: border-box;
      margin: 0;
      padding: 8px 14px;
      background: var(--mm-surface-raised);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: 999px;
      corner-shape: squircle;
      transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
      -webkit-appearance: none;
      appearance: none;
    }
    .mm-workshop-sort-pill:not(.mm-workshop-sort-pill-active):hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: var(--mm-border-strong);
      color: var(--mm-ink);
    }
    .mm-workshop-sort-pill-active {
      border-color: rgba(46, 204, 113, 0.55);
      background: rgba(46, 204, 113, 0.16);
      color: #b8f5c8;
    }
    .mm-workshop-sort-pill-active:hover {
      background: rgba(46, 204, 113, 0.24);
      border-color: rgba(46, 204, 113, 0.72);
      color: #d8f8e0;
    }
    .mm-workshop-type-pill {
      box-sizing: border-box;
      margin: 0;
      padding: 8px 14px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: 999px;
      corner-shape: squircle;
      transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
      -webkit-appearance: none;
      appearance: none;
    }
    .mm-workshop-type-pill:not(.mm-workshop-type-pill-active):hover {
      background: var(--mm-surface-raised);
      border-color: var(--mm-border-strong);
      color: var(--mm-ink);
    }
    .mm-workshop-type-pill-active {
      border-color: rgba(46, 204, 113, 0.55);
      background: rgba(46, 204, 113, 0.16);
      color: #b8f5c8;
    }
    .mm-workshop-type-pill-active:hover {
      background: rgba(46, 204, 113, 0.24);
      border-color: rgba(46, 204, 113, 0.72);
      color: #d8f8e0;
    }
    .mm-workshop-filter-strip .mm-workshop-type-pill:not(.mm-workshop-type-pill-active) {
      background: var(--mm-surface-raised);
    }
    .mm-workshop-search-wrap {
      display: flex;
      align-items: center;
      gap: var(--ws-2);
      padding: 0 var(--ws-2);
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid var(--mm-border-strong);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: border-color 120ms ease, background 120ms ease;
      flex: 1;
      min-width: min(320px, 100%);
    }
    .mm-workshop-search-wrap:focus-within {
      border-color: var(--mm-border-strong);
      background: rgba(0, 0, 0, 0.28);
    }
    .mm-workshop-search-icon {
      flex-shrink: 0;
      font-size: 20px;
      line-height: 1;
      color: var(--mm-ink-soft);
      opacity: 0.85;
    }
    .mm-workshop-search-input {
      flex: 1;
      min-width: 0;
      padding: 10px 0;
      background: transparent;
      border: 0;
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--mm-m5-nudge));
      outline: none;
    }
    .mm-workshop-search-input::placeholder {
      color: var(--mm-ink-soft);
      opacity: 0.75;
    }
    .mm-workshop-list-status {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-mid);
      min-height: 1.35em;
    }
    .mm-workshop-list-status[hidden] {
      display: none !important;
    }
    .mm-workshop-grid-host {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: 0;
      padding-right: var(--ws-1);
    }
    .mm-workshop-grid-host::-webkit-scrollbar {
      width: 4px;
    }
    .mm-workshop-grid-host::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-workshop-list {
      display: flex;
      flex-direction: column;
      gap: var(--ws-2);
    }

    .mm-workshop-tile-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: var(--ws-3);
      align-items: stretch;
      /* Prevent grid tracks (and cards) from stretching vertically. */
      align-content: start;
    }
    .mm-workshop-tile {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background: var(--mm-surface-deep);
      cursor: pointer;
      text-align: left;
      transition: border-color 140ms ease, background 140ms ease;
      overflow: hidden;
    }
    .mm-workshop-tile:hover {
      border-color: var(--mm-border-strong);
      background: var(--mm-surface-raised);
    }
    .mm-workshop-tile:focus {
      outline: none;
    }
    .mm-workshop-tile:focus-visible {
      outline: 2px solid rgba(46, 204, 113, 0.65);
      outline-offset: 2px;
    }
    .mm-workshop-tile-media {
      width: 100%;
      aspect-ratio: 16 / 9;
      background: #1c1c1e;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-workshop-tile-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-workshop-tile-body {
      display: flex;
      flex-direction: column;
      gap: var(--ws-1);
      padding: var(--ws-3);
      min-height: 0;
    }
    .mm-workshop-tile-title {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      line-height: 1.25;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mm-ink);
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mm-workshop-tile-author {
      margin: 0;
      font-size: calc(16px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-mid);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mm-workshop-tile-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ws-1) var(--ws-2);
      align-items: center;
      margin-top: var(--ws-1);
    }
    .mm-workshop-tile-meta-line {
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-mid);
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mm-workshop-tile-actions {
      margin-top: var(--ws-2);
      display: flex;
      gap: var(--ws-2);
      align-items: center;
    }
    .mm-workshop-tile-install {
      width: 100%;
      min-width: 0;
      padding: 10px 16px !important;
      font-size: 13px !important;
      min-height: 42px !important;
      transition: opacity 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .mm-workshop-rowcard {
      display: flex;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 14px;
      padding: 12px 14px;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background: var(--mm-surface-deep);
      cursor: pointer;
      text-align: left;
      transition: border-color 140ms ease, background 140ms ease;
    }
    .mm-workshop-rowcard:hover {
      border-color: var(--mm-border-strong);
      background: var(--mm-surface-raised);
    }
    .mm-workshop-rowcard:focus {
      outline: none;
    }
    .mm-workshop-rowcard:focus-visible {
      outline: 2px solid rgba(46, 204, 113, 0.65);
      outline-offset: 2px;
    }
    .mm-workshop-rowcard-icon {
      flex-shrink: 0;
      width: 72px;
      height: 72px;
      border-radius: 10px;
      overflow: hidden;
      background: #1c1c1e;
      border: 1px solid var(--mm-border);
    }
    .mm-workshop-rowcard-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-workshop-rowcard-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mm-workshop-rowcard-title-row {
      margin: 0;
    }
    .mm-workshop-rowcard-title {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      line-height: 1.25;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mm-ink);
      margin: 0;
    }
    .mm-workshop-rowcard-author {
      margin: 0;
      font-size: calc(16px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-mid);
    }
    .mm-workshop-rowcard-tags {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
    }
    .mm-workshop-rowcard-tags .mm-workshop-badge {
      align-self: center;
    }
    .mm-workshop-rowcard-aside {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      justify-content: center;
      gap: 10px;
      min-width: 6.5rem;
      max-width: min(12rem, 40%);
      text-align: right;
    }
    .mm-workshop-rowcard-meta {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge));
      line-height: 1.4;
      color: var(--mm-ink-mid);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .mm-workshop-rowcard-install {
      box-sizing: border-box;
      margin: 0;
      padding: 10px 16px !important;
      font-size: 13px !important;
      min-height: 42px !important;
      min-width: 6.5rem;
      flex-shrink: 0;
      transition: opacity 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .mm-workshop-rowcard-install:not(:disabled):hover {
      opacity: 0.95;
    }
    .mm-workshop-card-stars {
      display: inline-flex;
      gap: 2px;
      font-size: 14px;
      line-height: 1;
      letter-spacing: 0.02em;
    }
    .mm-workshop-card-star-on {
      color: #ffd60a;
    }
    .mm-workshop-card-star-off {
      color: var(--mm-ink-soft);
      opacity: 0.45;
    }
    .mm-workshop-badge {
      display: inline-block;
      font-family: 'BoldPixels', monospace;
      font-size: 10px;
      padding: 4px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .mm-workshop-badge-behavior_pack {
      background: rgba(10, 132, 255, 0.22);
      color: #7ecbff;
      border: 1px solid rgba(10, 132, 255, 0.35);
    }
    .mm-workshop-badge-resource_pack {
      background: rgba(52, 199, 89, 0.2);
      color: #9ee6a8;
      border: 1px solid rgba(52, 199, 89, 0.32);
    }
    .mm-workshop-pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--ws-2);
      margin-top: auto;
      padding: var(--ws-3) var(--ws-3);
      border-top: 1px solid var(--mm-border);
      background: rgba(0, 0, 0, 0.12);
      border-radius: 0 0 var(--mm-radius-sm) var(--mm-radius-sm);
      flex-shrink: 0;
    }
    .mm-workshop-pager-indicator {
      font-family: 'BoldPixels', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mm-ink-soft);
      padding: 0 var(--ws-1);
    }
    .mm-workshop-pager-btn {
      min-width: 7rem;
      padding: 12px 18px !important;
      min-height: 44px !important;
      font-size: 14px !important;
    }
    @media (max-width: 780px) {
      .mm-workshop-sort-pills {
        margin-left: 0;
        width: 100%;
      }
      .mm-workshop-rowcard {
        flex-wrap: wrap;
      }
      .mm-workshop-rowcard-aside {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        max-width: none;
        min-width: 0;
        text-align: left;
        border-top: 1px solid var(--mm-border);
        padding-top: 10px;
        margin-top: 4px;
      }
      .mm-workshop-rowcard-meta {
        white-space: normal;
        text-align: left;
        flex: 1;
        min-width: 0;
      }
      .mm-workshop-rowcard-install {
        margin-left: auto;
      }
      .mm-workshop-detail-columns {
        grid-template-columns: 1fr;
      }
      .mm-workshop-detail-side {
        order: -1;
      }
      .mm-workshop-detail-hero {
        grid-template-columns: 1fr;
      }
      .mm-workshop-detail-hero-cover {
        aspect-ratio: 16 / 9;
      }
      .mm-workshop-detail-banner-inner {
        flex-direction: column;
        align-items: flex-start;
      }
      .mm-workshop-detail-banner-icon {
        width: min(88px, 22vw);
        height: min(88px, 22vw);
      }
    }
    .mm-workshop-detail-page {
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: 100%;
      max-width: none;
      min-height: 0;
    }
    .mm-workshop-detail-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
    }
    .mm-workshop-detail-toolbar-context {
      font-family: 'BoldPixels', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-detail-back {
      flex-shrink: 0;
    }

    /* Detail hero (side-by-side: cover + info) */
    .mm-workshop-detail-hero {
      display: grid;
      grid-template-columns: minmax(160px, 260px) minmax(0, 1fr);
      gap: var(--ws-4);
      align-items: stretch;
      padding: var(--ws-4);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(0, 0, 0, 0.18));
    }
    .mm-workshop-detail-hero-cover {
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      overflow: hidden;
      background: #1c1c1e;
      border: 1px solid var(--mm-border);
      aspect-ratio: 16 / 11;
    }
    .mm-workshop-detail-hero-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-workshop-detail-hero-ph {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'BoldPixels', monospace;
      font-size: 34px;
      line-height: 1;
      color: rgba(46, 204, 113, 0.55);
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.06), rgba(0, 0, 0, 0.2));
    }
    .mm-workshop-detail-hero-ph::before {
      content: "◇";
      opacity: 0.85;
    }
    .mm-workshop-detail-hero-info {
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: var(--ws-2);
      padding: 2px 0;
    }
    .mm-workshop-detail-hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ws-1) var(--ws-2);
      align-items: center;
      margin-top: var(--ws-1);
    }
    .mm-workshop-detail-hero-stat {
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge));
      line-height: 1.3;
      color: var(--mm-ink-mid);
    }
    .mm-workshop-detail-banner {
      position: relative;
      overflow: hidden;
      min-height: clamp(132px, 22vw, 200px);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background:
        linear-gradient(135deg, var(--mm-surface-deep) 0%, rgba(30, 30, 34, 0.98) 48%, rgba(18, 52, 38, 0.35) 100%);
      background-size: cover;
      background-position: center;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .mm-workshop-detail-banner--has-cover {
      background-color: #121214;
    }
    .mm-workshop-detail-banner-scrim {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        rgba(10, 10, 12, 0.92) 0%,
        rgba(10, 10, 12, 0.78) 42%,
        rgba(10, 10, 12, 0.55) 72%,
        rgba(10, 10, 12, 0.35) 100%
      );
      pointer-events: none;
    }
    .mm-workshop-detail-banner-inner {
      position: relative;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 1rem 1.35rem;
      padding: 16px 18px 18px;
      min-height: clamp(132px, 22vw, 200px);
      box-sizing: border-box;
    }
    .mm-workshop-detail-banner-icon {
      flex-shrink: 0;
      width: clamp(88px, 14vw, 120px);
      height: clamp(88px, 14vw, 120px);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(0, 0, 0, 0.35);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
      overflow: hidden;
    }
    .mm-workshop-detail-banner-icon-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-workshop-detail-banner-icon-ph {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'BoldPixels', monospace;
      font-size: clamp(28px, 8vw, 40px);
      line-height: 1;
      color: rgba(46, 204, 113, 0.55);
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.06), rgba(0, 0, 0, 0.2));
    }
    .mm-workshop-detail-banner-icon-ph::before {
      content: "◇";
      opacity: 0.85;
    }
    .mm-workshop-detail-banner-text {
      flex: 1;
      min-width: min(100%, 200px);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .mm-workshop-detail-banner .mm-workshop-detail-name {
      color: #f2f2f7;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
    }
    .mm-workshop-detail-banner .mm-workshop-detail-author {
      color: rgba(235, 235, 245, 0.72);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    }
    .mm-workshop-detail-banner-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      margin-top: 4px;
    }
    .mm-workshop-detail-banner-meta .mm-workshop-badge {
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
    }
    .mm-workshop-detail-banner-stat {
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge));
      line-height: 1.3;
      color: rgba(235, 235, 245, 0.78);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    }
    .mm-workshop-detail-columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) min(300px, 32vw);
      gap: 20px 24px;
      align-items: start;
    }
    .mm-workshop-detail-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 4px 2px 8px;
    }
    .mm-workshop-detail-section-title {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mm-ink-soft);
      padding-bottom: 8px;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-workshop-detail-comments-count {
      color: var(--mm-ink-mid);
      font-weight: normal;
    }
    .mm-workshop-detail-comments-section {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .mm-workshop-detail-comments-section .mm-workshop-comment-list {
      margin-top: 4px;
    }
    .mm-workshop-detail-comments-section .mm-workshop-comment:first-child {
      padding-top: 6px;
    }
    .mm-workshop-detail-side {
      min-width: 0;
    }
    .mm-workshop-detail-side-card {
      position: sticky;
      top: 6px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px 16px 18px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .mm-workshop-detail-meta-list {
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px 12px;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge));
      line-height: 1.35;
    }
    .mm-workshop-detail-meta-term {
      margin: 0;
      color: var(--mm-ink-soft);
      font-weight: normal;
    }
    .mm-workshop-detail-meta-def {
      margin: 0;
      color: var(--mm-ink-mid);
      word-break: break-word;
    }
    .mm-workshop-detail-name {
      font-family: 'BoldPixels', monospace;
      font-size: clamp(18px, 2.4vw, 26px);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0;
      color: var(--mm-ink);
      line-height: 1.15;
    }
    .mm-workshop-detail-author {
      margin: 0;
      font-size: calc(16px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-detail-desc {
      margin: 0;
      font-size: calc(17px + var(--mm-m5-nudge));
      line-height: 1.55;
      color: var(--mm-ink-mid);
      max-width: none;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: break-word;
    }

    .mm-workshop-detail-about-card {
      padding: var(--ws-3) var(--ws-3) var(--ws-4);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background: rgba(0, 0, 0, 0.12);
    }
    .mm-workshop-detail-about-card .mm-workshop-detail-section-title {
      margin-bottom: var(--ws-2);
    }

    .mm-workshop-comment-compose .mm-field {
      margin-bottom: var(--ws-2);
    }
    .mm-workshop-comment-compose textarea {
      resize: none;
      overflow: hidden;
      min-height: 64px;
    }
    .mm-workshop-detail-actions {
      display: flex;
      flex-direction: column;
      flex-wrap: nowrap;
      gap: 10px;
      margin-top: 0;
    }
    .mm-workshop-detail-actions .mm-btn {
      width: 100%;
      justify-content: center;
      box-sizing: border-box;
    }
    .mm-workshop-detail-install {
      min-width: 0;
      width: 100%;
      padding: 14px 22px !important;
    }
    .mm-workshop-detail-uninstall {
      min-width: 0;
      width: 100%;
    }
    .mm-workshop-rowcard-install.mm-btn,
    .mm-workshop-detail-actions .mm-btn,
    .mm-workshop-library-action-btn.mm-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0;
    }
    /* The hidden attribute only applies display:none in UA rules; do not override it here. */
    .mm-workshop-btn-content--idle:not([hidden]) {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .mm-workshop-btn-content--busy:not([hidden]) {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: 'M5x7', monospace;
      font-size: calc(13px + var(--mm-m5-nudge));
      text-transform: none;
      letter-spacing: normal;
      line-height: 1.2;
    }
    .mm-workshop-btn-content--idle[hidden],
    .mm-workshop-btn-content--busy[hidden] {
      display: none !important;
    }
    .mm-workshop-detail-actions .mm-workshop-btn-content--busy:not([hidden]) {
      width: 100%;
    }
    .mm-workshop-spinner--btn {
      width: 18px;
      height: 18px;
      border-width: 2px;
      flex-shrink: 0;
    }
    .mm-workshop-btn--working {
      cursor: wait;
    }
    .mm-workshop-btn--working:hover {
      opacity: 1;
    }
    .mm-workshop-action-feedback {
      margin: 0 0 12px;
      min-height: 1.35em;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge));
      line-height: 1.4;
      color: rgba(52, 199, 89, 0.95);
    }
    .mm-workshop-action-feedback[hidden] {
      display: none !important;
    }
    .mm-workshop-detail-rate {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      padding-top: 12px;
      margin-top: 0;
      border-top: 1px solid var(--mm-border);
    }
    .mm-workshop-detail-rate-label {
      font-family: 'BoldPixels', monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-detail-rate .mm-workshop-stars {
      margin-bottom: 0;
    }
    .mm-workshop-stars {
      display: flex;
      gap: 3px;
      margin-bottom: 8px;
    }
    .mm-workshop-star {
      width: 32px;
      height: 32px;
      min-height: 0;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: #ffd60a;
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .mm-workshop-star:hover:not(:disabled) {
      background: var(--mm-surface-raised);
      border-color: var(--mm-border-strong);
    }
    .mm-workshop-star:disabled {
      opacity: 0.35;
      cursor: not-allowed;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-comments {
      margin-top: 1rem;
      padding-top: 0;
      border-top: none;
    }
    .mm-workshop-comments-summary {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
      margin: 0;
      padding: 10px 0;
      cursor: pointer;
      list-style: none;
      user-select: none;
      border-top: 1px solid var(--mm-border);
    }
    .mm-workshop-comments-summary::-webkit-details-marker {
      display: none;
    }
    .mm-workshop-comments-summary:hover {
      color: var(--mm-ink-mid);
    }
    .mm-workshop-comments-summary:focus-visible {
      outline: 2px solid rgba(46, 204, 113, 0.55);
      outline-offset: 2px;
      border-radius: var(--mm-radius-sm);
    }
    .mm-workshop-comments-inner {
      padding-bottom: 4px;
    }
    .mm-workshop-comment {
      padding: 10px 0;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-workshop-comment-head {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--mm-ink-soft);
      margin-bottom: 6px;
    }
    .mm-workshop-comment-body {
      font-size: calc(18px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-mid);
    }
    .mm-workshop-comment-compose {
      margin-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      align-items: flex-start;
    }
    .mm-workshop-comment-compose .mm-field {
      width: 100%;
      margin-bottom: 0;
    }
    .mm-workshop-owned {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .mm-workshop-owned-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      padding: 12px 0;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-workshop-owned-label {
      flex: 1;
      min-width: 160px;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
      line-height: 1.35;
    }
    .mm-workshop-owned-label strong {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--mm-ink);
      display: block;
      margin-bottom: 4px;
    }
    .mm-workshop-owned-aside {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .mm-workshop-library-intro {
      margin-bottom: 12px;
      max-width: 32rem;
    }
    .mm-workshop-library-lead {
      margin: 0 0 8px;
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--mm-m5-nudge));
      line-height: 1.4;
      color: var(--mm-ink-mid);
    }
    .mm-workshop-library-tips {
      margin: 0;
      padding-left: 1.15rem;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-library-tips li {
      margin-bottom: 4px;
    }
    .mm-workshop-library-toolbar {
      margin-bottom: 10px;
    }
    .mm-workshop-library-heading {
      margin: 14px 0 8px;
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-library-empty-hint {
      margin: 0 0 8px;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-library-stacks {
      margin-top: 4px;
    }
    .mm-workshop-library-well {
      min-height: 72px;
    }
    .mm-workshop-library-pack-row {
      align-items: flex-start;
      cursor: pointer;
      margin-bottom: 8px;
    }
    .mm-workshop-library-pack-row:last-child {
      margin-bottom: 0;
    }
    .mm-workshop-library-pack-row:focus-visible {
      outline: 2px solid var(--mm-ink-mid);
      outline-offset: 2px;
    }
    .mm-workshop-library-pack-icon-wrap {
      flex-shrink: 0;
      width: 48px;
      height: 48px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--mm-border);
      background: rgba(0, 0, 0, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .mm-workshop-library-pack-icon {
      width: 100%;
      height: 100%;
      object-fit: cover;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-workshop-library-pack-icon-ph {
      width: 22px;
      height: 22px;
      border-radius: 4px;
      background: linear-gradient(135deg, var(--mm-border-strong), var(--mm-border));
      opacity: 0.55;
    }
    .mm-workshop-library-pack-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mm-workshop-library-pack-title-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
    }
    .mm-workshop-library-pack-name {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--mm-ink);
    }
    .mm-workshop-library-pack-meta {
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge));
      line-height: 1.35;
      color: var(--mm-ink-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mm-workshop-library-pack-desc {
      margin: 0;
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-mid);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .mm-workshop-library-pack-aside {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      min-width: 112px;
    }
    .mm-workshop-upload-steps {
      margin: 0 0 6px;
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
    }
    .mm-workshop-upload-stack {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 28rem;
    }
    .mm-workshop-readonly-val {
      display: block;
      box-sizing: border-box;
      width: 100%;
      padding: 12px 14px;
      background: rgba(0, 0, 0, 0.22);
      border: 1px dashed var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      min-height: 2.5rem;
    }
    .mm-workshop-file-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .mm-workshop-file-native {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .mm-workshop-filename {
      font-family: 'M5x7', monospace;
      font-size: calc(17px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      flex: 1;
      min-width: 120px;
    }
    .mm-workshop-upload-preview-wrap {
      margin-top: 8px;
    }
    .mm-workshop-upload-preview {
      width: 112px;
      height: 112px;
      object-fit: cover;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      background: #1c1c1e;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-workshop-publish-err {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-danger);
      min-height: 1.35em;
      margin: 8px 0 0;
    }
    .mm-workshop-err {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-danger);
      margin: 0 0 10px;
    }
    .mm-workshop-loading {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: calc(19px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
    }
    .mm-workshop-spinner {
      width: 22px;
      height: 22px;
      border: 2px solid var(--mm-border);
      border-top-color: var(--mm-ink-mid);
      border-radius: 50%;
      animation: mm-workshop-spin 0.7s linear infinite;
    }
    @keyframes mm-workshop-spin {
      to {
        transform: rotate(360deg);
      }
    }
    .mm-workshop-empty {
      text-align: center;
      padding: 2.5rem 1rem;
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      line-height: 1.5;
    }
    .mm-workshop-grid-host > .mm-workshop-empty {
      text-align: left;
      padding: 2rem 0.25rem;
    }
    .mm-workshop-retry {
      margin-top: 14px;
    }

    /* ── Online / settings: fill main column with tab panel ---------------- */
    .mm-online-panel,
    .mm-settings-panel,
    .mm-profile-panel {
      width: 100%;
      max-width: 100%;
      margin-left: 0;
      flex: 1;
      min-height: 0;
    }
    .mm-feedback-error {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-danger);
      min-height: 1.25em;
      margin-top: 10px;
      line-height: 1.45;
    }

    /* ── Settings rows ───────────────────────────── */
    .mm-settings-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .mm-settings-row label {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
      width: 112px;
      flex-shrink: 0;
    }
    .mm-settings-row input[type="range"] {
      flex: 1;
      accent-color: #aeaeb2;
    }
    .mm-settings-val {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
      width: 44px;
      text-align: right;
    }
    .mm-settings-section {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--mm-ink-soft);
      margin: 1.25rem 0 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-settings-section:first-child { margin-top: 0; }
    .mm-settings-coming-soon {
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      margin-top: 4px;
      line-height: 1.45;
    }

    /* ── Modal ────────────────────────────────────── */
    @keyframes mm-modal-backdrop-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes mm-modal-card-in {
      from {
        opacity: 0;
        transform: translateY(16px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .mm-modal {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      padding: 1.25rem;
      /* .mm-root is pointer-events: none; re-enable hit-testing for the overlay + card. */
      pointer-events: auto;
      animation: mm-modal-backdrop-in 0.24s ease forwards;
    }
    .mm-modal-card {
      width: min(28rem, 100%);
      background: var(--mm-surface);
      border: 1px solid var(--mm-border-strong);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      padding: 1.45rem 1.6rem;
      animation: mm-modal-card-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    /* These use two classes so width wins over the base .mm-modal-card rule above. */
    .mm-modal-card.mm-host-world-modal-card {
      width: min(42rem, 100%);
    }
    .mm-modal-card.mm-host-world-editor-card {
      width: min(70rem, calc(100vw - 2.75rem));
      max-width: 100%;
    }
    .mm-modal-title {
      font-family: 'BoldPixels', monospace;
      font-size: clamp(22px, 2.5vw, 26px);
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--mm-ink);
      margin: 0 0 1.1rem;
      line-height: 1.15;
    }
    .mm-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 1.25rem;
    }
    .mm-modal-meta {
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      margin-bottom: 12px;
      line-height: 1.45;
    }
    .mm-modal-feedback {
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
      min-height: 1.2em;
      margin-top: 8px;
      line-height: 1.45;
    }

    /* ── Rooms (online tab) ───────────────────── */
    .mm-rooms-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-end;
      margin-bottom: 12px;
    }
    .mm-rooms-toolbar .mm-field { margin-bottom: 0; flex: 1; min-width: 140px; }
    .mm-rooms-actions { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    .mm-rooms-list {
      flex: 1;
      min-height: 180px;
      max-height: min(52vh, 420px);
      overflow-y: auto;
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      background: var(--mm-surface-deep);
    }
    .mm-rooms-list::-webkit-scrollbar { width: 4px; }
    .mm-rooms-list::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-rooms-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--mm-border);
      cursor: pointer;
      text-align: left;
      width: 100%;
      box-sizing: border-box;
      background: transparent;
      border-left: none;
      border-right: none;
      border-top: none;
      color: inherit;
      font-family: inherit;
    }
    .mm-rooms-row:last-child { border-bottom: none; }
    .mm-rooms-row:hover { background: rgba(255, 255, 255, 0.04); }
    .mm-rooms-row-title {
      font-family: 'BoldPixels', monospace;
      font-size: 17px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--mm-ink);
    }
    .mm-rooms-row-meta {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .mm-rooms-empty {
      padding: 2rem 1rem;
      text-align: center;
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      color: var(--mm-ink-soft);
      line-height: 1.45;
    }
    .mm-modal-full {
      padding: 0;
      align-items: stretch;
    }
    .mm-modal-full-card {
      width: 100%;
      height: 100%;
      max-width: none;
      border-radius: 0;
      display: flex;
      flex-direction: column;
      padding: 0;
      animation: mm-modal-card-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .mm-modal-full-header {
      flex-shrink: 0;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--mm-border);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .mm-modal-full-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 1rem 1.25rem 1.5rem;
    }
    .mm-modal-full-footer {
      flex-shrink: 0;
      padding: 1rem 1.25rem;
      border-top: 1px solid var(--mm-border);
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    /* Edit World (split layout — embedded in Solo panel, not a modal) */
    .mm-solo-panel--world-edit {
      padding: 0;
      overflow: hidden;
    }
    .mm-bedrock-world-shell {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .mm-bedrock-world-topbar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-world-edit-back.mm-btn.mm-btn-subtle {
      flex-shrink: 0;
      min-width: 52px;
      width: 52px;
      height: 52px;
      min-height: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'BoldPixels', monospace;
      font-size: 28px;
      line-height: 1;
      letter-spacing: 0;
      text-transform: none;
    }
    .mm-bedrock-world-heading {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: clamp(22px, 2.8vw, 28px);
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--mm-ink);
      line-height: 1.15;
    }
    .mm-bedrock-world-body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: row;
    }
    .mm-bedrock-world-sidebar {
      width: min(288px, 40%);
      flex-shrink: 0;
      border-right: 1px solid var(--mm-border);
      background: var(--mm-surface-deep);
      display: flex;
      flex-direction: column;
      padding: 16px;
      gap: 14px;
      overflow-y: auto;
    }
    .mm-bedrock-world-sidebar::-webkit-scrollbar {
      width: 4px;
    }
    .mm-bedrock-world-sidebar::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-bedrock-world-thumb {
      width: 100%;
      aspect-ratio: 16 / 10;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      border: 1px solid var(--mm-border);
      overflow: hidden;
      background: rgba(0, 0, 0, 0.35);
    }
    .mm-bedrock-world-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .mm-bedrock-world-thumb-empty {
      width: 100%;
      height: 100%;
      min-height: 76px;
      background: linear-gradient(145deg, #3a3a3c, #2c2c2e);
    }
    .mm-world-edit-save.mm-btn {
      width: 100%;
      box-sizing: border-box;
      margin: 0;
      padding: 16px 20px;
      font-size: 18px;
      min-height: 48px;
    }
    .mm-bedrock-world-sidebar .mm-modal-feedback {
      margin-top: 6px;
      font-size: calc(19px + var(--mm-m5-nudge));
      line-height: 1.45;
    }
    .mm-bedrock-world-nav {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .mm-bedrock-world-nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 14px 14px;
      border: 1px solid transparent;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      background: transparent;
      color: var(--mm-ink-mid);
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      text-align: left;
      cursor: pointer;
      transition: border-color 130ms ease, background 130ms ease, color 130ms ease;
    }
    .mm-bedrock-world-nav-item:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: var(--mm-border);
      color: var(--mm-ink);
    }
    .mm-bedrock-world-nav-item--active {
      background: var(--mm-surface-raised) !important;
      border-color: var(--mm-border-strong) !important;
      color: var(--mm-ink) !important;
    }
    .mm-bedrock-world-nav-icon {
      width: 28px;
      text-align: center;
      font-size: 17px;
      font-family: 'BoldPixels', monospace;
      color: var(--mm-ink-soft);
      opacity: 0.95;
    }
    .mm-bedrock-world-nav-item--active .mm-bedrock-world-nav-icon {
      color: var(--mm-ink-mid);
    }
    .mm-bedrock-world-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--mm-surface);
    }
    .mm-bedrock-world-main-head {
      flex-shrink: 0;
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-bedrock-world-section-title {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 17px;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--mm-ink-soft);
    }
    .mm-bedrock-world-section-body {
      flex: 1;
      overflow-y: auto;
      padding: 18px 20px 24px;
    }
    .mm-bedrock-world-section-body::-webkit-scrollbar {
      width: 4px;
    }
    .mm-bedrock-world-section-body::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-bedrock-panel-desc {
      margin: 0 0 12px;
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-mid);
    }
    .mm-bedrock-pack-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 14px;
      margin-bottom: 8px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
    }
    .mm-pack-drag-row.mm-bedrock-pack-row {
      cursor: grab;
      padding-left: 8px;
      gap: 10px;
    }
    .mm-pack-drag-row.mm-bedrock-pack-row:active {
      cursor: grabbing;
    }
    .mm-pack-drag-handle {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      align-self: stretch;
      margin: -4px 0 -4px -2px;
      padding: 4px 2px;
      border-radius: 6px;
      color: var(--mm-ink-soft);
      opacity: 0.85;
    }
    .mm-pack-drag-handle-dots {
      display: grid;
      grid-template-columns: 4px 4px;
      grid-template-rows: repeat(3, 4px);
      gap: 4px 5px;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .mm-pack-drag-handle-dots span {
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.9;
    }
    .mm-pack-drag-row-main {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .mm-pack-drag-row-index {
      flex-shrink: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
      color: var(--mm-ink-soft);
      min-width: 2rem;
    }
    .mm-pack-bedrock-tabs {
      display: flex;
      flex-direction: row;
      gap: 0;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--mm-border);
    }
    .mm-pack-bedrock-tab {
      margin: 0;
      padding: 12px 20px 10px;
      background: transparent;
      border: none;
      border-bottom: 3px solid transparent;
      color: var(--mm-ink-soft);
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: color 120ms ease, border-color 120ms ease;
    }
    .mm-pack-bedrock-tab:hover {
      color: var(--mm-ink-mid);
    }
    .mm-pack-bedrock-tab--active {
      color: var(--mm-ink) !important;
      border-bottom-color: var(--mm-ink) !important;
    }
    .mm-pack-bedrock-tab-body {
      min-height: 120px;
      padding-top: 14px;
    }
    .mm-pack-bedrock-pane-label {
      margin: 0 0 8px;
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--mm-ink-soft);
    }
    .mm-pack-bedrock-footnote {
      margin: 12px 0 0 !important;
      font-size: calc(16px + var(--mm-m5-nudge)) !important;
      line-height: 1.45 !important;
    }
    .mm-pack-available-well {
      max-height: min(40vh, 320px);
      overflow-x: hidden;
      overflow-y: auto;
      padding: 10px 12px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
    }
    .mm-pack-available-well::-webkit-scrollbar {
      width: 4px;
    }
    .mm-pack-available-well::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-pack-available-mount {
      min-height: 0;
    }
    .mm-bedrock-pack-general-options {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--mm-border);
    }
    .mm-bedrock-pack-row-label {
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mm-pack-dual-stack {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .mm-pack-stack-block {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }
    .mm-pack-stack-block-title {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: var(--mm-ink-soft);
    }
    .mm-pack-active-well,
    .mm-pack-installed-inner {
      max-height: min(32vh, 280px);
      overflow-x: hidden;
      overflow-y: auto;
      padding: 10px 12px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
    }
    .mm-pack-active-well::-webkit-scrollbar,
    .mm-pack-installed-inner::-webkit-scrollbar {
      width: 4px;
    }
    .mm-pack-active-well::-webkit-scrollbar-thumb,
    .mm-pack-installed-inner::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-pack-active-empty.mm-note {
      list-style: none;
      padding: 10px 6px;
      margin: 0;
      text-align: center;
      font-size: calc(18px + var(--mm-m5-nudge));
      line-height: 1.4;
    }
    .mm-pack-installed-row {
      cursor: default;
      margin-bottom: 6px;
    }
    .mm-pack-installed-row:last-child {
      margin-bottom: 0;
    }
    .mm-bedrock-mp-toggle {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin-top: 8px;
      cursor: pointer;
      font-family: 'M5x7', monospace;
      font-size: calc(20px + var(--mm-m5-nudge));
      letter-spacing: normal;
      font-weight: normal;
      color: var(--mm-ink-mid);
      line-height: 1.4;
    }
    .mm-bedrock-mp-toggle input {
      margin-top: 3px;
      flex-shrink: 0;
      accent-color: #aeaeb2;
      width: 20px;
      height: 20px;
    }
    .mm-pack-built-in-sub {
      font-size: calc(16px + var(--mm-m5-nudge));
      line-height: 1.45;
      color: var(--mm-ink-soft);
    }
    .mm-bedrock-world-meta {
      font-size: calc(19px + var(--mm-m5-nudge));
      line-height: 1.45;
    }

    @media (max-width: 620px) {
      .mm-bedrock-world-body {
        flex-direction: column;
      }
      .mm-bedrock-world-sidebar {
        width: 100%;
        border-right: none;
        border-bottom: 1px solid var(--mm-border);
        max-height: 42vh;
      }
      .mm-bedrock-world-nav {
        flex-direction: row;
        flex-wrap: wrap;
      }
      .mm-bedrock-world-nav-item {
        flex: 1 1 auto;
        min-width: 44%;
      }
    }

    .mm-comments-list { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
    .mm-comment-item {
      padding: 10px 12px;
      background: var(--mm-surface-deep);
      border-radius: var(--mm-radius-sm);
      border: 1px solid var(--mm-border);
    }
    .mm-comment-author {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      color: var(--mm-ink-mid);
      margin-bottom: 4px;
    }
    .mm-comment-body {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      color: var(--mm-ink-mid);
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .mm-stars-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
    .mm-star-btn {
      min-width: 40px;
      padding: 8px 10px;
      font-family: 'M5x7', monospace;
      font-size: calc(16px + var(--mm-m5-nudge));
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      border-radius: var(--mm-radius-sm);
      cursor: pointer;
    }
    .mm-star-btn:hover, .mm-star-btn.mm-star-btn-active {
      border-color: var(--mm-border-strong);
      color: var(--mm-ink);
    }
    select.mm-select {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 14px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      border-radius: var(--mm-radius-sm);
      cursor: pointer;
    }
    textarea.mm-textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 88px;
      padding: 14px 16px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge));
      border-radius: var(--mm-radius-sm);
      resize: vertical;
    }

    .mm-online-title-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 1rem;
      min-width: 0;
    }
    .mm-online-title-row .mm-panel-title {
      margin: 0;
      flex: 1;
      min-width: 0;
      line-height: 1.15;
    }
    .mm-online-back-btn {
      flex-shrink: 0;
    }
    .mm-online-body-stage {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    /* Room detail sections: same inset surface as world list / changelog card */
    .mm-room-section-card {
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      padding: 1.15rem 1.25rem;
      box-sizing: border-box;
    }
    .mm-room-section-kicker {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--mm-ink-soft);
      margin: 0 0 0.65rem;
    }
    .mm-room-meta-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 0.75rem;
    }
    .mm-rooms-badge {
      font-family: 'M5x7', monospace;
      font-size: calc(16px + var(--mm-m5-nudge));
      padding: 6px 12px;
      border-radius: 999px;
      background: var(--mm-surface-raised);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
    }
    .mm-room-detail-scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding-right: 2px;
    }
    .mm-room-detail-scroll::-webkit-scrollbar { width: 4px; }
    .mm-room-detail-scroll::-webkit-scrollbar-track { background: transparent; }
    .mm-room-detail-scroll::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-placeholder-block {
      border: 1px dashed var(--mm-border);
      border-radius: var(--mm-radius-sm);
      padding: 1.35rem 1.15rem;
      text-align: center;
      background: var(--mm-surface-deep);
    }
    .mm-placeholder-block-title {
      font-family: 'BoldPixels', monospace;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--mm-ink-mid);
      margin: 0 0 8px;
    }
    .mm-placeholder-block-body {
      font-family: 'M5x7', monospace;
      font-size: calc(18px + var(--mm-m5-nudge));
      line-height: 1.5;
      color: var(--mm-ink-soft);
      margin: 0;
      max-width: 28rem;
      margin-left: auto;
      margin-right: auto;
    }
    /*
     * M5x7 is a fixed bitmap grid in a TTF. Browsers still rasterize it with anti-aliasing;
     * fractional font-size (e.g. clamp + vw), em letter-spacing, and synthesized bold make
     * stems look uneven. Snap responsive titles where supported; keep body M5x7 at normal spacing.
     */
    .mm-note,
    .mm-modal-meta,
    .mm-modal-feedback,
    .mm-bedrock-panel-desc,
    .mm-bedrock-world-meta,
    .mm-whats-new-body,
    .mm-bedrock-pack-row-label,
    .mm-pack-built-in-sub,
    .mm-pack-active-empty.mm-note,
    .mm-world-meta,
    .mm-world-desc,
    .mm-nav-meta,
    .mm-nav-label-sub,
    .mm-brand-subtitle,
    .mm-placeholder-block-body,
    .mm-settings-val,
    .mm-settings-coming-soon,
    .mm-feedback-error {
      letter-spacing: normal;
      font-weight: normal;
    }
    .mm-field input[type="text"],
    .mm-field input[type="search"],
    .mm-field input[type="number"],
    .mm-field input[type="email"],
    .mm-field input[type="password"],
    .mm-field textarea {
      letter-spacing: normal;
      font-weight: normal;
    }

    @supports (font-size: round(nearest, 22px, 1px)) {
      .mm-panel-title {
        font-size: round(nearest, clamp(22px, 2.6vw, 28px), 1px);
      }
      .mm-modal-title {
        font-size: round(nearest, clamp(22px, 2.5vw, 26px), 1px);
      }
      .mm-bedrock-world-heading {
        font-size: round(nearest, clamp(22px, 2.8vw, 28px), 1px);
      }
      .mm-brand-title {
        font-size: round(nearest, clamp(32px, 5vw, 48px), 1px);
      }
      .mm-workshop-detail-name {
        font-size: round(nearest, clamp(18px, 2.4vw, 26px), 1px);
      }
    }

    .mm-room-join-footer {
      flex-shrink: 0;
      margin-top: auto;
      padding-top: 1rem;
      border-top: 1px solid var(--mm-border);
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 12px;
    }
    .mm-room-join-footer .mm-field {
      flex: 1;
      min-width: min(200px, 100%);
      margin-bottom: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      .mm-nav-btn, .mm-btn, .mm-discord, .mm-world-row { transition: none; }
      .mm-content.mm-content-exit,
      .mm-content.mm-content-enter {
        animation: none !important;
        opacity: 1;
        transform: none;
        pointer-events: auto;
      }
      .mm-root.mm-root--content-transition .mm-nav {
        pointer-events: auto;
      }
      .mm-workshop-spinner,
      .mm-workshop-spinner--btn {
        animation: none;
      }
      .mm-workshop-rowcard,
      .mm-workshop-type-pill,
      .mm-workshop-sort-pill,
      .mm-workshop-search-wrap,
      .mm-workshop-filter-strip {
        transition: none;
      }
      .mm-modal,
      .mm-modal-card {
        animation: none;
        opacity: 1;
      }
      .mm-modal-card {
        transform: none;
      }
    }

    @media (max-width: 900px) {
      .mm-body {
        flex-direction: column;
        align-items: stretch;
      }
      .mm-nav {
        width: 100%;
        min-width: 0;
      }
      .mm-nav-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .mm-content {
        max-width: none;
      }
    }

    @media (max-width: 560px) {
      .mm-nav-list {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// What's New content
// ---------------------------------------------------------------------------

const WHATS_NEW_HTML = `
  A performance-focused patch with smoother frame pacing, reduced stutter in heavy scenes, and better overall responsiveness.
  Ambient effects, chunk processing, and rendering paths were optimized to lower CPU load and keep gameplay feeling stable.
`.trim();

// ---------------------------------------------------------------------------
// MainMenu
// ---------------------------------------------------------------------------

type NavTab = "solo" | "online" | "workshop" | "settings" | "skins" | "profile";

export type MainMenuWorkshopDeps = {
  bus: EventBus;
  modRepository: ModRepository;
};

export class MainMenu {
  static async show(
    mount: HTMLElement,
    store: IndexedDBStore,
    auth: IAuthProvider,
    workshop?: MainMenuWorkshopDeps,
    sharedAudio?: AudioEngine,
    opts: { playStartupIntro?: boolean } = {},
  ): Promise<MainMenuExit> {
    const base = import.meta.env.BASE_URL;
    injectStyles(base);

    // On cold startup, let the cinematic intro have headroom before heavy menu world work.
    const bg = new MenuBackground({
      disableIntroSlide: opts.playStartupIntro === true,
      deferHeavyInitMs: opts.playStartupIntro === true ? 1100 : 0,
    });
    const bgPromise = bg.init(mount).catch((err: unknown) => {
      console.warn("[MainMenu] Background world failed to load:", err);
    });

    return new Promise<MainMenuExit>((resolve) => {
      const root = document.createElement("div");
      root.className = "mm-root";

      let onlinePollTimer: ReturnType<typeof setInterval> | null = null;
      function clearOnlinePoll(): void {
        if (onlinePollTimer !== null) {
          clearInterval(onlinePollTimer);
          onlinePollTimer = null;
        }
      }

      // -- Top bar (Discord button) ------------------------------------------
      const topbar = document.createElement("div");
      topbar.className = "mm-topbar";
      const discordBtn = document.createElement("button");
      discordBtn.className = "mm-discord";
      discordBtn.type = "button";
      discordBtn.textContent = "Discord";
      discordBtn.addEventListener("click", () => {
        window.open("https://discord.gg/wBDA9c7DKk", "_blank", "noopener");
      });
      topbar.appendChild(discordBtn);
      root.appendChild(topbar);

      // -- Body --------------------------------------------------------------
      const body = document.createElement("div");
      body.className = "mm-body";

      // -- Nav column --------------------------------------------------------
      const nav = document.createElement("nav");
      nav.className = "mm-nav";

      const brand = document.createElement("div");
      brand.className = "mm-brand";
      const brandLogo = document.createElement("img");
      brandLogo.className = "mm-brand-logo";
      brandLogo.src = stratumCoreTextureAssetUrl("logo.png");
      brandLogo.alt = "Stratum";
      brand.appendChild(brandLogo);
      nav.appendChild(brand);

      const navList = document.createElement("div");
      navList.className = "mm-nav-list";
      nav.appendChild(navList);

      let activeTab: NavTab | null = null;
      const navBtns = new Map<NavTab, HTMLButtonElement>();

      let profileUnmount: (() => void) | null = null;
      let skinUnmount: (() => void) | null = null;
      let workshopUnmount: (() => void) | null = null;
      let settingsPanelAbort: AbortController | null = null;

      function abortSettingsPanel(): void {
        settingsPanelAbort?.abort();
        settingsPanelAbort = null;
      }

      function disposeProfile(): void {
        if (profileUnmount !== null) {
          profileUnmount();
          profileUnmount = null;
        }
      }

      function disposeSkin(): void {
        if (skinUnmount !== null) {
          skinUnmount();
          skinUnmount = null;
        }
      }

      function disposeWorkshop(): void {
        if (workshopUnmount !== null) {
          workshopUnmount();
          workshopUnmount = null;
        }
      }

      const navItems: Array<{
        id: NavTab;
        label: string;
        sub?: string;
        disabled?: boolean;
      }> = [
        { id: "solo", label: "Solo" },
        { id: "online", label: "Online" },
        ...(workshop !== undefined
          ? [{ id: "workshop" as const, label: "Workshop" }]
          : []),
        { id: "settings", label: "Settings" },
        { id: "skins", label: "Skins", sub: "Wardrobe" },
        { id: "profile", label: "Profile", sub: "Account" },
      ];

      for (const item of navItems) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "mm-nav-btn" + (item.disabled === true ? " mm-nav-btn-disabled" : "");
        if (item.disabled !== true) {
          btn.addEventListener("click", () => {
            const tab = item.id;
            if (activeTab === tab) {
              // Deselect → return to home
              activeTab = null;
              btn.classList.remove("mm-nav-btn-active");
              transitionContent(() => {
                renderHome();
              });
            } else {
              setActiveTab(tab);
              transitionContent(() => performTabRender(tab));
            }
          });
        }
        const labelSpan = document.createElement("span");
        labelSpan.textContent = item.label;
        btn.appendChild(labelSpan);
        if (item.sub !== undefined) {
          const sub = document.createElement("span");
          sub.className = "mm-nav-label-sub";
          sub.textContent = item.sub;
          btn.appendChild(sub);
        }
        navList.appendChild(btn);
        navBtns.set(item.id, btn);
      }

      const navMeta = document.createElement("div");
      navMeta.className = "mm-nav-meta";
      navMeta.textContent = "Browse rooms online or host from Solo saves.";
      nav.appendChild(navMeta);

      function setActiveTab(tab: NavTab): void {
        activeTab = tab;
        for (const [id, b] of navBtns) {
          if (id === tab) {
            b.classList.add("mm-nav-btn-active");
          } else {
            b.classList.remove("mm-nav-btn-active");
          }
        }
      }

      // -- Content area ------------------------------------------------------
      const content = document.createElement("div");
      content.className = "mm-content";

      // -- Modal helpers -----------------------------------------------------
      let pendingDeleteUuid: string | null = null;

      function closeModal(): void {
        for (const el of root.querySelectorAll(".mm-modal")) {
          el.remove();
        }
        pendingDeleteUuid = null;
      }

      function openCreateModal(): void {
        closeModal();
        const modal = document.createElement("div");
        modal.className = "mm-modal";
        const card = document.createElement("div");
        card.className = "mm-modal-card";

        const heading = document.createElement("h3");
        heading.className = "mm-modal-title";
        heading.textContent = "New World";

        const nameField = makeField("World name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = "My World";
        nameField.appendChild(nameInput);

        const seedField = makeField("Seed");
        const seedInput = document.createElement("input");
        seedInput.type = "text";
        seedInput.value = String(randomSixDigitSeed());
        seedInput.placeholder = "Random if empty";
        seedField.appendChild(seedInput);

        const actions = document.createElement("div");
        actions.className = "mm-modal-actions";
        const cancelBtn = makeBtn("Cancel", "mm-btn mm-btn-subtle");
        cancelBtn.addEventListener("click", closeModal);
        const createBtn = makeBtn("Create", "mm-btn");
        createBtn.addEventListener("click", () => {
          const name = nameInput.value.trim() || "My World";
          const seed = parseSeedInput(seedInput.value);
          exitToGame({ action: "new", name, seed });
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(createBtn);

        card.appendChild(heading);
        card.appendChild(nameField);
        card.appendChild(seedField);
        card.appendChild(actions);
        modal.appendChild(card);
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeModal();
        });
        root.appendChild(modal);
        nameInput.focus();
      }

      let contentTransitionToken = 0;
      const MM_CONTENT_OUT_FALLBACK_MS = 240;
      const MM_CONTENT_IN_FALLBACK_MS = 400;

      function setContentTransitionBusy(busy: boolean): void {
        root.classList.toggle("mm-root--content-transition", busy);
      }

      function transitionContent(runSwap: () => void | Promise<void>): void {
        const myToken = ++contentTransitionToken;
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;

        const endTransition = (): void => {
          if (myToken !== contentTransitionToken) return;
          setContentTransitionBusy(false);
          content.classList.remove("mm-content-exit", "mm-content-enter");
        };

        const onSwapError = (err: unknown): void => {
          console.error("[MainMenu] Screen transition failed:", err);
          endTransition();
        };

        setContentTransitionBusy(true);

        if (reduceMotion) {
          void Promise.resolve(runSwap()).then(endTransition, onSwapError);
          return;
        }

        content.classList.remove("mm-content-enter", "mm-content-exit");
        void content.offsetWidth;
        content.classList.add("mm-content-exit");

        let outDone = false;
        let outTimer = 0;
        const onOutAnimEnd = (ev: AnimationEvent): void => {
          if (myToken !== contentTransitionToken) return;
          if (ev.target !== content) return;
          if (ev.animationName !== "mm-content-out") return;
          completeOut();
        };

        const completeOut = (): void => {
          if (outDone) return;
          outDone = true;
          window.clearTimeout(outTimer);
          content.removeEventListener("animationend", onOutAnimEnd);
          if (myToken !== contentTransitionToken) return;
          content.classList.remove("mm-content-exit");

          void Promise.resolve(runSwap())
            .then(
              () => {
                if (myToken !== contentTransitionToken) return;

                content.classList.remove("mm-content-enter");
                void content.offsetWidth;
                content.classList.add("mm-content-enter");

                let inDone = false;
                let inTimer = 0;
                const onInAnimEnd = (ev: AnimationEvent): void => {
                  if (myToken !== contentTransitionToken) return;
                  if (ev.target !== content) return;
                  if (ev.animationName !== "mm-content-in") return;
                  completeIn();
                };

                const completeIn = (): void => {
                  if (inDone) return;
                  inDone = true;
                  window.clearTimeout(inTimer);
                  content.removeEventListener("animationend", onInAnimEnd);
                  if (myToken !== contentTransitionToken) return;
                  content.classList.remove("mm-content-enter");
                  endTransition();
                };

                content.addEventListener("animationend", onInAnimEnd);
                inTimer = window.setTimeout(
                  completeIn,
                  MM_CONTENT_IN_FALLBACK_MS,
                );
              },
              onSwapError,
            );
        };

        content.addEventListener("animationend", onOutAnimEnd);
        outTimer = window.setTimeout(
          completeOut,
          MM_CONTENT_OUT_FALLBACK_MS,
        );
      }

      // -- Render functions --------------------------------------------------

      function renderHome(): void {
        abortSettingsPanel();
        disposeProfile();
        disposeSkin();
        disposeWorkshop();
        content.replaceChildren();
        content.classList.add("mm-content-home");
        content.classList.remove("mm-content-tab");

        // Changelog panel (home view only)
        const wnPanel = document.createElement("div");
        wnPanel.className = "mm-panel mm-whats-new mm-home-changelog";

        const wnCard = document.createElement("div");
        wnCard.className = "mm-home-changelog-card";

        const wnCopy = document.createElement("div");
        wnCopy.className = "mm-home-changelog-copy";

        const wnKicker = document.createElement("p");
        wnKicker.className = "mm-home-changelog-kicker";
        wnKicker.textContent = "Changelog";
        wnCopy.appendChild(wnKicker);

        const wnHeading = document.createElement("p");
        wnHeading.className = "mm-home-changelog-title";
        wnHeading.textContent = "Stratum · Alpha 0.5.1";
        wnCopy.appendChild(wnHeading);

        const wnBody = document.createElement("div");
        wnBody.className = "mm-whats-new-body";
        wnBody.innerHTML = WHATS_NEW_HTML;
        wnCopy.appendChild(wnBody);

        const readMoreBtn = makeBtn("Read More", "mm-btn mm-btn-subtle mm-home-changelog-cta");
        readMoreBtn.addEventListener("click", () => {
          // Placeholder CTA until changelog route/details view is implemented.
          window.open("https://discord.gg/wBDA9c7DKk", "_blank", "noopener");
        });
        wnCopy.appendChild(readMoreBtn);

        wnCard.appendChild(wnCopy);
        wnPanel.appendChild(wnCard);

        content.appendChild(wnPanel);
      }

      async function performTabRender(tab: NavTab): Promise<void> {
        content.classList.remove("mm-content-home");
        content.classList.add("mm-content-tab");
        if (tab === "solo") renderSolo();
        else if (tab === "online") renderOnline();
        else if (tab === "workshop") renderWorkshop();
        else if (tab === "settings") await renderSettings();
        else if (tab === "skins") renderSkins();
        else if (tab === "profile") renderProfile();
      }

      function renderWorkshop(): void {
        if (workshop === undefined) {
          return;
        }
        abortSettingsPanel();
        disposeProfile();
        disposeSkin();
        disposeWorkshop();
        content.replaceChildren();
        closeModal();
        const screen = new WorkshopScreen({
          bus: workshop.bus,
          getModPublicUrl: (p: string) => {
            const c = auth.getSupabaseClient();
            if (c === null) {
              return "";
            }
            return c.storage.from("mods").getPublicUrl(p).data.publicUrl;
          },
          isInstalled: (modId: string) => workshop.modRepository.isInstalled(modId),
          getUserId: () => auth.getSession()?.userId ?? null,
          getInstalledPacks: () => workshop.modRepository.getInstalled(),
        });
        workshopUnmount = screen.mount(content);
      }

      function renderSkins(): void {
        abortSettingsPanel();
        disposeWorkshop();
        disposeProfile();
        disposeSkin();
        content.replaceChildren();
        closeModal();
        skinUnmount = mountSkinScreen(content, auth);
      }

      function renderProfile(): void {
        abortSettingsPanel();
        disposeWorkshop();
        disposeSkin();
        disposeProfile();
        content.replaceChildren();
        closeModal();
        profileUnmount = mountProfileScreen(content, auth);
      }

      function renderSolo(): void {
        abortSettingsPanel();
        disposeWorkshop();
        disposeSkin();
        disposeProfile();
        content.replaceChildren();
        closeModal();

        const panel = document.createElement("div");
        panel.className = "mm-panel mm-solo-panel";
        content.appendChild(panel);

        function mountListView(): void {
          panel.classList.remove("mm-solo-panel--world-edit");
          panel.replaceChildren();

          const title = document.createElement("p");
          title.className = "mm-panel-title";
          title.textContent = "Worlds";
          panel.appendChild(title);

          const importFeedback = document.createElement("p");
          importFeedback.className = "mm-import-feedback";
          importFeedback.setAttribute("aria-live", "polite");
          panel.appendChild(importFeedback);

          const list = document.createElement("div");
          list.className = "mm-worldlist";
          panel.appendChild(list);

          const rerenderList = async (): Promise<void> => {
            if (!list.isConnected) return;
            list.replaceChildren();
            const worlds = (await store.listWorlds()).sort(sortWorldsByLastPlayed);
            if (!list.isConnected) return;
            if (worlds.length === 0) {
              const empty = document.createElement("div");
              empty.className = "mm-world-empty";
              empty.textContent = "No worlds yet. Create one below.";
              list.appendChild(empty);
              return;
            }
            for (const world of worlds) {
              appendWorldRowToList(list, world, () => {
                exitToGame({ action: "load", uuid: world.uuid });
              }, {
                onEdit: (w) => {
                  openWorldEditor(w);
                },
              });
            }
          };

          const footer = document.createElement("div");
          footer.className = "mm-solo-footer";
          const importInput = document.createElement("input");
          importInput.type = "file";
          importInput.accept = "application/json,application/gzip,.json,.gz";
          importInput.style.cssText =
            "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
          importInput.setAttribute("aria-hidden", "true");
          const importBtn = makeBtn("Import world", "mm-btn mm-btn-subtle");
          importBtn.addEventListener("click", () => importInput.click());
          importInput.addEventListener("change", () => {
            const file = importInput.files?.[0];
            importInput.value = "";
            if (file === undefined) {
              return;
            }
            void (async () => {
              try {
                importBtn.disabled = true;
                importFeedback.classList.remove("mm-import-feedback--error");
                importFeedback.textContent = "Importing…";
                await store.openDB();
                const buf = await file.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const rawBytes = isGzipBytes(bytes) ? gunzipSync(bytes) : bytes;
                const text = new TextDecoder().decode(rawBytes);
                const parsed: unknown = JSON.parse(text);
                const newUuid = await store.importWorldBundle(parsed);
                const imported = await store.loadWorld(newUuid);
                importFeedback.textContent =
                  imported !== undefined
                    ? `Imported “${imported.name}”.`
                    : "World imported.";
              } catch (err: unknown) {
                importFeedback.textContent =
                  err instanceof Error ? err.message : "Import failed.";
                importFeedback.classList.add("mm-import-feedback--error");
              } finally {
                importBtn.disabled = false;
              }
              await rerenderList();
            })();
          });
          footer.appendChild(importInput);
          const createBtn = makeBtn("New World", "mm-btn");
          createBtn.addEventListener("click", openCreateModal);
          footer.appendChild(createBtn);
          footer.appendChild(importBtn);
          panel.appendChild(footer);

          void rerenderList();
        }

        function openWorldEditor(world: WorldMetadata): void {
          closeModal();
          panel.classList.add("mm-solo-panel--world-edit");
          panel.replaceChildren();
          mountBedrockWorldEditor({
            container: panel,
            worldUuid: world.uuid,
            mode: "solo",
            onBack: mountListView,
            afterSaveSuccess: mountListView,
          });
        }

        mountListView();
      }

      function loadHostPrefs(): {
        isPrivate: boolean;
        worldUuid: string;
      } {
        try {
          const raw = localStorage.getItem(STRATUM_ROOM_HOST_PREFS_KEY);
          if (raw === null) {
            return {
              isPrivate: false,
              worldUuid: "",
            };
          }
          const j = JSON.parse(raw) as Record<string, unknown>;
          return {
            isPrivate: j.isPrivate === true,
            worldUuid: typeof j.worldUuid === "string" ? j.worldUuid : "",
          };
        } catch {
          return {
            isPrivate: false,
            worldUuid: "",
          };
        }
      }

      function saveHostPrefs(p: {
        isPrivate: boolean;
        worldUuid: string;
      }): void {
        localStorage.setItem(
          STRATUM_ROOM_HOST_PREFS_KEY,
          JSON.stringify({
            isPrivate: p.isPrivate,
            worldUuid: p.worldUuid,
          }),
        );
      }

      function mountBedrockWorldEditor(opts: {
        container: HTMLElement;
        worldUuid: string;
        mode: "solo" | "host";
        hostRoomPrefs?: ReturnType<typeof loadHostPrefs>;
        onBack: () => void;
        afterSaveSuccess?: () => void;
      }): void {
        void (async () => {
          const fresh = await store.loadWorld(opts.worldUuid);
          if (!opts.container.isConnected) {
            return;
          }
          if (fresh === undefined) {
            opts.container.replaceChildren();
            const errP = document.createElement("p");
            errP.className = "mm-modal-meta";
            errP.textContent = "This world no longer exists.";
            opts.container.appendChild(errP);
            return;
          }
          const worldUuid = fresh.uuid;
          opts.container.replaceChildren();

          const shell = document.createElement("div");
          shell.className = "mm-bedrock-world-shell";

          const topbar = document.createElement("div");
          topbar.className = "mm-bedrock-world-topbar";
          const backBtn = document.createElement("button");
          backBtn.type = "button";
          backBtn.className = "mm-btn mm-btn-subtle mm-world-edit-back";
          backBtn.setAttribute(
            "aria-label",
            opts.mode === "host" ? "Back to world list" : "Back to worlds",
          );
          backBtn.textContent = "‹";
          backBtn.addEventListener("click", opts.onBack);
          const heading = document.createElement("h2");
          heading.className = "mm-bedrock-world-heading";
          heading.textContent =
            opts.mode === "host" ? "Host world" : "Edit World";
          topbar.appendChild(backBtn);
          topbar.appendChild(heading);

          const body = document.createElement("div");
          body.className = "mm-bedrock-world-body";

          const sidebar = document.createElement("aside");
          sidebar.className = "mm-bedrock-world-sidebar";

          const thumbWrap = document.createElement("div");
          thumbWrap.className = "mm-bedrock-world-thumb";
          const previewUrl = fresh.previewImageDataUrl;
          if (previewUrl !== undefined && previewUrl.length > 0) {
            const img = document.createElement("img");
            img.src = previewUrl;
            img.alt = "";
            img.decoding = "async";
            thumbWrap.appendChild(img);
          } else {
            const ph = document.createElement("div");
            ph.className = "mm-bedrock-world-thumb-empty";
            ph.setAttribute("aria-hidden", "true");
            thumbWrap.appendChild(ph);
          }
          sidebar.appendChild(thumbWrap);

          const saveSidebar = makeBtn("Save", "mm-btn mm-world-edit-save");
          const feedback = document.createElement("div");
          feedback.className = "mm-modal-feedback";

          const WORLD_DESCRIPTION_MAX = 2000;
          const nameField = makeField("World name");
          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.value = fresh.name;
          nameField.appendChild(nameInput);

          const descriptionField = makeField("Description (optional)");
          const descriptionInput = document.createElement("textarea");
          descriptionInput.rows = 4;
          descriptionInput.maxLength = WORLD_DESCRIPTION_MAX;
          descriptionInput.placeholder =
            "A short note about this world — shown in your world list.";
          descriptionInput.value = fresh.description ?? "";
          descriptionField.appendChild(descriptionInput);

          let privCb: HTMLInputElement | undefined;
          let passInput: HTMLInputElement | undefined;

          let roomListingNote: HTMLElement | undefined;
          let privRow: HTMLElement | undefined;
          let passField: HTMLElement | undefined;

          if (opts.mode === "host") {
            const hp = opts.hostRoomPrefs ?? {
              isPrivate: false,
              worldUuid: "",
            };

            roomListingNote = document.createElement("p");
            roomListingNote.className = "mm-modal-meta";
            roomListingNote.style.marginTop = "6px";
            roomListingNote.textContent =
              "The public room list uses this world’s name and description above (title up to " +
              `${ROOM_TITLE_MAX_LEN} chars, description up to ${ROOM_MOTD_MAX_LEN}).`;

            privRow = document.createElement("div");
            privRow.className = "mm-settings-row";
            privRow.style.marginBottom = "8px";
            const privLab = document.createElement("label");
            privLab.textContent = "Private room";
            privCb = document.createElement("input");
            privCb.type = "checkbox";
            privRow.appendChild(privLab);
            privRow.appendChild(privCb);

            passField = makeField(
              "Room password (min 4, not saved in browser)",
            );
            passInput = document.createElement("input");
            passInput.type = "password";
            passInput.autocomplete = "new-password";
            passField.appendChild(passInput);

            const syncPassField = (): void => {
              passField!.style.display = privCb!.checked ? "block" : "none";
            };

            privCb.checked = hp.isPrivate;
            syncPassField();
            privCb.addEventListener("change", syncPassField);
          }

          const meta = document.createElement("p");
          meta.className = "mm-modal-meta mm-bedrock-world-meta";
          meta.style.marginTop = "12px";
          meta.textContent = `Seed ${fresh.seed} · Last played ${formatDate(fresh.lastPlayedAt)}`;

          const exportBtn = makeBtn("Export world", "mm-btn mm-btn-subtle");
          exportBtn.style.marginTop = "14px";
          exportBtn.addEventListener("click", () => {
            void (async () => {
              try {
                await store.openDB();
                exportBtn.disabled = true;
                const bundle = await store.exportWorldBundle(worldUuid);
                const base = nameInput.value.trim() || fresh.name || "world";
                triggerCompactWorldDownload(safeWorldExportBasename(base), bundle);
                feedback.textContent = "Export downloaded.";
                feedback.classList.remove("mm-feedback-error");
              } catch (err: unknown) {
                feedback.textContent =
                  err instanceof Error ? err.message : "Export failed.";
                feedback.classList.add("mm-feedback-error");
              } finally {
                exportBtn.disabled = false;
              }
            })();
          });

          const deleteBtn = makeBtn("Delete world…", "mm-btn mm-btn-danger");
          deleteBtn.style.marginTop = "22px";
          deleteBtn.addEventListener("click", () => {
            if (pendingDeleteUuid !== worldUuid) {
              pendingDeleteUuid = worldUuid;
              deleteBtn.textContent = "Confirm delete world";
              feedback.textContent = "Press again to permanently delete.";
              feedback.classList.add("mm-feedback-error");
              return;
            }
            void store.deleteWorld(worldUuid).then(() => {
              pendingDeleteUuid = null;
              opts.onBack();
            });
          });

          const packCtrl = createWorldPackEditorController({
            worldMeta: fresh,
            repo: workshop?.modRepository ?? null,
            getInstalled:
              workshop !== undefined
                ? () => workshop.modRepository.getInstalled()
                : null,
            persistPackMetadata: async (patch) => {
              try {
                await store.patchWorldMetadata(worldUuid, (prev) => {
                  if (prev === undefined) {
                    throw new Error(`World not found: ${worldUuid}`);
                  }
                  return {
                    ...prev,
                    workshopBehaviorMods: patch.workshopBehaviorMods,
                    workshopResourceMods: patch.workshopResourceMods,
                    requirePacksBeforeJoin: patch.requirePacksBeforeJoin,
                    workshopMods: undefined,
                  };
                });
                feedback.classList.remove("mm-feedback-error");
              } catch (err: unknown) {
                const msg =
                  err instanceof Error ? err.message : "Could not save pack list.";
                feedback.textContent = msg;
                feedback.classList.add("mm-feedback-error");
              }
            },
          });
          const { getPatch } = packCtrl;

          const persistWorldEdits = async (): Promise<void> => {
            const nextName = nameInput.value.trim() || "My World";
            const descTrim = descriptionInput.value.trim();
            const nextDescription =
              descTrim.length > 0
                ? descTrim.slice(0, WORLD_DESCRIPTION_MAX)
                : undefined;
            await store.patchWorldMetadata(worldUuid, (prev) => {
              if (prev === undefined) {
                throw new Error(`World not found: ${worldUuid}`);
              }
              const patch = getPatch();
              return {
                ...prev,
                name: nextName,
                description: nextDescription,
                workshopBehaviorMods: patch.workshopBehaviorMods,
                workshopResourceMods: patch.workshopResourceMods,
                requirePacksBeforeJoin: patch.requirePacksBeforeJoin,
                workshopMods: undefined,
                lastPlayedAt: Date.now(),
              };
            });
          };

          saveSidebar.addEventListener("click", () => {
            void persistWorldEdits()
              .then(() => {
                feedback.textContent = "Saved.";
                feedback.classList.remove("mm-feedback-error");
                opts.afterSaveSuccess?.();
              })
              .catch((err: unknown) => {
                feedback.textContent =
                  err instanceof Error ? err.message : "Save failed.";
                feedback.classList.add("mm-feedback-error");
              });
          });
          sidebar.appendChild(saveSidebar);

          if (opts.mode === "host") {
            const hostRoomBtn = makeBtn("Host room", "mm-btn");
            hostRoomBtn.addEventListener("click", () => {
              if (privCb === undefined || passInput === undefined) {
                return;
              }
              const roomTitle = (nameInput.value.trim() || "My World").slice(
                0,
                ROOM_TITLE_MAX_LEN,
              );
              const motd = descriptionInput.value
                .trim()
                .slice(0, ROOM_MOTD_MAX_LEN);
              const isPrivate = privCb.checked;
              const pw = passInput.value;
              if (isPrivate && pw.trim().length < 4) {
                feedback.textContent =
                  "Private rooms need a password of at least 4 characters.";
                feedback.classList.add("mm-feedback-error");
                return;
              }
              feedback.classList.remove("mm-feedback-error");
              void persistWorldEdits()
                .then(() => {
                  saveHostPrefs({
                    isPrivate,
                    worldUuid,
                  });
                  exitToGame({
                    action: "multiplayer-host",
                    worldUuid,
                    roomTitle,
                    motd,
                    isPrivate,
                    roomPassword: isPrivate ? pw : undefined,
                  });
                })
                .catch((err: unknown) => {
                  feedback.textContent =
                    err instanceof Error ? err.message : "Save failed.";
                  feedback.classList.add("mm-feedback-error");
                });
            });
            sidebar.appendChild(hostRoomBtn);
          }

          sidebar.appendChild(feedback);

          type BedrockTab = "general" | "behavior" | "resource";
          const tabDefs: {
            id: BedrockTab;
            label: string;
            icon: string;
            panelTitle: string;
          }[] = [
            { id: "general", label: "General", icon: "▣", panelTitle: "General" },
            {
              id: "behavior",
              label: "Behavior Packs",
              icon: "◇",
              panelTitle: "Behavior Packs",
            },
            {
              id: "resource",
              label: "Resource Packs",
              icon: "◈",
              panelTitle: "Resource Packs",
            },
          ];

          const bedrockNav = document.createElement("nav");
          bedrockNav.className = "mm-bedrock-world-nav";
          const bedrockNavBtns = new Map<BedrockTab, HTMLButtonElement>();
          let activeTab: BedrockTab = "general";

          const main = document.createElement("div");
          main.className = "mm-bedrock-world-main";
          const mainHead = document.createElement("div");
          mainHead.className = "mm-bedrock-world-main-head";
          const sectionTitle = document.createElement("h3");
          sectionTitle.className = "mm-bedrock-world-section-title";
          mainHead.appendChild(sectionTitle);
          const mainBody = document.createElement("div");
          mainBody.className = "mm-bedrock-world-section-body";
          main.appendChild(mainHead);
          main.appendChild(mainBody);

          const generalPanel = document.createElement("div");
          generalPanel.appendChild(nameField);
          generalPanel.appendChild(descriptionField);
          if (
            opts.mode === "host" &&
            roomListingNote !== undefined &&
            privRow !== undefined &&
            passField !== undefined
          ) {
            generalPanel.appendChild(roomListingNote);
            generalPanel.appendChild(privRow);
            generalPanel.appendChild(passField);
          }
          generalPanel.appendChild(meta);
          generalPanel.appendChild(packCtrl.generalPackOptions);
          generalPanel.appendChild(exportBtn);
          generalPanel.appendChild(deleteBtn);

          function renderActivePanel(): void {
            const def = tabDefs.find((t) => t.id === activeTab);
            sectionTitle.textContent = def?.panelTitle ?? "";
            for (const [id, b] of bedrockNavBtns) {
              b.classList.toggle(
                "mm-bedrock-world-nav-item--active",
                id === activeTab,
              );
            }
            mainBody.replaceChildren();
            if (activeTab === "general") {
              mainBody.appendChild(generalPanel);
            } else if (activeTab === "behavior") {
              mainBody.appendChild(packCtrl.behaviorPanel);
            } else {
              mainBody.appendChild(packCtrl.resourcePanel);
            }
          }

          for (const t of tabDefs) {
            const nb = document.createElement("button");
            nb.type = "button";
            nb.className = "mm-bedrock-world-nav-item";
            const ic = document.createElement("span");
            ic.className = "mm-bedrock-world-nav-icon";
            ic.textContent = t.icon;
            ic.setAttribute("aria-hidden", "true");
            const lb = document.createElement("span");
            lb.textContent = t.label;
            nb.appendChild(ic);
            nb.appendChild(lb);
            nb.addEventListener("click", () => {
              activeTab = t.id;
              renderActivePanel();
            });
            bedrockNavBtns.set(t.id, nb);
            bedrockNav.appendChild(nb);
          }
          sidebar.appendChild(bedrockNav);

          body.appendChild(sidebar);
          body.appendChild(main);
          shell.appendChild(topbar);
          shell.appendChild(body);
          opts.container.appendChild(shell);
          renderActivePanel();
          nameInput.focus();
        })();
      }

      function openJoinByCodeModal(): void {
        closeModal();
        const modal = document.createElement("div");
        modal.className = "mm-modal";
        const card = document.createElement("div");
        card.className = "mm-modal-card";

        const heading = document.createElement("h3");
        heading.className = "mm-modal-title";
        heading.textContent = "Join with code";

        const meta = document.createElement("p");
        meta.className = "mm-modal-meta";
        meta.textContent =
          "Enter the 6-character code your friend shared (no I, O, 0, or 1).";

        const roomField = makeField("Room code");
        const roomInput = document.createElement("input");
        roomInput.type = "text";
        roomInput.maxLength = 6;
        roomInput.placeholder = "ABC234";
        roomInput.autocomplete = "off";
        roomInput.spellcheck = false;
        roomField.appendChild(roomInput);

        const errEl = document.createElement("div");
        errEl.className = "mm-feedback-error";

        const actions = document.createElement("div");
        actions.className = "mm-modal-actions";
        const cancelBtn = makeBtn("Cancel", "mm-btn mm-btn-subtle");
        cancelBtn.addEventListener("click", closeModal);
        const goBtn = makeBtn("Join", "mm-btn");
        const attemptJoin = (): void => {
          const code = roomInput.value.trim().toUpperCase();
          if (!ROOM_CODE_VALID.test(code)) {
            errEl.textContent =
              "Use six characters from A–Z and 2–9 (excludes I, O, 0, 1).";
            return;
          }
          exitToGame({ action: "multiplayer-join", roomCode: code });
        };
        goBtn.addEventListener("click", attemptJoin);
        actions.appendChild(cancelBtn);
        actions.appendChild(goBtn);

        roomInput.addEventListener("input", () => {
          roomInput.value = roomInput.value.toUpperCase();
          errEl.textContent = "";
        });
        roomInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") attemptJoin();
        });

        card.appendChild(heading);
        card.appendChild(meta);
        card.appendChild(roomField);
        card.appendChild(errEl);
        card.appendChild(actions);
        modal.appendChild(card);
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeModal();
        });
        root.appendChild(modal);
        roomInput.focus();
      }

      function openHostWorldFlow(): void {
        if (auth.getSession() === null) {
          closeModal();
          const modal = document.createElement("div");
          modal.className = "mm-modal";
          const card = document.createElement("div");
          card.className = "mm-modal-card";
          const h = document.createElement("h3");
          h.className = "mm-modal-title";
          h.textContent = "Sign in to host";
          const p = document.createElement("p");
          p.className = "mm-note";
          p.textContent =
            "Hosting a room for the directory requires an account. Open Profile to sign in.";
          const actions = document.createElement("div");
          actions.className = "mm-modal-actions";
          const closeSign = makeBtn("Close", "mm-btn mm-btn-subtle");
          closeSign.addEventListener("click", closeModal);
          actions.appendChild(closeSign);
          card.appendChild(h);
          card.appendChild(p);
          card.appendChild(actions);
          modal.appendChild(card);
          modal.addEventListener("click", (ev) => {
            if (ev.target === modal) closeModal();
          });
          root.appendChild(modal);
          return;
        }
        if (auth.getSupabaseClient() === null) {
          closeModal();
          const modal = document.createElement("div");
          modal.className = "mm-modal";
          const card = document.createElement("div");
          card.className = "mm-modal-card";
          const h = document.createElement("h3");
          h.className = "mm-modal-title";
          h.textContent = "Supabase not configured";
          const p = document.createElement("p");
          p.className = "mm-note";
          p.textContent =
            "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to publish a room. You can still join with a code.";
          const actions = document.createElement("div");
          actions.className = "mm-modal-actions";
          const b = makeBtn("Close", "mm-btn mm-btn-subtle");
          b.addEventListener("click", closeModal);
          actions.appendChild(b);
          card.appendChild(h);
          card.appendChild(p);
          card.appendChild(actions);
          modal.appendChild(card);
          modal.addEventListener("click", (ev) => {
            if (ev.target === modal) closeModal();
          });
          root.appendChild(modal);
          return;
        }

        closeModal();
        const prefs = loadHostPrefs();

        const modal = document.createElement("div");
        modal.className = "mm-modal";
        const card = document.createElement("div");
        card.className = "mm-modal-card mm-host-world-modal-card";

        const heading = document.createElement("h3");
        heading.className = "mm-modal-title";
        heading.textContent = "Choose world";

        const note = document.createElement("p");
        note.className = "mm-modal-meta";
        note.textContent = "Pick the save file players will load from your room.";

        const list = document.createElement("div");
        list.className = "mm-worldlist";

        const actions = document.createElement("div");
        actions.className = "mm-modal-actions";
        const cancelBtn = makeBtn("Cancel", "mm-btn mm-btn-subtle");
        cancelBtn.addEventListener("click", closeModal);
        actions.appendChild(cancelBtn);

        void (async () => {
          const worlds = (await store.listWorlds()).sort(sortWorldsByLastPlayed);
          if (!list.isConnected) return;
          if (worlds.length === 0) {
            const empty = document.createElement("div");
            empty.className = "mm-world-empty";
            empty.textContent = "Create a world in Solo first.";
            list.appendChild(empty);
            return;
          }
          for (const w of worlds) {
            appendWorldRowToList(list, w, () => {
              modal.remove();
              openHostWorldEditorModal(w.uuid, prefs);
            });
          }
        })();

        card.appendChild(heading);
        card.appendChild(note);
        card.appendChild(list);
        card.appendChild(actions);
        modal.appendChild(card);
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeModal();
        });
        root.appendChild(modal);
      }

      function openHostWorldEditorModal(
        worldUuid: string,
        prefs: ReturnType<typeof loadHostPrefs>,
      ): void {
        closeModal();
        const modal = document.createElement("div");
        modal.className = "mm-modal";
        const card = document.createElement("div");
        card.className = "mm-modal-card mm-host-world-editor-card";
        modal.appendChild(card);
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeModal();
        });
        root.appendChild(modal);

        mountBedrockWorldEditor({
          container: card,
          worldUuid,
          mode: "host",
          hostRoomPrefs: prefs,
          onBack: () => {
            modal.remove();
            openHostWorldFlow();
          },
        });
      }

      function renderOnline(): void {
        abortSettingsPanel();
        disposeWorkshop();
        disposeSkin();
        disposeProfile();
        content.replaceChildren();
        closeModal();
        clearOnlinePoll();

        const client = auth.getSupabaseClient();
        const panel = document.createElement("div");
        panel.className = "mm-panel mm-online-panel";

        const titleRow = document.createElement("div");
        titleRow.className = "mm-online-title-row";
        const backToRoomsBtn = document.createElement("button");
        backToRoomsBtn.type = "button";
        backToRoomsBtn.className = "mm-btn mm-btn-subtle mm-online-back-btn";
        backToRoomsBtn.textContent = "Rooms";
        backToRoomsBtn.setAttribute("aria-label", "Back to room list");
        backToRoomsBtn.style.display = "none";

        const title = document.createElement("p");
        title.className = "mm-panel-title";
        title.textContent = "Rooms";

        titleRow.appendChild(backToRoomsBtn);
        titleRow.appendChild(title);
        panel.appendChild(titleRow);

        const bodyStage = document.createElement("div");
        bodyStage.className = "mm-online-body-stage";
        panel.appendChild(bodyStage);

        let roomsListEl: HTMLDivElement | null = null;
        let searchInputRef: HTMLInputElement | null = null;
        let filterSelRef: HTMLSelectElement | null = null;
        let sortSelRef: HTMLSelectElement | null = null;

        const loadRooms = async (): Promise<void> => {
          const listEl = roomsListEl;
          if (listEl === null || !listEl.isConnected) return;
          if (client === null) {
            listEl.replaceChildren();
            const empty = document.createElement("div");
            empty.className = "mm-rooms-empty";
            empty.textContent =
              "Room list needs Supabase. Use “Join with code” to connect to a friend.";
            listEl.appendChild(empty);
            return;
          }
          const searchInput = searchInputRef;
          const filterSel = filterSelRef;
          const sortSel = sortSelRef;
          if (
            searchInput === null ||
            filterSel === null ||
            sortSel === null ||
            !searchInput.isConnected
          ) {
            return;
          }
          const rows = await listStratumRooms(client, {
            search: searchInput.value.trim(),
            filter: filterSel.value as "all" | "public" | "private",
            sort: sortSel.value as "active" | "new" | "rating",
            limit: 50,
            offset: 0,
          });
          if (roomsListEl === null || !roomsListEl.isConnected) return;
          roomsListEl.replaceChildren();
          if (rows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "mm-rooms-empty";
            empty.textContent = "No rooms match. Try another search or sort.";
            roomsListEl.appendChild(empty);
            return;
          }
          for (const r of rows) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "mm-rooms-row";
            const t = document.createElement("div");
            t.className = "mm-rooms-row-title";
            t.textContent = r.room_title;
            const m = document.createElement("div");
            m.className = "mm-rooms-row-meta";
            m.appendChild(document.createTextNode(r.world_name || "World"));
            if (r.is_private) {
              const b = document.createElement("span");
              b.className = "mm-rooms-badge";
              b.textContent = "Private";
              m.appendChild(b);
            }
            const rate = document.createElement("span");
            rate.className = "mm-rooms-badge";
            rate.textContent = `★ ${r.avg_rating.toFixed(1)} (${r.rating_count})`;
            m.appendChild(rate);
            row.appendChild(t);
            row.appendChild(m);
            row.addEventListener("click", () => {
              showRoomDetail(r);
            });
            roomsListEl.appendChild(row);
          }
        };

        function showRoomDetail(room: ListedRoom): void {
          if (client === null) return;
          closeModal();
          backToRoomsBtn.style.display = "inline-flex";
          title.textContent = room.room_title;

          bodyStage.replaceChildren();

          const scroll = document.createElement("div");
          scroll.className = "mm-room-detail-scroll";

          const aboutCard = document.createElement("section");
          aboutCard.className = "mm-room-section-card";
          const kAbout = document.createElement("p");
          kAbout.className = "mm-room-section-kicker";
          kAbout.textContent = "About this room";
          aboutCard.appendChild(kAbout);

          if (room.motd.trim() !== "") {
            const motdP = document.createElement("p");
            motdP.className = "mm-note";
            motdP.style.margin = "0";
            motdP.style.whiteSpace = "pre-wrap";
            motdP.textContent = room.motd;
            aboutCard.appendChild(motdP);
          } else {
            const ph = document.createElement("div");
            ph.className = "mm-placeholder-block";
            const phT = document.createElement("p");
            phT.className = "mm-placeholder-block-title";
            phT.textContent = "No description yet";
            const phB = document.createElement("p");
            phB.className = "mm-placeholder-block-body";
            phB.textContent =
              "The host has not added a blurb for this listing. You can still join—everything you need is in the world.";
            ph.appendChild(phT);
            ph.appendChild(phB);
            aboutCard.appendChild(ph);
          }

          const chips = document.createElement("div");
          chips.className = "mm-room-meta-chips";
          const chipWorld = document.createElement("span");
          chipWorld.className = "mm-rooms-badge";
          chipWorld.textContent = room.world_name?.trim()
            ? `World: ${room.world_name}`
            : "World: —";
          const chipHost = document.createElement("span");
          chipHost.className = "mm-rooms-badge";
          chipHost.textContent = room.host_username?.trim()
            ? `Host: ${room.host_username}`
            : "Host: —";
          const chipPriv = document.createElement("span");
          chipPriv.className = "mm-rooms-badge";
          chipPriv.textContent = room.is_private ? "Private" : "Public";
          const chipRate = document.createElement("span");
          chipRate.className = "mm-rooms-badge";
          chipRate.textContent = `★ ${room.avg_rating.toFixed(1)} · ${room.rating_count} rating${room.rating_count === 1 ? "" : "s"}`;
          chips.append(chipWorld, chipHost, chipPriv, chipRate);
          aboutCard.appendChild(chips);
          scroll.appendChild(aboutCard);

          const commentsCard = document.createElement("section");
          commentsCard.className = "mm-room-section-card";
          const kComm = document.createElement("p");
          kComm.className = "mm-room-section-kicker";
          kComm.textContent = "Comments";
          commentsCard.appendChild(kComm);
          const commentsList = document.createElement("div");
          commentsList.className = "mm-comments-list";
          commentsCard.appendChild(commentsList);
          scroll.appendChild(commentsCard);

          const participate = document.createElement("section");
          participate.className = "mm-room-section-card";
          const kPart = document.createElement("p");
          kPart.className = "mm-room-section-kicker";
          kPart.textContent = "Your rating & comment";
          participate.appendChild(kPart);

          const session = auth.getSession();
          const commentErr = document.createElement("div");
          commentErr.className = "mm-feedback-error";

          let commentInput: HTMLTextAreaElement | undefined;
          let postCommentBtn: HTMLButtonElement | undefined;
          const starsRow = document.createElement("div");
          starsRow.className = "mm-stars-row";

          if (session === null) {
            const ph = document.createElement("div");
            ph.className = "mm-placeholder-block";
            const phT = document.createElement("p");
            phT.className = "mm-placeholder-block-title";
            phT.textContent = "Sign in to participate";
            const phB = document.createElement("p");
            phB.className = "mm-placeholder-block-body";
            phB.textContent =
              "Open the Profile tab to sign in. Then you can leave comments and rate this room for other players.";
            ph.append(phT, phB);
            participate.appendChild(ph);
          } else {
            const commentField = makeField("Add a comment");
            commentInput = document.createElement("textarea");
            commentInput.className = "mm-textarea";
            commentInput.style.minHeight = "72px";
            commentInput.maxLength = 500;
            commentInput.placeholder =
              "Tips, shout-outs, or notes for people browsing…";
            commentField.appendChild(commentInput);
            postCommentBtn = makeBtn("Post comment", "mm-btn mm-btn-subtle");
            participate.append(commentField, commentErr, postCommentBtn);

            const starsKicker = document.createElement("p");
            starsKicker.className = "mm-room-section-kicker";
            starsKicker.style.marginTop = "1rem";
            starsKicker.textContent = "Your star rating";
            participate.append(starsKicker, starsRow);
          }

          scroll.appendChild(participate);
          bodyStage.appendChild(scroll);

          const footer = document.createElement("div");
          footer.className = "mm-room-join-footer";
          const joinErr = document.createElement("div");
          joinErr.className = "mm-feedback-error";
          joinErr.style.flex = "1";
          joinErr.style.minWidth = "120px";
          joinErr.style.marginBottom = "0";
          const pwdField = makeField("Room password");
          const pwdInput = document.createElement("input");
          pwdInput.type = "password";
          pwdInput.autocomplete = "off";
          pwdField.style.display = room.is_private ? "block" : "none";
          pwdField.appendChild(pwdInput);
          const joinBtn = makeBtn("Join room", "mm-btn");
          footer.appendChild(joinErr);
          if (room.is_private) {
            footer.appendChild(pwdField);
          }
          footer.appendChild(joinBtn);
          bodyStage.appendChild(footer);

          const refreshComments = async (): Promise<void> => {
            const list = await listStratumRoomComments(client, room.room_code);
            commentsList.replaceChildren();
            for (const c of list) {
              const item = document.createElement("div");
              item.className = "mm-comment-item";
              const au = document.createElement("div");
              au.className = "mm-comment-author";
              au.textContent = c.author_username || "Player";
              const bd = document.createElement("div");
              bd.className = "mm-comment-body";
              bd.textContent = c.body;
              item.append(au, bd);
              commentsList.appendChild(item);
            }
            if (list.length === 0) {
              const ph = document.createElement("div");
              ph.className = "mm-placeholder-block";
              const phT = document.createElement("p");
              phT.className = "mm-placeholder-block-title";
              phT.textContent = "No comments yet";
              const phB = document.createElement("p");
              phB.className = "mm-placeholder-block-body";
              phB.textContent =
                "Nothing here yet. When players leave notes, they will appear in this thread—be the first to say hello or share a tip.";
              ph.append(phT, phB);
              commentsList.appendChild(ph);
            }
          };

          void refreshComments();

          const rebuildStars = async (): Promise<void> => {
            starsRow.replaceChildren();
            if (session === null) return;
            const mine = await getMyRoomRating(
              client,
              room.room_code,
              session.userId,
            );
            for (let s = 1; s <= 5; s++) {
              const b = document.createElement("button");
              b.type = "button";
              b.className =
                "mm-star-btn" + (mine === s ? " mm-star-btn-active" : "");
              b.textContent = String(s);
              b.addEventListener("click", () => {
                void (async () => {
                  const r = await setStratumRoomRating(
                    client,
                    room.room_code,
                    session.userId,
                    s,
                  );
                  if (!r.ok) {
                    commentErr.textContent = r.error;
                    return;
                  }
                  commentErr.textContent = "";
                  void rebuildStars();
                })();
              });
              starsRow.appendChild(b);
            }
          };
          void rebuildStars();

          if (
            session !== null &&
            postCommentBtn !== undefined &&
            commentInput !== undefined
          ) {
            postCommentBtn.addEventListener("click", () => {
              void (async () => {
                const r = await postStratumRoomComment(
                  client,
                  room.room_code,
                  session.userId,
                  commentInput!.value,
                );
                if (!r.ok) {
                  commentErr.textContent = r.error;
                  return;
                }
                commentErr.textContent = "";
                commentInput!.value = "";
                void refreshComments();
              })();
            });
          }

          joinBtn.addEventListener("click", () => {
            const code = room.room_code.trim().toUpperCase();
            if (!ROOM_CODE_VALID.test(code)) {
              joinErr.textContent = "Invalid room code.";
              return;
            }
            if (room.is_private) {
              const pw = pwdInput.value;
              if (pw.trim().length < 1) {
                joinErr.textContent = "Enter the room password.";
                return;
              }
              exitToGame({
                action: "multiplayer-join",
                roomCode: code,
                password: pw,
              });
              return;
            }
            exitToGame({ action: "multiplayer-join", roomCode: code });
          });
        }

        function showRoomsList(): void {
          backToRoomsBtn.style.display = "none";
          title.textContent = "Rooms";
          bodyStage.replaceChildren();

          const intro = document.createElement("p");
          intro.className = "mm-note";
          intro.style.marginTop = "0";
          intro.textContent =
            client === null
              ? "Configure Supabase to browse rooms. You can still join with a code."
              : "Browse active rooms or host your world for others to join.";
          bodyStage.appendChild(intro);

          const actionsRow = document.createElement("div");
          actionsRow.className = "mm-rooms-actions";
          const hostBtn = makeBtn("Host a world", "mm-btn");
          hostBtn.addEventListener("click", () => openHostWorldFlow());
          const codeBtn = makeBtn("Join with code", "mm-btn mm-btn-subtle");
          codeBtn.addEventListener("click", () => openJoinByCodeModal());
          actionsRow.append(hostBtn, codeBtn);
          bodyStage.appendChild(actionsRow);

          const toolbar = document.createElement("div");
          toolbar.className = "mm-rooms-toolbar";

          const searchField = makeField("Search");
          const searchInput = document.createElement("input");
          searchInput.type = "text";
          searchInput.placeholder = "Name, world, description…";
          searchField.appendChild(searchInput);

          const filterField = makeField("Show");
          const filterSel = document.createElement("select");
          filterSel.className = "mm-select";
          for (const [v, lab] of [
            ["all", "All rooms"],
            ["public", "Public only"],
            ["private", "Private only"],
          ] as const) {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = lab;
            filterSel.appendChild(o);
          }
          filterField.appendChild(filterSel);

          const sortField = makeField("Sort");
          const sortSel = document.createElement("select");
          sortSel.className = "mm-select";
          for (const [v, lab] of [
            ["active", "Most active"],
            ["new", "Newest"],
            ["rating", "Top rated"],
          ] as const) {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = lab;
            sortSel.appendChild(o);
          }
          sortField.appendChild(sortSel);

          const refreshBtn = makeBtn("Refresh", "mm-btn mm-btn-subtle");
          const filterWrap = document.createElement("div");
          filterWrap.style.minWidth = "min(160px, 100%)";
          filterWrap.appendChild(filterField);
          const sortWrap = document.createElement("div");
          sortWrap.style.minWidth = "min(160px, 100%)";
          sortWrap.appendChild(sortField);
          toolbar.append(searchField, filterWrap, sortWrap, refreshBtn);
          bodyStage.appendChild(toolbar);

          const listEl = document.createElement("div");
          listEl.className = "mm-rooms-list";
          bodyStage.appendChild(listEl);

          roomsListEl = listEl;
          searchInputRef = searchInput;
          filterSelRef = filterSel;
          sortSelRef = sortSel;

          refreshBtn.addEventListener("click", () => {
            void loadRooms();
          });
          let searchDebounce: ReturnType<typeof setTimeout> | null = null;
          searchInput.addEventListener("input", () => {
            if (searchDebounce !== null) clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
              searchDebounce = null;
              void loadRooms();
            }, 320);
          });
          filterSel.addEventListener("change", () => {
            void loadRooms();
          });
          sortSel.addEventListener("change", () => {
            void loadRooms();
          });

          void loadRooms();
        }

        backToRoomsBtn.addEventListener("click", () => {
          showRoomsList();
          void loadRooms();
        });

        showRoomsList();

        if (client !== null) {
          onlinePollTimer = setInterval(() => {
            void loadRooms();
          }, 12_000);
        }

        content.appendChild(panel);
      }

      async function renderSettings(): Promise<void> {
        abortSettingsPanel();
        disposeWorkshop();
        disposeSkin();
        disposeProfile();
        content.replaceChildren();
        closeModal();

        const panel = document.createElement("div");
        panel.className = "mm-panel mm-settings-panel";
        content.appendChild(panel);

        settingsPanelAbort = new AbortController();
        await mountSettingsPanel(panel, {
          store,
          getInstalled: () =>
            workshop?.modRepository.getInstalled() ?? [],
          signal: settingsPanelAbort.signal,
          audio: sharedAudio,
        });
      }

      // -- Cleanup -----------------------------------------------------------
      function cleanup(): void {
        clearOnlinePoll();
        abortSettingsPanel();
        disposeWorkshop();
        disposeSkin();
        disposeProfile();
        root.remove();
        void bgPromise; // ensure promise is observed (suppress unhandled rejection lint)
      }

      function exitToGame(menuResult: MainMenuResult): void {
        cleanup();
        resolve({ result: menuResult, menuBackground: bg });
      }

      // -- Assemble ----------------------------------------------------------
      body.appendChild(nav);
      body.appendChild(content);
      root.appendChild(body);
      mount.appendChild(root);

      renderHome();
      if (opts.playStartupIntro === true) {
        void runMainMenuStartupIntro({
          mount,
          menuRoot: root,
          menuLogoEl: brandLogo,
        }).catch((err: unknown) => {
          console.warn("[MainMenu] Startup intro failed:", err);
          root.style.opacity = "1";
          root.style.pointerEvents = "";
          brandLogo.style.opacity = "1";
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

/** World row matching Solo list: thumbnail, name/meta, optional Edit (stops propagation). */
function appendWorldRowToList(
  list: HTMLElement,
  world: WorldMetadata,
  onSelect: () => void,
  edit?: { onEdit: (w: WorldMetadata) => void },
): void {
  const row = document.createElement("div");
  row.className = "mm-world-row";
  const thumbWrap = document.createElement("div");
  thumbWrap.className = "mm-world-thumb";
  const previewUrl = world.previewImageDataUrl;
  if (previewUrl !== undefined && previewUrl.length > 0) {
    const img = document.createElement("img");
    img.src = previewUrl;
    img.alt = "";
    img.decoding = "async";
    thumbWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "mm-world-thumb-empty";
    ph.setAttribute("aria-hidden", "true");
    thumbWrap.appendChild(ph);
  }
  const info = document.createElement("div");
  info.className = "mm-world-info";
  const nameEl = document.createElement("div");
  nameEl.className = "mm-world-name";
  nameEl.textContent = world.name;
  const metaEl = document.createElement("div");
  metaEl.className = "mm-world-meta";
  metaEl.textContent = `Seed ${world.seed} · ${formatDate(world.lastPlayedAt)}`;
  info.appendChild(nameEl);
  info.appendChild(metaEl);
  const descText = world.description?.trim();
  if (descText !== undefined && descText.length > 0) {
    const descEl = document.createElement("div");
    descEl.className = "mm-world-desc";
    descEl.textContent = descText;
    descEl.title = descText;
    info.appendChild(descEl);
  }
  row.appendChild(thumbWrap);
  row.appendChild(info);
  if (edit !== undefined) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "mm-world-edit";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      edit.onEdit(world);
    });
    row.appendChild(editBtn);
  }
  row.addEventListener("click", onSelect);
  list.appendChild(row);
}

function makeField(labelText: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "mm-field";
  const lbl = document.createElement("label");
  lbl.textContent = labelText;
  div.appendChild(lbl);
  return div;
}

function makeBtn(text: string, className: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = text;
  return btn;
}

function safeWorldExportBasename(worldName: string): string {
  const t = worldName.trim().slice(0, 72) || "world";
  const safe = t.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_");
  return `${safe}.stratum-world.json.gz`;
}

function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function triggerCompactWorldDownload(filename: string, data: unknown): void {
  const json = JSON.stringify(data);
  const gz = gzipSync(new TextEncoder().encode(json), { level: 9 });
  const blob = new Blob([new Uint8Array(gz)], { type: "application/gzip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
