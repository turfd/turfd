/** Main-menu Skins tab: Bedrock-style categories + grid + preview (DOM). */

import type { IAuthProvider } from "../../auth/IAuthProvider";
import { DEFAULT_SKIN_ID, PLAYER_BODY_REQUIRED_FRAME_COUNT } from "../../core/constants";
import {
  DEFAULT_PLAYER_NAME_COLOR_HEX,
  DEFAULT_PLAYER_OUTLINE_COLOR_HEX,
  allowedPresetColorsForTier,
  canUseCustomColor,
  cosmeticTierFromRaw,
  sanitizeColorForTier,
  type DonatorTier,
} from "../../core/playerCosmetics";
import { getDiscordEntitlement } from "../../network/discordEntitlementApi";
import { IndexedDBStore } from "../../persistence/IndexedDBStore";
import {
  builtinSkinEntries,
  customSkinEntries,
  stringifySkinRef,
  validateSkinBlob,
} from "../../skins/SkinRegistry";
import type { SkinEntry } from "../../skins/skinTypes";
import { ensureMenuColorPickerStyles, openColorPickerDialog } from "../menuColorPicker";
import { ensureNametagFonts } from "../NametagOverlay";
import {
  mountSkinMenuPreviewWithOutline,
  type SkinMenuPreviewController,
} from "../skinMenuPreviewPixi";

const STYLES_ID = "stratum-skin-screen-styles";

type SkinCategory = "default" | "custom";

function injectStyles(): void {
  if (document.getElementById(STYLES_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLES_ID;
  style.textContent = `
    .mm-skins-panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      max-width: 100%;
    }
    .stratum-skins-inner {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .stratum-skins-layout {
      display: grid;
      grid-template-columns: minmax(140px, 170px) minmax(0, 1fr) minmax(200px, 260px);
      gap: 14px 18px;
      flex: 1;
      min-height: 0;
      align-items: stretch;
    }
    @media (max-width: 900px) {
      .stratum-skins-layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto auto auto;
      }
    }
    .stratum-skins-cats {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 4px 0;
    }
    .stratum-skins-cat {
      text-align: left;
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 14px);
      line-height: 18px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 10px 12px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: var(--mm-ink-mid, #aeaeb2);
      cursor: pointer;
    }
    .stratum-skins-cat:hover {
      background: rgba(255,255,255,0.07);
      color: var(--mm-ink, #f2f2f7);
    }
    .stratum-skins-cat.stratum-skins-cat--active {
      border-color: var(--mm-accent, #6ec6ff);
      color: var(--mm-ink, #f2f2f7);
      background: rgba(110,198,255,0.1);
    }
    .stratum-skins-center {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.1));
      border-radius: var(--mm-radius-md, 10px);
      corner-shape: squircle;
      padding: 12px 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(0,0,0,0.14));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
    }
    .stratum-skins-grid-title {
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 13px);
      line-height: 18px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--mm-ink, #f2f2f7);
      margin: 0 0 10px;
    }
    .stratum-skins-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
      gap: 10px;
      overflow-y: auto;
      flex: 1;
      min-height: 200px;
      max-height: min(460px, 52vh);
      padding: 2px;
      align-content: start;
    }
    .skin-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      cursor: pointer;
      border: 2px solid transparent;
      border-radius: 6px;
      padding: 10px 8px 8px;
      background: rgba(255,255,255,0.03);
      overflow: hidden;
      box-sizing: border-box;
      min-height: 132px;
    }
    .skin-card:hover { background: rgba(255,255,255,0.06); }
    .skin-card.skin-card--active {
      border-color: var(--mm-accent, #6ec6ff);
      background: rgba(110,198,255,0.08);
    }
    .skin-card-label {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(16px + var(--mm-m5-nudge, 4px)));
      color: var(--mm-ink-mid, #aeaeb2);
      text-align: center;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 28px;
    }
    .skin-card--upload {
      justify-content: center;
      gap: 10px;
      min-height: 132px;
      border-style: dashed;
      border-color: rgba(255,255,255,0.14);
    }
    .skin-card--upload:hover { border-color: rgba(255,255,255,0.28); }
    .skin-upload-icon {
      font-size: 26px;
      color: var(--mm-ink-mid, #aeaeb2);
      line-height: 1;
    }
    .skin-upload-label {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(13px + var(--mm-m5-nudge, 4px)));
      color: var(--mm-ink-mid, #aeaeb2);
      line-height: 26px;
    }
    .stratum-skins-preview {
      display: flex;
      flex-direction: column;
      gap: 0;
      border: 1px solid var(--mm-border, rgba(255,255,255,0.12));
      border-radius: var(--mm-radius-md, 10px);
      corner-shape: squircle;
      padding: 16px 14px 18px;
      background: linear-gradient(
        165deg,
        rgba(255,255,255,0.06) 0%,
        rgba(0,0,0,0.22) 48%,
        rgba(0,0,0,0.32) 100%
      );
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.06),
        0 8px 28px rgba(0,0,0,0.2);
      min-height: 0;
      flex: 1;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .skin-preview-eyebrow {
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 10px);
      line-height: 14px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--mm-ink-soft, #8e8e93);
      margin: 0 0 10px;
      padding-top: 2px;
    }
    .stratum-skins-preview-canvas-wrap {
      display: flex;
      flex-direction: column;
      flex: 0 0 auto;
      gap: 6px;
      /* Definite block size so Pixi resizeTo + % heights resolve (was 0×0 → empty preview). */
      height: clamp(160px, 32vh, 236px);
      min-height: 152px;
      max-height: min(44vh, 280px);
      background:
        radial-gradient(ellipse 80% 70% at 50% 78%, rgba(110,198,255,0.09), transparent 55%),
        radial-gradient(ellipse 100% 80% at 50% 100%, rgba(0,0,0,0.45), transparent 50%),
        linear-gradient(180deg, #141418 0%, #0a0a0c 100%);
      border-radius: var(--mm-radius-sm, 8px);
      corner-shape: squircle;
      padding: 10px 8px 8px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.07);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.35);
    }
    /* Match {@link NametagOverlay} (in-world label). */
    .skin-preview-nametag {
      font-family: 'M5x7', monospace;
      font-size: 20px;
      line-height: 24px;
      text-shadow: 0 1px 2px #000, 0 0 4px #000;
      white-space: nowrap;
      max-width: 100%;
      box-sizing: border-box;
      padding: 0 5px;
      margin: 0 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
      pointer-events: none;
      flex-shrink: 0;
      color: #f2f2f7;
    }
    .stratum-skins-preview-pixi-host {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      height: 100%;
      position: relative;
      filter: drop-shadow(0 6px 12px rgba(0,0,0,0.35));
    }
    .skin-preview-name {
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 13px);
      color: var(--mm-ink, #f2f2f7);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: center;
      margin: 8px 6px 12px;
      line-height: 20px;
      text-wrap: balance;
    }
    .skin-preview-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 14px;
    }
    .skin-preview-actions .mm-btn {
      width: 100%;
      min-height: 44px;
      font-size: max(var(--mm-bold-min), calc(var(--mm-type-ui, 14px) - 1px));
    }
    .skin-outline-stack {
      margin-top: 0;
      border-top: 1px solid var(--mm-border, rgba(255,255,255,0.1));
      padding-top: 12px;
    }
    .skin-outline-toggle {
      width: 100%;
      box-sizing: border-box;
      margin-top: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      text-align: left;
      padding: 8px 10px;
      min-height: 40px;
    }
    .skin-outline-toggle-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: max(var(--mm-bold-min), 11px);
      letter-spacing: 0.04em;
    }
    .skin-outline-toggle-swatch {
      width: 20px;
      height: 20px;
      border-radius: 6px;
      corner-shape: squircle;
      border: 2px solid var(--mm-border, rgba(255,255,255,0.2));
      flex-shrink: 0;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.4) inset;
    }
    .skin-outline-toggle.skin-outline-toggle--open .skin-outline-toggle-swatch {
      display: none;
    }
    .skin-outline-toggle-chevron {
      width: 9px;
      height: 9px;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: rotate(45deg);
      flex-shrink: 0;
      margin-top: -3px;
      opacity: 0.65;
      transition: transform 0.2s ease, opacity 0.15s ease;
    }
    .skin-outline-toggle.skin-outline-toggle--open .skin-outline-toggle-chevron {
      transform: rotate(225deg);
      margin-top: 3px;
      opacity: 0.9;
    }
    .skin-outline-panel {
      margin-top: 6px;
      padding: 6px 8px 6px;
      border-radius: var(--mm-radius-sm, 8px);
      corner-shape: squircle;
      background: rgba(0,0,0,0.22);
      border: 1px solid rgba(255,255,255,0.07);
      overflow: visible;
    }
    .skin-outline-lede {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(11px + var(--mm-m5-nudge, 4px)));
      color: var(--mm-ink-mid, #8e8e93);
      line-height: 26px;
      margin: 0 0 4px;
    }
    .skin-outline-swatches .skin-outline-custom-swatch {
      box-sizing: border-box;
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 8px;
      corner-shape: squircle;
      border: 2px solid var(--mm-border, rgba(255,255,255,0.18));
      cursor: pointer;
      flex-shrink: 0;
      background:
        conic-gradient(
          from 0deg,
          #f87171,
          #fbbf24,
          #4ade80,
          #22d3ee,
          #818cf8,
          #e879f9,
          #f87171
        );
      box-shadow:
        inset 0 0 0 1px rgba(0,0,0,0.28),
        inset 0 1px 0 rgba(255,255,255,0.15);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.12s ease, transform 0.12s ease;
    }
    .skin-outline-swatches .skin-outline-custom-swatch:hover {
      border-color: var(--mm-ink-mid, #aeaeb2);
      transform: scale(1.04);
    }
    .skin-outline-swatches .skin-outline-custom-swatch.stratum-cp-swatch--active {
      border-color: var(--mm-accent, #6ec6ff);
      box-shadow:
        0 0 0 1px rgba(0,0,0,0.45) inset,
        0 0 0 2px var(--mm-accent, #6ec6ff);
    }
    .skin-outline-swatches .skin-outline-custom-swatch-icon {
      color: #fff;
      filter: drop-shadow(0 0 2px rgba(0,0,0,0.85));
      pointer-events: none;
    }
    .skin-preview-canvas {
      border-radius: 3px;
    }
    .skin-preview-hint {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(13px + var(--mm-m5-nudge, 4px)));
      color: var(--mm-ink-mid, #8e8e93);
      line-height: 30px;
      margin: 10px 0 0;
      padding: 12px 0 4px;
      border-top: 1px dashed rgba(255,255,255,0.08);
    }
    .skin-delete-btn {
      background: rgba(255,69,58,0.06);
      border: 1px solid rgba(255,80,80,0.32);
      border-radius: var(--mm-radius-sm, 8px);
      corner-shape: squircle;
      color: #ff6b6b;
      font-family: 'BoldPixels', monospace;
      font-size: max(var(--mm-bold-min), 11px);
      line-height: 16px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      cursor: pointer;
      padding: 10px 12px;
      min-height: 40px;
      width: 100%;
      transition: background 0.12s ease;
    }
    .skin-delete-btn:hover { background: rgba(255,80,80,0.12); }
    .mm-skins-feedback--ok {
      font-family: 'M5x7', monospace;
      font-size: max(var(--mm-m5-min), calc(19px + var(--mm-m5-nudge, 4px)));
      color: #5daf8c;
      line-height: 28px;
      min-height: 1.25em;
      margin-top: 10px;
    }
    .skin-outline-swatches {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      margin-top: 0;
      margin-bottom: 0;
    }
    .skin-outline-swatches .stratum-cp-swatch--compact {
      width: 28px;
      height: 28px;
      border-radius: 8px;
    }
    .skin-card.skin-card--skel {
      cursor: default;
      pointer-events: none;
      border-style: dashed;
      border-color: rgba(255, 255, 255, 0.07);
      background: rgba(255, 255, 255, 0.02);
    }
    .skin-skel-thumb {
      width: 48px;
      height: 96px;
      border-radius: 4px;
    }
    .skin-preview-skel-wrap {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: min(280px, 36vh);
    }
    .skin-preview-skel-figure {
      width: 72px;
      height: 144px;
      border-radius: 6px;
      flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
}

function applySkinCanvasStyle(canvas: HTMLCanvasElement, w: number, h: number): void {
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  canvas.style.flexShrink = "0";
  canvas.style.setProperty("position", "static", "important");
  canvas.style.setProperty("left", "auto", "important");
  canvas.style.setProperty("top", "auto", "important");
  canvas.style.setProperty("transform", "none", "important");
  canvas.style.setProperty("z-index", "auto", "important");
  canvas.style.setProperty("pointer-events", "none", "important");
}

function drawIdleFramePreview(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const frameW = Math.floor(img.naturalWidth / PLAYER_BODY_REQUIRED_FRAME_COUNT);
  const frameH = img.naturalHeight;
  if (frameW <= 0 || frameH <= 0) {
    return;
  }
  canvas.width = frameW;
  canvas.height = frameH;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, frameW, frameH);
  ctx.drawImage(img, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
}

function animateWalkPreview(canvas: HTMLCanvasElement, img: HTMLImageElement): () => void {
  const frameW = Math.floor(img.naturalWidth / PLAYER_BODY_REQUIRED_FRAME_COUNT);
  const frameH = img.naturalHeight;
  if (frameW <= 0 || frameH <= 0) {
    return () => {};
  }
  canvas.width = frameW;
  canvas.height = frameH;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return () => {};
  }
  ctx.imageSmoothingEnabled = false;
  const walkIndices = [1, 2, 3, 4];
  let idx = 0;
  const draw = (): void => {
    const fi = walkIndices[idx % walkIndices.length]!;
    ctx.clearRect(0, 0, frameW, frameH);
    ctx.drawImage(img, fi * frameW, 0, frameW, frameH, 0, 0, frameW, frameH);
    idx++;
  };
  draw();
  const id = setInterval(draw, 180);
  return () => clearInterval(id);
}

/**
 * Mount the Skins tab into `container`. Custom uploads require a signed-in session.
 */
export function mountSkinScreen(
  container: HTMLElement,
  auth: IAuthProvider,
): () => void {
  const allowCustom = auth.getSession() !== null;
  injectStyles();
  ensureNametagFonts();

  const root = document.createElement("div");
  root.className = "mm-panel mm-skins-panel";

  let cleaned = false;
  let skinPreviewCtl: SkinMenuPreviewController | null = null;
  let selectedSkinId = DEFAULT_SKIN_ID;
  let category: SkinCategory = "default";
  let previewEntry: SkinEntry | null = null;
  let previewDispose: (() => void) | null = null;
  const blobUrls: string[] = [];
  let outlineColorHex = DEFAULT_PLAYER_OUTLINE_COLOR_HEX;
  let outlineDonatorTier: DonatorTier = "none";
  let nameColorHex = DEFAULT_PLAYER_NAME_COLOR_HEX;
  let displayNameForPreview = auth.getDisplayLabel();

  const store = new IndexedDBStore();

  const feedback = document.createElement("div");
  feedback.setAttribute("aria-live", "polite");

  const setFeedback = (text: string, kind: "err" | "ok" | "clear"): void => {
    feedback.textContent = text;
    if (kind === "err") {
      feedback.className = "mm-feedback-error";
    } else if (kind === "ok") {
      feedback.className = "mm-skins-feedback--ok";
    } else {
      feedback.className = "mm-feedback-error";
      feedback.textContent = "";
    }
  };

  const layout = document.createElement("div");
  layout.className = "stratum-skins-layout";

  const catCol = document.createElement("aside");
  catCol.className = "stratum-skins-cats";
  const btnDefault = document.createElement("button");
  btnDefault.type = "button";
  btnDefault.className = "stratum-skins-cat stratum-skins-cat--active";
  btnDefault.textContent = "Default";
  const btnCustom = document.createElement("button");
  btnCustom.type = "button";
  btnCustom.className = "stratum-skins-cat";
  btnCustom.textContent = "My skins";
  catCol.appendChild(btnDefault);
  if (allowCustom) {
    catCol.appendChild(btnCustom);
  }

  const center = document.createElement("section");
  center.className = "stratum-skins-center";
  const gridTitle = document.createElement("p");
  gridTitle.className = "stratum-skins-grid-title";
  const grid = document.createElement("div");
  grid.className = "stratum-skins-grid";
  center.appendChild(gridTitle);
  center.appendChild(grid);

  const previewCol = document.createElement("aside");
  previewCol.className = "stratum-skins-preview";
  const previewEyebrow = document.createElement("p");
  previewEyebrow.className = "skin-preview-eyebrow";
  previewEyebrow.textContent = "Preview";
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "stratum-skins-preview-canvas-wrap";
  const previewNametag = document.createElement("div");
  previewNametag.className = "skin-preview-nametag";
  previewNametag.setAttribute("aria-hidden", "true");
  const previewPixiHost = document.createElement("div");
  previewPixiHost.className = "stratum-skins-preview-pixi-host";
  canvasWrap.appendChild(previewNametag);
  canvasWrap.appendChild(previewPixiHost);

  const syncNametagChrome = (): void => {
    previewNametag.textContent = displayNameForPreview;
    previewNametag.style.color =
      nameColorHex.trim() !== "" ? nameColorHex : DEFAULT_PLAYER_NAME_COLOR_HEX;
  };

  const refreshDisplayName = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    if (!auth.isConfigured || auth.getSession() === null) {
      displayNameForPreview = auth.getDisplayLabel();
    } else {
      const prof = await auth.getProfile();
      displayNameForPreview = prof?.username?.trim() || auth.getDisplayLabel();
    }
    syncNametagChrome();
  };
  const previewName = document.createElement("div");
  previewName.className = "skin-preview-name";
  const selectBtn = document.createElement("button");
  selectBtn.type = "button";
  selectBtn.className = "mm-btn";
  selectBtn.textContent = "Select this skin";
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "skin-delete-btn";
  deleteBtn.textContent = "Remove custom skin";
  deleteBtn.style.display = "none";
  const actionsWrap = document.createElement("div");
  actionsWrap.className = "skin-preview-actions";
  actionsWrap.appendChild(selectBtn);
  actionsWrap.appendChild(deleteBtn);
  const outlinePanelId = `stratum-skin-outline-${crypto.randomUUID()}`;
  const outlineToggle = document.createElement("button");
  outlineToggle.type = "button";
  outlineToggle.className = "mm-btn mm-btn-subtle skin-outline-toggle";
  outlineToggle.setAttribute("aria-expanded", "false");
  outlineToggle.setAttribute("aria-controls", outlinePanelId);
  outlineToggle.title = "Donor outline glow color";
  outlineToggle.setAttribute("aria-label", "Show outline glow options");
  const outlineToggleLabel = document.createElement("span");
  outlineToggleLabel.className = "skin-outline-toggle-label";
  outlineToggleLabel.textContent = "Outline glow";
  const outlineToggleSwatch = document.createElement("span");
  outlineToggleSwatch.className = "skin-outline-toggle-swatch";
  outlineToggleSwatch.setAttribute("aria-hidden", "true");
  const outlineToggleChevron = document.createElement("span");
  outlineToggleChevron.className = "skin-outline-toggle-chevron";
  outlineToggleChevron.setAttribute("aria-hidden", "true");
  outlineToggle.appendChild(outlineToggleLabel);
  outlineToggle.appendChild(outlineToggleSwatch);
  outlineToggle.appendChild(outlineToggleChevron);
  const outlinePanel = document.createElement("div");
  outlinePanel.id = outlinePanelId;
  outlinePanel.className = "skin-outline-panel";
  outlinePanel.hidden = true;
  const outlineTitle = document.createElement("p");
  outlineTitle.className = "skin-outline-lede";
  outlineTitle.textContent = "Skin Outline:";
  const outlineSwatches = document.createElement("div");
  outlineSwatches.className = "skin-outline-swatches";
  outlinePanel.appendChild(outlineTitle);
  outlinePanel.appendChild(outlineSwatches);
  const outlineStack = document.createElement("div");
  outlineStack.className = "skin-outline-stack";
  outlineStack.appendChild(outlineToggle);
  outlineStack.appendChild(outlinePanel);
  const nameColorPanelId = `stratum-skin-namecolor-${crypto.randomUUID()}`;
  const nameColorToggle = document.createElement("button");
  nameColorToggle.type = "button";
  nameColorToggle.className = "mm-btn mm-btn-subtle skin-outline-toggle";
  nameColorToggle.setAttribute("aria-expanded", "false");
  nameColorToggle.setAttribute("aria-controls", nameColorPanelId);
  nameColorToggle.title = "Nametag text color";
  nameColorToggle.setAttribute("aria-label", "Show nametag color options");
  const nameColorToggleLabel = document.createElement("span");
  nameColorToggleLabel.className = "skin-outline-toggle-label";
  nameColorToggleLabel.textContent = "Nametag color";
  const nameColorToggleSwatch = document.createElement("span");
  nameColorToggleSwatch.className = "skin-outline-toggle-swatch";
  nameColorToggleSwatch.setAttribute("aria-hidden", "true");
  const nameColorToggleChevron = document.createElement("span");
  nameColorToggleChevron.className = "skin-outline-toggle-chevron";
  nameColorToggleChevron.setAttribute("aria-hidden", "true");
  nameColorToggle.appendChild(nameColorToggleLabel);
  nameColorToggle.appendChild(nameColorToggleSwatch);
  nameColorToggle.appendChild(nameColorToggleChevron);
  const nameColorPanel = document.createElement("div");
  nameColorPanel.id = nameColorPanelId;
  nameColorPanel.className = "skin-outline-panel";
  nameColorPanel.hidden = true;
  const nameColorTitle = document.createElement("p");
  nameColorTitle.className = "skin-outline-lede";
  nameColorTitle.textContent = "Nametag color:";
  const nameColorSwatches = document.createElement("div");
  nameColorSwatches.className = "skin-outline-swatches";
  nameColorPanel.appendChild(nameColorTitle);
  nameColorPanel.appendChild(nameColorSwatches);
  const nameColorStack = document.createElement("div");
  nameColorStack.className = "skin-outline-stack";
  nameColorStack.appendChild(nameColorToggle);
  nameColorStack.appendChild(nameColorPanel);
  const hint = document.createElement("p");
  hint.className = "skin-preview-hint";
  hint.textContent = allowCustom
    ? "Your choice is saved on this device. It applies the next time you open or join a world."
    : "Sign in to upload custom skins and sync them to multiplayer. Built-in skins work offline and while signed out.";
  previewCol.appendChild(previewEyebrow);
  previewCol.appendChild(canvasWrap);
  previewCol.appendChild(previewName);
  previewCol.appendChild(actionsWrap);
  previewCol.appendChild(outlineStack);
  previewCol.appendChild(nameColorStack);
  previewCol.appendChild(hint);

  const syncOutlineChrome = (): void => {
    outlineToggleSwatch.style.backgroundColor = outlineColorHex;
  };

  const syncNameColorChrome = (): void => {
    nameColorToggleSwatch.style.backgroundColor = nameColorHex;
  };

  nameColorToggle.addEventListener("click", () => {
    nameColorPanel.hidden = !nameColorPanel.hidden;
    const open = !nameColorPanel.hidden;
    nameColorToggle.setAttribute("aria-expanded", open ? "true" : "false");
    nameColorToggle.setAttribute(
      "aria-label",
      open ? "Hide nametag color options" : "Show nametag color options",
    );
    nameColorToggle.classList.toggle("skin-outline-toggle--open", open);
    nameColorToggleLabel.textContent = open ? "Hide" : "Nametag color";
    nameColorToggle.title = open ? "Hide nametag color options" : "Nametag text color (donor)";
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("resize"));
        });
      });
    }
  });

  outlineToggle.addEventListener("click", () => {
    outlinePanel.hidden = !outlinePanel.hidden;
    const open = !outlinePanel.hidden;
    outlineToggle.setAttribute("aria-expanded", open ? "true" : "false");
    outlineToggle.setAttribute(
      "aria-label",
      open ? "Hide outline glow options" : "Show outline glow options",
    );
    outlineToggle.classList.toggle("skin-outline-toggle--open", open);
    outlineToggleLabel.textContent = open ? "Hide" : "Outline glow";
    outlineToggle.title = open ? "Hide outline options" : "Show donor outline color options";
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("resize"));
        });
      });
    }
  });

  layout.appendChild(catCol);
  layout.appendChild(center);
  layout.appendChild(previewCol);

  const inner = document.createElement("div");
  inner.className = "stratum-skins-inner";
  inner.appendChild(layout);

  const title = document.createElement("p");
  title.className = "mm-panel-title";
  title.textContent = "Skins";

  root.appendChild(title);
  if (!allowCustom) {
    const guestNote = document.createElement("p");
    guestNote.className = "mm-note";
    guestNote.style.marginTop = "0";
    guestNote.textContent =
      "Sign in to upload custom skins and show them to other players. You can use built-in skins while signed out.";
    root.appendChild(guestNote);
  }
  root.appendChild(inner);
  root.appendChild(feedback);

  async function saveSkinSelection(skinId: string): Promise<void> {
    selectedSkinId = skinId;
    try {
      const prev = await store.loadPlayerSettings();
      await store.savePlayerSettings({ ...prev, selectedSkinId: skinId });
      setFeedback("Saved. Applies when you open or join a world.", "ok");
    } catch {
      setFeedback("Could not save skin. Try again.", "err");
    }
  }

  function renderOutlineSwatches(): void {
    ensureMenuColorPickerStyles();
    const allowed = allowedPresetColorsForTier(outlineDonatorTier);
    outlineSwatches.replaceChildren();
    const hexLower = outlineColorHex.toLowerCase();

    for (const color of allowed) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "stratum-cp-swatch stratum-cp-swatch--compact";
      sw.style.backgroundColor = color;
      sw.setAttribute("data-hex", color);
      sw.title = color;
      if (color.toLowerCase() === hexLower) {
        sw.classList.add("stratum-cp-swatch--active");
      }
      sw.addEventListener("click", () => {
        void (async () => {
          outlineColorHex = color;
          const cur = await store.loadPlayerSettings();
          await store.savePlayerSettings({ ...cur, outlineColorHex });
          renderOutlineSwatches();
          setFeedback("Outline color updated.", "ok");
        })();
      });
      outlineSwatches.appendChild(sw);
    }

    if (canUseCustomColor(outlineDonatorTier)) {
      const customBtn = document.createElement("button");
      customBtn.type = "button";
      customBtn.className = "skin-outline-custom-swatch stratum-cp-swatch--compact";
      customBtn.title = "Custom color…";
      customBtn.setAttribute("aria-label", "Pick custom outline color");
      const isCustomPick = !allowed.some((h) => h.toLowerCase() === hexLower);
      if (isCustomPick) {
        customBtn.classList.add("stratum-cp-swatch--active");
      }
      customBtn.innerHTML =
        '<svg class="skin-outline-custom-swatch-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
      customBtn.addEventListener("click", () => {
        openColorPickerDialog({
          title: "Donor outline color",
          presetHexes: allowed,
          customAllowed: true,
          initialHex: outlineColorHex,
          onPick: (hex) => {
            void (async () => {
              outlineColorHex = sanitizeColorForTier(
                hex,
                outlineDonatorTier,
                DEFAULT_PLAYER_OUTLINE_COLOR_HEX,
              );
              const cur = await store.loadPlayerSettings();
              await store.savePlayerSettings({ ...cur, outlineColorHex });
              renderOutlineSwatches();
              setFeedback("Outline color updated.", "ok");
            })();
          },
        });
      });
      outlineSwatches.appendChild(customBtn);
    }

    skinPreviewCtl?.updateOutlineColorHex(outlineColorHex);
    syncOutlineChrome();
  }

  function renderNameColorSwatches(): void {
    ensureMenuColorPickerStyles();
    const allowed = allowedPresetColorsForTier(outlineDonatorTier);
    nameColorSwatches.replaceChildren();
    const hexLower = nameColorHex.toLowerCase();

    for (const color of allowed) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "stratum-cp-swatch stratum-cp-swatch--compact";
      sw.style.backgroundColor = color;
      sw.setAttribute("data-hex", color);
      sw.title = color;
      if (color.toLowerCase() === hexLower) {
        sw.classList.add("stratum-cp-swatch--active");
      }
      sw.addEventListener("click", () => {
        void (async () => {
          nameColorHex = color;
          const cur = await store.loadPlayerSettings();
          await store.savePlayerSettings({ ...cur, nameColorHex });
          renderNameColorSwatches();
          setFeedback("Nametag color updated.", "ok");
        })();
      });
      nameColorSwatches.appendChild(sw);
    }

    if (canUseCustomColor(outlineDonatorTier)) {
      const customBtn = document.createElement("button");
      customBtn.type = "button";
      customBtn.className = "skin-outline-custom-swatch stratum-cp-swatch--compact";
      customBtn.title = "Custom nametag color…";
      customBtn.setAttribute("aria-label", "Pick custom nametag color");
      const isCustomPick = !allowed.some((h) => h.toLowerCase() === hexLower);
      if (isCustomPick) {
        customBtn.classList.add("stratum-cp-swatch--active");
      }
      customBtn.innerHTML =
        '<svg class="skin-outline-custom-swatch-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
      customBtn.addEventListener("click", () => {
        openColorPickerDialog({
          title: "Nametag color",
          emptyMessage:
            "Donor name colors unlock when Discord is linked and your account has the donor role.",
          presetHexes: allowed,
          customAllowed: true,
          initialHex: nameColorHex,
          onPick: (hex) => {
            void (async () => {
              nameColorHex = sanitizeColorForTier(
                hex,
                outlineDonatorTier,
                DEFAULT_PLAYER_NAME_COLOR_HEX,
              );
              const cur = await store.loadPlayerSettings();
              await store.savePlayerSettings({ ...cur, nameColorHex });
              renderNameColorSwatches();
              setFeedback("Nametag color updated.", "ok");
            })();
          },
        });
      });
      nameColorSwatches.appendChild(customBtn);
    }

    syncNameColorChrome();
    syncNametagChrome();
  }

  function setPreview(entry: SkinEntry): void {
    previewEntry = entry;
    previewName.textContent = entry.label;
    previewDispose?.();
    previewDispose = null;
    skinPreviewCtl?.destroy();
    skinPreviewCtl = null;
    if (entry.ref.kind === "custom") {
      deleteBtn.style.display = "block";
    } else {
      deleteBtn.style.display = "none";
    }
    const pvImg = new Image();
    pvImg.crossOrigin = "anonymous";
    pvImg.onload = (): void => {
      void (async () => {
        if (cleaned) {
          return;
        }
        previewDispose?.();
        previewDispose = null;
        skinPreviewCtl?.destroy();
        skinPreviewCtl = null;
        previewPixiHost.replaceChildren();
        const ctl = await mountSkinMenuPreviewWithOutline(previewPixiHost, pvImg, outlineColorHex);
        if (ctl !== null) {
          skinPreviewCtl = ctl;
          previewDispose = (): void => {
            skinPreviewCtl?.destroy();
            skinPreviewCtl = null;
          };
          return;
        }
        const fb = document.createElement("canvas");
        fb.className = "skin-preview-canvas";
        applySkinCanvasStyle(fb, 72, 144);
        previewPixiHost.appendChild(fb);
        previewDispose = animateWalkPreview(fb, pvImg);
      })();
    };
    pvImg.src = entry.previewUrl;
  }

  function highlightActiveCard(): void {
    for (const c of grid.querySelectorAll(".skin-card")) {
      c.classList.remove("skin-card--active");
    }
    for (const card of grid.querySelectorAll(".skin-card")) {
      const id = card.getAttribute("data-skin-id");
      if (id === selectedSkinId) {
        card.classList.add("skin-card--active");
      }
    }
  }

  function buildGrid(
    builtins: SkinEntry[],
    customs: SkinEntry[],
  ): void {
    grid.replaceChildren();
    const builtinsFiltered = builtins;
    const customsFiltered = customs;
    const cat: SkinCategory = allowCustom ? category : "default";

    if (cat === "default") {
      gridTitle.textContent = `Default skins (${builtinsFiltered.length})`;
      for (const entry of builtinsFiltered) {
        grid.appendChild(makeSkinCard(entry));
      }
    } else {
      gridTitle.textContent = `My skins (${customsFiltered.length})`;
      for (const entry of customsFiltered) {
        grid.appendChild(makeSkinCard(entry));
      }
      const uploadCard = document.createElement("div");
      uploadCard.className = "skin-card skin-card--upload";
      uploadCard.setAttribute("data-upload", "1");
      const plusIcon = document.createElement("span");
      plusIcon.className = "skin-upload-icon";
      plusIcon.textContent = "+";
      const uploadLbl = document.createElement("span");
      uploadLbl.className = "skin-upload-label";
      uploadLbl.textContent = "Upload PNG";
      uploadCard.appendChild(plusIcon);
      uploadCard.appendChild(uploadLbl);
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/png";
      fileInput.style.display = "none";
      uploadCard.appendChild(fileInput);
      uploadCard.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file === undefined) return;
        void (async () => {
          const result = await validateSkinBlob(file);
          if (!result.ok) {
            setFeedback(result.error ?? "Invalid skin file.", "err");
            return;
          }
          const id = crypto.randomUUID();
          const label = file.name.replace(/\.png$/i, "").slice(0, 24) || "Custom";
          await store.putCustomSkin(id, label, file);
          await saveSkinSelection(`custom:${id}`);
          void refresh();
        })();
      });
      grid.appendChild(uploadCard);
    }

    highlightActiveCard();

    const all = [...builtinsFiltered, ...customsFiltered];
    const active = all.find((e) => stringifySkinRef(e.ref) === selectedSkinId);
    if (active !== undefined) {
      setPreview(active);
    } else if (builtinsFiltered[0] !== undefined) {
      setPreview(builtinsFiltered[0]);
    } else if (customsFiltered[0] !== undefined) {
      setPreview(customsFiltered[0]);
    } else {
      previewEntry = null;
      previewName.textContent = "—";
      deleteBtn.style.display = "none";
      previewDispose?.();
      previewDispose = null;
      skinPreviewCtl?.destroy();
      skinPreviewCtl = null;
      previewPixiHost.replaceChildren();
    }
  }

  function makeSkinCard(entry: SkinEntry): HTMLDivElement {
    const card = document.createElement("div");
    card.className = "skin-card";
    const entryId = stringifySkinRef(entry.ref);
    card.setAttribute("data-skin-id", entryId);
    if (entryId === selectedSkinId) {
      card.classList.add("skin-card--active");
    }
    const canvas = document.createElement("canvas");
    applySkinCanvasStyle(canvas, 48, 96);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = (): void => {
      drawIdleFramePreview(canvas, img);
    };
    img.src = entry.previewUrl;
    card.appendChild(canvas);
    const lbl = document.createElement("span");
    lbl.className = "skin-card-label";
    lbl.textContent = entry.label;
    card.appendChild(lbl);
    card.addEventListener("click", () => {
      void (async () => {
        await saveSkinSelection(entryId);
        for (const c of grid.querySelectorAll(".skin-card--active")) {
          c.classList.remove("skin-card--active");
        }
        card.classList.add("skin-card--active");
        setPreview(entry);
      })();
    });
    return card;
  }

  function setCategory(next: SkinCategory): void {
    category = next;
    btnDefault.classList.toggle("stratum-skins-cat--active", next === "default");
    btnCustom.classList.toggle("stratum-skins-cat--active", next === "custom");
  }

  btnDefault.addEventListener("click", () => {
    setCategory("default");
    void refresh();
  });
  if (allowCustom) {
    btnCustom.addEventListener("click", () => {
      setCategory("custom");
      void refresh();
    });
  }

  selectBtn.addEventListener("click", () => {
    if (previewEntry === null) {
      return;
    }
    if (!allowCustom && previewEntry.ref.kind === "custom") {
      return;
    }
    void (async () => {
      await saveSkinSelection(stringifySkinRef(previewEntry!.ref));
      highlightActiveCard();
    })();
  });

  deleteBtn.addEventListener("click", () => {
    if (previewEntry === null || previewEntry.ref.kind !== "custom") {
      return;
    }
    void (async () => {
      await store.deleteCustomSkin(previewEntry.ref.skinId);
      await saveSkinSelection(DEFAULT_SKIN_ID);
      setFeedback("Custom skin removed.", "ok");
      void refresh();
    })();
  });

  async function refresh(): Promise<void> {
    if (cleaned) return;
    for (const u of blobUrls) {
      URL.revokeObjectURL(u);
    }
    blobUrls.length = 0;
    const customsRows = await store.listCustomSkins();
    const customs = customSkinEntries(customsRows);
    const builtins = builtinSkinEntries();
    for (const e of customs) {
      if (e.ref.kind === "custom") {
        blobUrls.push(e.previewUrl);
      }
    }
    buildGrid(builtins, customs);
  }

  void store.openDB().then(async () => {
    if (cleaned) return;
    const s = await store.loadPlayerSettings();
    if (s.selectedSkinId !== undefined && s.selectedSkinId.length > 0) {
      selectedSkinId = s.selectedSkinId;
    }
    if (!allowCustom && selectedSkinId.startsWith("custom:")) {
      await saveSkinSelection(DEFAULT_SKIN_ID);
    }
    if (allowCustom && selectedSkinId.startsWith("custom:")) {
      setCategory("custom");
    }
    const tier = (() => {
      const supabase = auth.getSupabaseClient();
      if (supabase === null) {
        return "none";
      }
      return "none";
    })();
    const supabase = auth.getSupabaseClient();
    let donatorTier = cosmeticTierFromRaw(tier);
    if (supabase !== null) {
      const entitlement = await getDiscordEntitlement(supabase, false);
      if (entitlement.ok) {
        donatorTier = cosmeticTierFromRaw(entitlement.status.tier);
      }
    }
    outlineDonatorTier = donatorTier;
    outlineColorHex = sanitizeColorForTier(
      s.outlineColorHex ?? DEFAULT_PLAYER_OUTLINE_COLOR_HEX,
      donatorTier,
      DEFAULT_PLAYER_OUTLINE_COLOR_HEX,
    );
    nameColorHex = sanitizeColorForTier(
      s.nameColorHex ?? DEFAULT_PLAYER_NAME_COLOR_HEX,
      donatorTier,
      DEFAULT_PLAYER_NAME_COLOR_HEX,
    );
    renderOutlineSwatches();
    renderNameColorSwatches();
    setFeedback("", "clear");
    await refresh();
  });

  const unsubAuth = auth.onAuthStateChange(() => {
    void refreshDisplayName();
  });
  void auth.ensureAuthHydrated().then(() => {
    void refreshDisplayName();
  });
  syncNametagChrome();

  const showSkinSkeleton = (): void => {
    gridTitle.textContent = "Loading…";
    grid.replaceChildren();
    for (let i = 0; i < 14; i++) {
      const card = document.createElement("div");
      card.className = "skin-card skin-card--skel";
      card.setAttribute("aria-hidden", "true");
      const canv = document.createElement("div");
      canv.className = "skin-skel-thumb mm-skel";
      const lbl = document.createElement("div");
      lbl.className = "mm-skel mm-skel-inline";
      lbl.style.marginTop = "8px";
      lbl.style.display = "block";
      lbl.style.height = "16px";
      lbl.style.width = i % 3 === 0 ? "74%" : "58%";
      card.append(canv, lbl);
      grid.appendChild(card);
    }
    previewPixiHost.replaceChildren();
    const wrapPv = document.createElement("div");
    wrapPv.className = "skin-preview-skel-wrap";
    wrapPv.setAttribute("aria-hidden", "true");
    const fig = document.createElement("div");
    fig.className = "skin-preview-skel-figure mm-skel";
    wrapPv.appendChild(fig);
    previewPixiHost.appendChild(wrapPv);
    previewName.textContent = "…";
  };

  showSkinSkeleton();
  container.appendChild(root);

  return () => {
    cleaned = true;
    unsubAuth();
    previewDispose?.();
    previewDispose = null;
    skinPreviewCtl?.destroy();
    skinPreviewCtl = null;
    for (const u of blobUrls) {
      URL.revokeObjectURL(u);
    }
    blobUrls.length = 0;
    root.remove();
  };
}
