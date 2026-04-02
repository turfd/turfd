/**
 * Pre-game main menu — no Game / World imports; resolves via Promise only.
 * Visual: live PixiJS world background (MenuBackground) + pixel-art DOM overlay.
 */
import type { IAuthProvider } from "../../auth/IAuthProvider";
import { mountProfileScreen } from "./ProfileScreen";
import type {
  IndexedDBStore,
  WorldMetadata,
} from "../../persistence/IndexedDBStore";
import { readVolumeStored, VOL_KEYS } from "../../audio/volumeSettings";
import { HOST_PEER_SUFFIX_ALPHABET } from "../../network/hostPeerId";
import {
  getMyRoomRating,
  listStratumRoomComments,
  listStratumRooms,
  postStratumRoomComment,
  setStratumRoomRating,
  type ListedRoom,
} from "../../network/roomDirectoryApi";
import { MenuBackground } from "./MenuBackground";

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
  return Math.floor(Math.random() * 900_000) + 100_000;
}

function parseSeedInput(raw: string): number {
  const t = raw.trim();
  if (t === "") return randomSixDigitSeed();
  const n = parseInt(t, 10);
  return Number.isNaN(n) ? Math.floor(Math.random() * 999_999) : n;
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
    }

    :root {
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
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: unset;
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
      padding: 0.5rem 0.95rem;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
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
      font-size: 14px;
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
      font-size: 17px;
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
      padding: 12px 14px;
      background: var(--mm-surface-deep);
      border: 1px solid transparent;
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 17px;
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
      font-size: 12px;
      letter-spacing: 0.06em;
      opacity: 0.7;
      font-family: 'M5x7', monospace;
    }
    .mm-nav-meta {
      margin-top: auto;
      font-family: 'M5x7', monospace;
      font-size: 15px;
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
      font-size: 19px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink);
      margin: 0 0 1.1rem;
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
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--mm-ink-soft);
    }
    .mm-home-changelog-title {
      margin: 0;
      font-family: 'BoldPixels', monospace;
      font-size: 17px;
      line-height: 1.2;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--mm-ink);
    }
    .mm-home-changelog-cta {
      align-self: flex-start;
      margin-top: 4px;
      padding: 8px 14px;
      font-size: 14px;
      letter-spacing: 0.06em;
    }
    .mm-whats-new::-webkit-scrollbar { width: 4px; }
    .mm-whats-new::-webkit-scrollbar-track { background: transparent; }
    .mm-whats-new::-webkit-scrollbar-thumb {
      background: var(--mm-border-strong);
      border-radius: 4px;
    }
    .mm-whats-new-body {
      font-family: 'M5x7', monospace;
      font-size: 17px;
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
      font-size: 16px;
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
      font-size: 17px;
      color: var(--mm-ink);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mm-world-meta {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      color: var(--mm-ink-soft);
      margin-top: 4px;
      line-height: 1.3;
    }
    .mm-world-edit {
      padding: 8px 13px;
      background: var(--mm-surface-raised);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink-mid);
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
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
      font-size: 17px;
      color: var(--mm-ink-soft);
      text-align: center;
      line-height: 1.45;
    }
    /* Host-world picker modal: same scroll + thumb behavior as Solo */
    .mm-host-world-modal-card {
      display: flex;
      flex-direction: column;
      width: min(40rem, 100%);
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
    .mm-solo-footer {
      display: flex;
      justify-content: flex-start;
      flex-shrink: 0;
    }

    /* ── Action buttons ───────────────────────────── */
    .mm-btn {
      padding: 12px 22px;
      background: var(--mm-ink);
      border: 1px solid var(--mm-ink);
      color: #1c1c1e;
      font-family: 'BoldPixels', monospace;
      font-size: 16px;
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

    /* ── Fields ───────────────────────────────────── */
    .mm-field { margin-bottom: 14px; }
    .mm-field label {
      display: block;
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--mm-ink-soft);
      margin-bottom: 6px;
    }
    .mm-field input[type="text"],
    .mm-field input[type="number"],
    .mm-field input[type="email"],
    .mm-field input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 14px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: 19px;
      border-radius: var(--mm-radius-sm);
      corner-shape: squircle;
      transition: border-color 0.14s ease;
    }
    .mm-field input[type="text"]:focus,
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
      font-size: 17px;
      line-height: 1.5;
      color: var(--mm-ink-mid);
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
      font-size: 16px;
      color: var(--mm-danger);
      min-height: 1.25em;
      margin-top: 10px;
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
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink-soft);
      width: 104px;
      flex-shrink: 0;
    }
    .mm-settings-row input[type="range"] {
      flex: 1;
      accent-color: #aeaeb2;
    }
    .mm-settings-val {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      color: var(--mm-ink-mid);
      width: 40px;
      text-align: right;
    }
    .mm-settings-section {
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
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
      font-size: 17px;
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
      padding: 1.35rem 1.5rem;
      animation: mm-modal-card-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .mm-modal-title {
      font-family: 'BoldPixels', monospace;
      font-size: 20px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink);
      margin: 0 0 1.1rem;
    }
    .mm-modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 1.25rem;
    }
    .mm-modal-meta {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      color: var(--mm-ink-soft);
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .mm-modal-feedback {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      color: var(--mm-ink-mid);
      min-height: 1.2em;
      margin-top: 8px;
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
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--mm-ink);
    }
    .mm-rooms-row-meta {
      font-family: 'M5x7', monospace;
      font-size: 15px;
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
    .mm-comments-list { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
    .mm-comment-item {
      padding: 10px 12px;
      background: var(--mm-surface-deep);
      border-radius: var(--mm-radius-sm);
      border: 1px solid var(--mm-border);
    }
    .mm-comment-author {
      font-family: 'BoldPixels', monospace;
      font-size: 12px;
      color: var(--mm-ink-mid);
      margin-bottom: 4px;
    }
    .mm-comment-body {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      color: var(--mm-ink-mid);
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .mm-stars-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
    .mm-star-btn {
      min-width: 36px;
      padding: 6px 8px;
      font-family: 'M5x7', monospace;
      font-size: 15px;
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
      padding: 10px 12px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: 17px;
      border-radius: var(--mm-radius-sm);
      cursor: pointer;
    }
    textarea.mm-textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 88px;
      padding: 12px 14px;
      background: var(--mm-surface-deep);
      border: 1px solid var(--mm-border);
      color: var(--mm-ink);
      font-family: 'M5x7', monospace;
      font-size: 17px;
      border-radius: var(--mm-radius-sm);
      resize: vertical;
    }

    /* ── Online: glass panel (match in-game chat chrome) ─────────────── */
    .mm-online-panel.mm-panel--glass {
      background: rgba(36, 36, 38, 0.42);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.07);
      box-shadow: 0 3px 14px rgba(0, 0, 0, 0.22);
      padding: clamp(1.1rem, 2.5vw, 1.5rem) clamp(1.15rem, 2.8vw, 1.65rem);
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
    .mm-room-glass-card {
      background: rgba(44, 44, 46, 0.38);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: var(--mm-radius-md);
      corner-shape: squircle;
      padding: 1.15rem 1.25rem;
      box-sizing: border-box;
    }
    .mm-room-section-kicker {
      font-family: 'BoldPixels', monospace;
      font-size: 11px;
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
      font-size: 14px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid rgba(255, 255, 255, 0.08);
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
    .mm-room-detail-scroll::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
    }
    .mm-comment-item {
      background: rgba(0, 0, 0, 0.18);
      border-color: rgba(255, 255, 255, 0.06);
    }
    .mm-placeholder-block {
      border: 1px dashed rgba(255, 255, 255, 0.14);
      border-radius: var(--mm-radius-sm);
      padding: 1.35rem 1.15rem;
      text-align: center;
      background: rgba(0, 0, 0, 0.12);
    }
    .mm-placeholder-block-title {
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mm-ink-mid);
      margin: 0 0 8px;
    }
    .mm-placeholder-block-body {
      font-family: 'M5x7', monospace;
      font-size: 16px;
      line-height: 1.5;
      color: var(--mm-ink-soft);
      margin: 0;
      max-width: 28rem;
      margin-left: auto;
      margin-right: auto;
    }
    .mm-room-join-footer {
      flex-shrink: 0;
      margin-top: auto;
      padding-top: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
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
    .mm-online-panel .mm-rooms-list {
      background: rgba(0, 0, 0, 0.2);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .mm-online-panel .mm-rooms-row {
      border-bottom-color: rgba(255, 255, 255, 0.06);
    }
    .mm-online-panel .mm-field input,
    .mm-online-panel .mm-select,
    .mm-online-panel textarea.mm-textarea {
      background: rgba(36, 36, 38, 0.45);
      border-color: rgba(255, 255, 255, 0.09);
    }

    @media (prefers-reduced-motion: reduce) {
      .mm-nav-btn, .mm-btn, .mm-discord, .mm-world-row { transition: none; }
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
  Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus
  condimentum, nisl sed fermentum ullamcorper, mauris risus congue
  justo, vitae interdum lorem sem sed justo. Curabitur in arcu sed
  magna varius feugiat.
`.trim();

// ---------------------------------------------------------------------------
// MainMenu
// ---------------------------------------------------------------------------

type NavTab = "solo" | "online" | "settings" | "profile";

export class MainMenu {
  static async show(
    mount: HTMLElement,
    store: IndexedDBStore,
    auth: IAuthProvider,
  ): Promise<MainMenuResult> {
    const base = import.meta.env.BASE_URL;
    injectStyles(base);

    // Start background world initialisation in parallel with DOM build
    const bg = new MenuBackground();
    const bgPromise = bg.init(mount).catch((err: unknown) => {
      console.warn("[MainMenu] Background world failed to load:", err);
    });

    return new Promise<MainMenuResult>((resolve) => {
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
        window.open("https://discord.gg/stratum", "_blank", "noopener");
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
      brandLogo.src = `${base}assets/textures/logo.png`;
      brandLogo.alt = "Stratum";
      brand.appendChild(brandLogo);
      nav.appendChild(brand);

      const navList = document.createElement("div");
      navList.className = "mm-nav-list";
      nav.appendChild(navList);

      let activeTab: NavTab | null = null;
      const navBtns = new Map<NavTab, HTMLButtonElement>();

      let profileUnmount: (() => void) | null = null;

      function disposeProfile(): void {
        if (profileUnmount !== null) {
          profileUnmount();
          profileUnmount = null;
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
        { id: "settings", label: "Settings" },
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
              renderHome();
            } else {
              setActiveTab(tab);
              renderTab(tab);
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
          cleanup();
          resolve({ action: "new", name, seed });
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

      function openEditModal(
        world: WorldMetadata,
        rerenderList: () => Promise<void>,
      ): void {
        closeModal();
        const modal = document.createElement("div");
        modal.className = "mm-modal";
        const card = document.createElement("div");
        card.className = "mm-modal-card";

        const heading = document.createElement("h3");
        heading.className = "mm-modal-title";
        heading.textContent = "Edit World";

        const nameField = makeField("World name");
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = world.name;
        nameField.appendChild(nameInput);

        const meta = document.createElement("p");
        meta.className = "mm-modal-meta";
        meta.textContent = `Seed ${world.seed} · ${formatDate(world.lastPlayedAt)}`;

        const feedback = document.createElement("div");
        feedback.className = "mm-modal-feedback";

        const actions = document.createElement("div");
        actions.className = "mm-modal-actions";
        const closeBtn = makeBtn("Close", "mm-btn mm-btn-subtle");
        closeBtn.addEventListener("click", closeModal);
        const deleteBtn = makeBtn("Delete", "mm-btn mm-btn-danger");
        deleteBtn.addEventListener("click", () => {
          if (pendingDeleteUuid !== world.uuid) {
            pendingDeleteUuid = world.uuid;
            deleteBtn.textContent = "Confirm Delete";
            feedback.textContent = "Press again to permanently delete this world.";
            return;
          }
          void store.deleteWorld(world.uuid).then(async () => {
            closeModal();
            await rerenderList();
          });
        });
        const saveBtn = makeBtn("Save", "mm-btn");
        saveBtn.addEventListener("click", () => {
          const nextName = nameInput.value.trim() || "My World";
          void store.renameWorld(world.uuid, nextName).then(async () => {
            feedback.textContent = "Saved.";
            await rerenderList();
            closeModal();
          });
        });
        actions.appendChild(closeBtn);
        actions.appendChild(deleteBtn);
        actions.appendChild(saveBtn);

        card.appendChild(heading);
        card.appendChild(nameField);
        card.appendChild(meta);
        card.appendChild(feedback);
        card.appendChild(actions);
        modal.appendChild(card);
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeModal();
        });
        root.appendChild(modal);
        nameInput.focus();
      }

      // -- Render functions --------------------------------------------------

      function renderHome(): void {
        disposeProfile();
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
        wnHeading.textContent = "Patch Notes - Update 4";
        wnCopy.appendChild(wnHeading);

        const wnBody = document.createElement("div");
        wnBody.className = "mm-whats-new-body";
        wnBody.innerHTML = WHATS_NEW_HTML;
        wnCopy.appendChild(wnBody);

        const readMoreBtn = makeBtn("Read More", "mm-btn mm-btn-subtle mm-home-changelog-cta");
        readMoreBtn.addEventListener("click", () => {
          // Placeholder CTA until changelog route/details view is implemented.
          window.open("https://discord.gg/stratum", "_blank", "noopener");
        });
        wnCopy.appendChild(readMoreBtn);

        wnCard.appendChild(wnCopy);
        wnPanel.appendChild(wnCard);

        content.appendChild(wnPanel);
      }

      function renderTab(tab: NavTab): void {
        content.classList.remove("mm-content-home");
        content.classList.add("mm-content-tab");
        if (tab === "solo") renderSolo();
        else if (tab === "online") renderOnline();
        else if (tab === "settings") renderSettings();
        else if (tab === "profile") renderProfile();
      }

      function renderProfile(): void {
        disposeProfile();
        content.replaceChildren();
        closeModal();
        profileUnmount = mountProfileScreen(content, auth);
      }

      function renderSolo(): void {
        disposeProfile();
        content.replaceChildren();
        closeModal();

        const panel = document.createElement("div");
        panel.className = "mm-panel mm-solo-panel";

        const title = document.createElement("p");
        title.className = "mm-panel-title";
        title.textContent = "Worlds";
        panel.appendChild(title);

        const list = document.createElement("div");
        list.className = "mm-worldlist";
        panel.appendChild(list);

        // Stale-update guard: if list is detached, skip re-render
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
              cleanup();
              resolve({ action: "load", uuid: world.uuid });
            }, {
              onEdit: (w) => {
                openEditModal(w, rerenderList);
              },
            });
          }
        };

        const footer = document.createElement("div");
        footer.className = "mm-solo-footer";
        const createBtn = makeBtn("New World", "mm-btn");
        createBtn.addEventListener("click", openCreateModal);
        footer.appendChild(createBtn);
        panel.appendChild(footer);

        content.appendChild(panel);
        void rerenderList();
      }

      function loadHostPrefs(): {
        roomTitle: string;
        motd: string;
        isPrivate: boolean;
        worldUuid: string;
      } {
        try {
          const raw = localStorage.getItem(STRATUM_ROOM_HOST_PREFS_KEY);
          if (raw === null) {
            return {
              roomTitle: "",
              motd: "",
              isPrivate: false,
              worldUuid: "",
            };
          }
          const j = JSON.parse(raw) as Record<string, unknown>;
          return {
            roomTitle: typeof j.roomTitle === "string" ? j.roomTitle : "",
            motd: typeof j.motd === "string" ? j.motd : "",
            isPrivate: j.isPrivate === true,
            worldUuid: typeof j.worldUuid === "string" ? j.worldUuid : "",
          };
        } catch {
          return {
            roomTitle: "",
            motd: "",
            isPrivate: false,
            worldUuid: "",
          };
        }
      }

      function saveHostPrefs(p: {
        roomTitle: string;
        motd: string;
        isPrivate: boolean;
        worldUuid: string;
      }): void {
        localStorage.setItem(
          STRATUM_ROOM_HOST_PREFS_KEY,
          JSON.stringify({
            roomTitle: p.roomTitle,
            motd: p.motd,
            isPrivate: p.isPrivate,
            worldUuid: p.worldUuid,
          }),
        );
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
          cleanup();
          resolve({ action: "multiplayer-join", roomCode: code });
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
              openHostDetailsModal(w.uuid, prefs);
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

      function openHostDetailsModal(
        worldUuid: string,
        prefs: ReturnType<typeof loadHostPrefs>,
      ): void {
        closeModal();
        const modal = document.createElement("div");
        modal.className = "mm-modal";
        const card = document.createElement("div");
        card.className = "mm-modal-card";

        const heading = document.createElement("h3");
        heading.className = "mm-modal-title";
        heading.textContent = "Room details";

        const titleField = makeField(`Room name (max ${ROOM_TITLE_MAX_LEN})`);
        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.maxLength = ROOM_TITLE_MAX_LEN;
        titleInput.value =
          prefs.worldUuid === worldUuid && prefs.roomTitle.trim() !== ""
            ? prefs.roomTitle
            : "My room";
        titleField.appendChild(titleInput);

        const motdField = makeField(`Description / MOTD (max ${ROOM_MOTD_MAX_LEN})`);
        const motdInput = document.createElement("textarea");
        motdInput.className = "mm-textarea";
        motdInput.maxLength = ROOM_MOTD_MAX_LEN;
        motdInput.value = prefs.motd;
        motdField.appendChild(motdInput);

        const countEl = document.createElement("p");
        countEl.className = "mm-modal-meta";
        const updateCount = (): void => {
          countEl.textContent = `${motdInput.value.length} / ${ROOM_MOTD_MAX_LEN} characters`;
        };
        updateCount();
        motdInput.addEventListener("input", updateCount);

        const privRow = document.createElement("div");
        privRow.className = "mm-settings-row";
        privRow.style.marginBottom = "8px";
        const privLab = document.createElement("label");
        privLab.textContent = "Private";
        const privCb = document.createElement("input");
        privCb.type = "checkbox";
        privCb.checked = prefs.isPrivate;
        privRow.appendChild(privLab);
        privRow.appendChild(privCb);

        const passField = makeField("Room password (min 4, not saved in browser)");
        const passInput = document.createElement("input");
        passInput.type = "password";
        passInput.autocomplete = "new-password";
        passField.appendChild(passInput);

        const syncPassField = (): void => {
          passField.style.display = privCb.checked ? "block" : "none";
        };
        syncPassField();
        privCb.addEventListener("change", syncPassField);

        const errEl = document.createElement("div");
        errEl.className = "mm-feedback-error";

        const actions = document.createElement("div");
        actions.className = "mm-modal-actions";
        const backBtn = makeBtn("Back", "mm-btn mm-btn-subtle");
        backBtn.addEventListener("click", () => {
          modal.remove();
          openHostWorldFlow();
        });
        const hostBtn = makeBtn("Host", "mm-btn");
        hostBtn.addEventListener("click", () => {
          const roomTitle = titleInput.value.trim();
          if (roomTitle.length < 1) {
            errEl.textContent = "Enter a room name.";
            return;
          }
          const motd = motdInput.value.slice(0, ROOM_MOTD_MAX_LEN);
          const isPrivate = privCb.checked;
          const pw = passInput.value;
          if (isPrivate && pw.trim().length < 4) {
            errEl.textContent = "Private rooms need a password of at least 4 characters.";
            return;
          }
          saveHostPrefs({
            roomTitle,
            motd,
            isPrivate,
            worldUuid,
          });
          cleanup();
          resolve({
            action: "multiplayer-host",
            worldUuid,
            roomTitle,
            motd,
            isPrivate,
            roomPassword: isPrivate ? pw : undefined,
          });
        });
        actions.appendChild(backBtn);
        actions.appendChild(hostBtn);

        card.appendChild(heading);
        card.appendChild(titleField);
        card.appendChild(motdField);
        card.appendChild(countEl);
        card.appendChild(privRow);
        card.appendChild(passField);
        card.appendChild(errEl);
        card.appendChild(actions);
        modal.appendChild(card);
        modal.addEventListener("click", (ev) => {
          if (ev.target === modal) closeModal();
        });
        root.appendChild(modal);
        titleInput.focus();
      }

      function renderOnline(): void {
        disposeProfile();
        content.replaceChildren();
        closeModal();
        clearOnlinePoll();

        const client = auth.getSupabaseClient();
        const panel = document.createElement("div");
        panel.className = "mm-panel mm-online-panel mm-panel--glass";

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
          aboutCard.className = "mm-room-glass-card";
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
          commentsCard.className = "mm-room-glass-card";
          const kComm = document.createElement("p");
          kComm.className = "mm-room-section-kicker";
          kComm.textContent = "Comments";
          commentsCard.appendChild(kComm);
          const commentsList = document.createElement("div");
          commentsList.className = "mm-comments-list";
          commentsCard.appendChild(commentsList);
          scroll.appendChild(commentsCard);

          const participate = document.createElement("section");
          participate.className = "mm-room-glass-card";
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
              cleanup();
              resolve({
                action: "multiplayer-join",
                roomCode: code,
                password: pw,
              });
              return;
            }
            cleanup();
            resolve({ action: "multiplayer-join", roomCode: code });
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

      function renderSettings(): void {
        disposeProfile();
        content.replaceChildren();
        closeModal();

        const panel = document.createElement("div");
        panel.className = "mm-panel mm-settings-panel";

        const title = document.createElement("p");
        title.className = "mm-panel-title";
        title.textContent = "Settings";
        panel.appendChild(title);

        const volSection = document.createElement("div");
        volSection.className = "mm-settings-section";
        volSection.textContent = "Volume";
        panel.appendChild(volSection);

        const volumeSliders: Array<{
          label: string;
          key: string;
          def: number;
        }> = [
          { label: "Master", key: VOL_KEYS.master, def: 80 },
          { label: "Music", key: VOL_KEYS.music, def: 60 },
          { label: "SFX", key: VOL_KEYS.sfx, def: 80 },
        ];
        for (const { label, key, def } of volumeSliders) {
          const row = document.createElement("div");
          row.className = "mm-settings-row";
          const lbl = document.createElement("label");
          lbl.textContent = label;
          const slider = document.createElement("input");
          slider.type = "range";
          slider.min = "0";
          slider.max = "100";
          slider.value = String(readVolumeStored(key, def));
          const val = document.createElement("span");
          val.className = "mm-settings-val";
          val.textContent = slider.value;
          slider.addEventListener("input", () => {
            val.textContent = slider.value;
            localStorage.setItem(key, slider.value);
          });
          row.appendChild(lbl);
          row.appendChild(slider);
          row.appendChild(val);
          panel.appendChild(row);
        }

        const bindSection = document.createElement("div");
        bindSection.className = "mm-settings-section";
        bindSection.textContent = "Controls";
        panel.appendChild(bindSection);
        const comingSoon = document.createElement("p");
        comingSoon.className = "mm-settings-coming-soon";
        comingSoon.textContent = "Key rebinding coming in a future update.";
        panel.appendChild(comingSoon);

        content.appendChild(panel);
      }

      // -- Cleanup -----------------------------------------------------------
      function cleanup(): void {
        clearOnlinePoll();
        disposeProfile();
        root.remove();
        // Destroy background: the destroyed flag stops init() mid-flight if still running.
        // main.ts calls mount.replaceChildren() next, which removes any residual canvas.
        bg.destroy();
        void bgPromise; // ensure promise is observed (suppress unhandled rejection lint)
      }

      // -- Assemble ----------------------------------------------------------
      body.appendChild(nav);
      body.appendChild(content);
      root.appendChild(body);
      mount.appendChild(root);

      renderHome();
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
