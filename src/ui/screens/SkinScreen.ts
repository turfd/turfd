/** Main-menu Skins tab: Bedrock-style categories + grid + preview (DOM). */

import type { IAuthProvider } from "../../auth/IAuthProvider";
import { DEFAULT_SKIN_ID, PLAYER_BODY_REQUIRED_FRAME_COUNT } from "../../core/constants";
import { IndexedDBStore } from "../../persistence/IndexedDBStore";
import {
  builtinSkinEntries,
  customSkinEntries,
  stringifySkinRef,
  validateSkinBlob,
} from "../../skins/SkinRegistry";
import type { SkinEntry } from "../../skins/skinTypes";

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
      font-size: 14px;
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
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 10px 12px;
      background: rgba(0,0,0,0.15);
    }
    .stratum-skins-grid-title {
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
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
      font-size: calc(16px + var(--mm-m5-nudge, 4px));
      color: var(--mm-ink-mid, #aeaeb2);
      text-align: center;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.1;
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
      font-size: calc(13px + var(--mm-m5-nudge, 4px));
      color: var(--mm-ink-mid, #aeaeb2);
    }
    .stratum-skins-preview {
      display: flex;
      flex-direction: column;
      gap: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 12px;
      background: rgba(0,0,0,0.2);
      min-height: 0;
    }
    .stratum-skins-preview h3 {
      font-family: 'BoldPixels', monospace;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0;
      color: var(--mm-ink, #f2f2f7);
    }
    .stratum-skins-preview-canvas-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 160px;
      background: rgba(0,0,0,0.25);
      border-radius: 4px;
      padding: 8px;
    }
    .skin-preview-canvas {
      border-radius: 3px;
    }
    .skin-preview-name {
      font-family: 'BoldPixels', monospace;
      font-size: 14px;
      color: var(--mm-ink, #f2f2f7);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      text-align: center;
    }
    .skin-preview-hint {
      font-family: 'M5x7', monospace;
      font-size: calc(15px + var(--mm-m5-nudge, 4px));
      color: var(--mm-ink-mid, #8e8e93);
      line-height: 1.35;
      margin: 0;
    }
    .skin-delete-btn {
      background: none;
      border: 1px solid rgba(255,80,80,0.35);
      border-radius: 4px;
      color: #ff6b6b;
      font-family: 'M5x7', monospace;
      font-size: calc(14px + var(--mm-m5-nudge, 4px));
      cursor: pointer;
      padding: 6px 10px;
    }
    .skin-delete-btn:hover { background: rgba(255,80,80,0.1); }
    .mm-skins-feedback--ok {
      font-family: 'M5x7', monospace;
      font-size: calc(19px + var(--mm-m5-nudge, 4px));
      color: #5daf8c;
      min-height: 1.25em;
      margin-top: 10px;
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
 * Mount the Skins tab into `container`. `auth` is unused today but kept for parity / future cloud sync.
 */
export function mountSkinScreen(
  container: HTMLElement,
  _auth: IAuthProvider,
): () => void {
  void _auth;
  injectStyles();

  const root = document.createElement("div");
  root.className = "mm-panel mm-skins-panel";

  let cleaned = false;
  let selectedSkinId = DEFAULT_SKIN_ID;
  let category: SkinCategory = "default";
  let previewEntry: SkinEntry | null = null;
  let previewCleanup: (() => void) | null = null;
  const blobUrls: string[] = [];

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
  catCol.appendChild(btnCustom);

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
  const previewHeading = document.createElement("h3");
  previewHeading.textContent = "Preview";
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "stratum-skins-preview-canvas-wrap";
  const previewCanvas = document.createElement("canvas");
  previewCanvas.className = "skin-preview-canvas";
  applySkinCanvasStyle(previewCanvas, 72, 144);
  canvasWrap.appendChild(previewCanvas);
  const previewName = document.createElement("div");
  previewName.className = "skin-preview-name";
  const selectBtn = document.createElement("button");
  selectBtn.type = "button";
  selectBtn.className = "mm-btn";
  selectBtn.textContent = "Select skin";
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "skin-delete-btn";
  deleteBtn.textContent = "Delete skin";
  deleteBtn.style.display = "none";
  const hint = document.createElement("p");
  hint.className = "skin-preview-hint";
  hint.textContent =
    "Your choice is saved on this device. It applies the next time you open or join a world.";
  previewCol.appendChild(previewHeading);
  previewCol.appendChild(canvasWrap);
  previewCol.appendChild(previewName);
  previewCol.appendChild(selectBtn);
  previewCol.appendChild(deleteBtn);
  previewCol.appendChild(hint);

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

  function setPreview(entry: SkinEntry): void {
    previewEntry = entry;
    previewName.textContent = entry.label;
    previewCleanup?.();
    previewCleanup = null;
    if (entry.ref.kind === "custom") {
      deleteBtn.style.display = "block";
    } else {
      deleteBtn.style.display = "none";
    }
    const pvImg = new Image();
    pvImg.crossOrigin = "anonymous";
    pvImg.onload = (): void => {
      previewCleanup = animateWalkPreview(previewCanvas, pvImg);
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

    if (category === "default") {
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
      previewCleanup?.();
      previewCleanup = null;
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
  btnCustom.addEventListener("click", () => {
    setCategory("custom");
    void refresh();
  });

  selectBtn.addEventListener("click", () => {
    if (previewEntry === null) {
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
    if (selectedSkinId.startsWith("custom:")) {
      setCategory("custom");
    }
    setFeedback("", "clear");
    await refresh();
  });

  container.appendChild(root);

  return () => {
    cleaned = true;
    previewCleanup?.();
    previewCleanup = null;
    for (const u of blobUrls) {
      URL.revokeObjectURL(u);
    }
    blobUrls.length = 0;
    root.remove();
  };
}
