import type { AudioEngine } from "../../audio/AudioEngine";
import { readVolumeStored, VOL_KEYS } from "../../audio/volumeSettings";
import type { EventBus } from "../../core/EventBus";
import type { GameEvent } from "../../core/types";
import {
  DEFAULT_KEY_BINDINGS,
  formatKeyCode,
  KEYBINDABLE_ACTION_ORDER,
  KEYBINDABLE_LABELS,
  type KeybindableAction,
} from "../../input/bindings";
import {
  cloneDefaultKeyBindings,
  dedupeKeyFromOtherActions,
  mergeStoredKeyBindings,
  snapshotKeyBindings,
} from "../../input/keyBindingMerge";
import type { CachedMod } from "../../mods/workshopTypes";
import type { IndexedDBStore } from "../../persistence/IndexedDBStore";
import { openGlobalTexturePacksModal } from "../globalTexturePacksUi";
import { injectSettingsSharedStyles } from "./settingsSharedStyles";
import { getSkipIntro, setSkipIntro } from "./uiPrefs";
import { getVideoPrefs, setVideoPrefs, type Tonemapper } from "./videoPrefs";

function applyStoredVolumesToEngine(audio: AudioEngine): void {
  audio.setMasterVolume(readVolumeStored(VOL_KEYS.master, 80) / 100);
  audio.setMusicVolume(readVolumeStored(VOL_KEYS.music, 60) / 100);
  audio.setSfxVolume(readVolumeStored(VOL_KEYS.sfx, 100) / 100);
}

export type MountSettingsPanelOptions = {
  store: IndexedDBStore;
  getInstalled: () => readonly CachedMod[];
  /** When set (e.g. main menu), sliders update this engine immediately while dragging. */
  audio?: AudioEngine;
  /** When set, volume sliders emit live {@link GameEvent} `settings:volume`. */
  bus?: EventBus;
  /** When true and `bus` is set, key changes apply to the running game immediately. */
  applyKeyBindingsLive?: boolean;
  /** Abort to remove global key listeners (tab change / overlay destroy). */
  signal?: AbortSignal;
};

type SettingsSubTab = "audio" | "controls" | "packs" | "video";

function makeBtn(text: string, ...classes: string[]): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = classes.join(" ");
  b.textContent = text;
  return b;
}

export async function mountSettingsPanel(
  host: HTMLElement,
  opts: MountSettingsPanelOptions,
): Promise<void> {
  const base = import.meta.env.BASE_URL;
  injectSettingsSharedStyles(base);

  await opts.store.openDB();
  if (opts.signal?.aborted) {
    return;
  }
  const playerSettings = await opts.store.loadPlayerSettings();
  if (opts.signal?.aborted) {
    return;
  }
  let bindingsState = mergeStoredKeyBindings(playerSettings.keyBindings);

  const root = document.createElement("div");
  root.className = "st-settings-root";

  const title = document.createElement("p");
  title.className = "mm-panel-title";
  title.style.marginTop = "0";
  title.textContent = "Settings";

  const tabbar = document.createElement("div");
  tabbar.className = "st-settings-subtabbar";
  tabbar.setAttribute("role", "tablist");

  const panelsWrap = document.createElement("div");
  panelsWrap.className = "st-settings-tab-panels";

  const panelAudio = document.createElement("div");
  panelAudio.className = "st-settings-tab-panel";
  panelAudio.setAttribute("role", "tabpanel");

  const panelControls = document.createElement("div");
  panelControls.className = "st-settings-tab-panel";
  panelControls.setAttribute("role", "tabpanel");

  const panelPacks = document.createElement("div");
  panelPacks.className = "st-settings-tab-panel";
  panelPacks.setAttribute("role", "tabpanel");

  const panelVideo = document.createElement("div");
  panelVideo.className = "st-settings-tab-panel";
  panelVideo.setAttribute("role", "tabpanel");

  let activeTab: SettingsSubTab = "audio";

  const tabBtn: Record<SettingsSubTab, HTMLButtonElement> = {
    audio: makeBtn("Audio", "st-settings-subtab"),
    controls: makeBtn("Controls", "st-settings-subtab"),
    packs: makeBtn("Texture packs", "st-settings-subtab"),
    video: makeBtn("Video", "st-settings-subtab"),
  };

  function setTab(tab: SettingsSubTab): void {
    activeTab = tab;
    for (const [id, btn] of Object.entries(tabBtn) as [SettingsSubTab, HTMLButtonElement][]) {
      const on = id === tab;
      btn.classList.toggle("st-settings-subtab--active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    panelAudio.classList.toggle("st-settings-tab-panel--active", tab === "audio");
    panelControls.classList.toggle("st-settings-tab-panel--active", tab === "controls");
    panelPacks.classList.toggle("st-settings-tab-panel--active", tab === "packs");
    panelVideo.classList.toggle("st-settings-tab-panel--active", tab === "video");
  }

  for (const id of ["audio", "controls", "packs", "video"] as SettingsSubTab[]) {
    const b = tabBtn[id];
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => setTab(id));
    tabbar.appendChild(b);
  }

  // --- Audio ---
  const volTitle = document.createElement("div");
  volTitle.className = "st-settings-section";
  volTitle.textContent = "Volume";
  panelAudio.appendChild(volTitle);

  const emitVolume = (): void => {
    if (opts.bus === undefined) {
      return;
    }
    opts.bus.emit({
      type: "settings:volume",
      master: readVolumeStored(VOL_KEYS.master, 80),
      music: readVolumeStored(VOL_KEYS.music, 60),
      sfx: readVolumeStored(VOL_KEYS.sfx, 80),
    } satisfies GameEvent);
  };

  const volumeSliders: Array<{ label: string; key: string; def: number }> = [
    { label: "Master", key: VOL_KEYS.master, def: 80 },
    { label: "Music", key: VOL_KEYS.music, def: 60 },
    { label: "SFX", key: VOL_KEYS.sfx, def: 80 },
  ];
  for (const { label, key, def } of volumeSliders) {
    const row = document.createElement("div");
    row.className = "st-settings-row";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(readVolumeStored(key, def));
    const val = document.createElement("span");
    val.className = "st-settings-val";
    val.textContent = slider.value;
    slider.addEventListener("input", () => {
      val.textContent = slider.value;
      localStorage.setItem(key, slider.value);
      emitVolume();
      if (opts.audio !== undefined) {
        applyStoredVolumesToEngine(opts.audio);
      }
    });
    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(val);
    panelAudio.appendChild(row);
  }

  // --- General toggles (inside Audio tab) ---
  const generalTitle = document.createElement("div");
  generalTitle.className = "st-settings-section";
  generalTitle.textContent = "General";
  panelAudio.appendChild(generalTitle);

  {
    const row = document.createElement("div");
    row.className = "st-settings-toggle-row";

    const lbl = document.createElement("label");
    lbl.textContent = "Show game intro";
    const toggleId = "st-toggle-intro";
    lbl.htmlFor = toggleId;

    const toggle = document.createElement("span");
    toggle.className = "st-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = toggleId;
    input.checked = !getSkipIntro();
    const track = document.createElement("span");
    track.className = "st-toggle-track";
    input.addEventListener("change", () => {
      setSkipIntro(!input.checked);
    });
    toggle.appendChild(input);
    toggle.appendChild(track);

    row.appendChild(lbl);
    row.appendChild(toggle);
    panelAudio.appendChild(row);
  }

  // --- Controls ---
  const ctrlHint = document.createElement("p");
  ctrlHint.className = "st-settings-hint";
  ctrlHint.textContent =
    "Left click breaks blocks and right click places them (mouse). Add keys per action; the same key cannot be bound twice.";
  panelControls.appendChild(ctrlHint);

  const bindTable = document.createElement("div");
  bindTable.className = "st-bind-table";
  panelControls.appendChild(bindTable);

  let capturing: KeybindableAction | null = null;
  const captureMsg = document.createElement("div");
  captureMsg.className = "st-bind-capture-msg";
  captureMsg.style.display = "none";
  panelControls.appendChild(captureMsg);

  async function persistBindings(): Promise<void> {
    const cur = await opts.store.loadPlayerSettings();
    const storable = snapshotKeyBindings(bindingsState);
    await opts.store.savePlayerSettings({
      key: "v1",
      globalResourcePackRefs: [...cur.globalResourcePackRefs],
      keyBindings: storable,
    });
    if (opts.bus !== undefined && opts.applyKeyBindingsLive === true) {
      opts.bus.emit({
        type: "settings:apply-key-bindings",
        bindings: storable,
      } satisfies GameEvent);
    }
  }

  const rowEls = new Map<KeybindableAction, HTMLDivElement>();

  function setCaptureVisual(): void {
    for (const [action, el] of rowEls) {
      el.classList.toggle("st-bind-row--capture", capturing === action);
    }
    if (capturing !== null) {
      captureMsg.style.display = "block";
      captureMsg.textContent = `Press a key for “${KEYBINDABLE_LABELS[capturing]}”. Escape cancels.`;
    } else {
      captureMsg.style.display = "none";
    }
  }

  function renderBindRows(): void {
    bindTable.replaceChildren();
    rowEls.clear();
    for (const action of KEYBINDABLE_ACTION_ORDER) {
      const row = document.createElement("div");
      row.className = "st-bind-row";
      const lab = document.createElement("div");
      lab.className = "st-bind-label";
      lab.textContent = KEYBINDABLE_LABELS[action];

      const chips = document.createElement("div");
      chips.className = "st-bind-chips";

      const syncChips = (): void => {
        chips.replaceChildren();
        for (const code of bindingsState[action]) {
          const chip = document.createElement("span");
          chip.className = "st-bind-chip";
          chip.appendChild(document.createTextNode(formatKeyCode(code)));
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "st-bind-chip-remove";
          rm.setAttribute("aria-label", `Remove ${formatKeyCode(code)}`);
          rm.textContent = "×";
          rm.addEventListener("click", () => {
            bindingsState[action] = bindingsState[action].filter((c) => c !== code);
            void persistBindings();
            syncChips();
          });
          chip.appendChild(rm);
          chips.appendChild(chip);
        }
      };
      syncChips();

      const actions = document.createElement("div");
      actions.className = "st-bind-actions";
      const addBtn = makeBtn("Add key", "mm-btn", "mm-btn-secondary");
      addBtn.addEventListener("click", () => {
        capturing = action;
        setCaptureVisual();
      });
      const resetBtn = makeBtn("Reset", "mm-btn", "mm-btn-secondary");
      resetBtn.addEventListener("click", () => {
        bindingsState[action] = [...DEFAULT_KEY_BINDINGS[action]];
        void persistBindings();
        syncChips();
      });
      actions.appendChild(addBtn);
      actions.appendChild(resetBtn);

      row.appendChild(lab);
      row.appendChild(chips);
      row.appendChild(actions);
      bindTable.appendChild(row);
      rowEls.set(action, row);
    }
    setCaptureVisual();
  }

  renderBindRows();

  const ctrlFooter = document.createElement("div");
  ctrlFooter.className = "st-settings-controls-footer";
  const resetAll = makeBtn("Reset all keys to defaults", "mm-btn", "mm-btn-secondary");
  resetAll.addEventListener("click", () => {
    bindingsState = cloneDefaultKeyBindings();
    void persistBindings();
    renderBindRows();
  });
  ctrlFooter.appendChild(resetAll);
  panelControls.appendChild(ctrlFooter);

  const onKeyCapture = (e: KeyboardEvent): void => {
    if (capturing === null) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) {
      return;
    }
    if (e.code === "Escape") {
      capturing = null;
      setCaptureVisual();
      return;
    }
    const code = e.code;
    if (code === "Unidentified" || code.length === 0) {
      return;
    }
    const act = capturing;
    dedupeKeyFromOtherActions(bindingsState, act, code);
    if (!bindingsState[act].includes(code)) {
      bindingsState[act].push(code);
    }
    capturing = null;
    setCaptureVisual();
    void persistBindings();
    renderBindRows();
  };

  window.addEventListener("keydown", onKeyCapture, true);
  const onAbort = (): void => {
    window.removeEventListener("keydown", onKeyCapture, true);
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // --- Texture packs ---
  const packsHint = document.createElement("p");
  packsHint.className = "st-settings-hint";
  packsHint.textContent =
    "Global resource packs load after each world’s resource packs. Changes apply the next time you start or load a world.";
  panelPacks.appendChild(packsHint);
  const texBtn = makeBtn(
    "Manage global texture packs…",
    "mm-btn",
    "mm-btn-secondary",
  );
  texBtn.addEventListener("click", () => {
    void openGlobalTexturePacksModal({
      store: opts.store,
      getInstalled: opts.getInstalled,
    });
  });
  panelPacks.appendChild(texBtn);

  // --- Video (minimal: normal maps, tonemapper, bloom) ---
  const videoTitle = document.createElement("div");
  videoTitle.className = "st-settings-section";
  videoTitle.style.marginTop = "0";
  videoTitle.textContent = "Video";
  panelVideo.appendChild(videoTitle);

  const vpVideo = getVideoPrefs();

  // Normal maps
  {
    const row = document.createElement("div");
    row.className = "st-settings-toggle-row";
    const lbl = document.createElement("label");
    lbl.textContent = "Normal maps";
    const toggleId = "st-toggle-ssn";
    lbl.htmlFor = toggleId;
    const toggle = document.createElement("span");
    toggle.className = "st-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = toggleId;
    input.checked = vpVideo.screenSpaceNormals;
    input.addEventListener("change", () => {
      setVideoPrefs({ screenSpaceNormals: input.checked });
    });
    const track = document.createElement("span");
    track.className = "st-toggle-track";
    toggle.appendChild(input);
    toggle.appendChild(track);
    row.appendChild(lbl);
    row.appendChild(toggle);
    panelVideo.appendChild(row);
  }

  // Tonemapper: none | reinhard only
  {
    const row = document.createElement("div");
    row.className = "st-settings-toggle-row";
    const lbl = document.createElement("label");
    lbl.textContent = "Tonemapper";
    const options: { id: Tonemapper; label: string }[] = [
      { id: "none", label: "None" },
      { id: "reinhard", label: "Reinhard" },
    ];
    const segmented = document.createElement("div");
    segmented.className = "st-segmented";

    function syncSegmented(active: Tonemapper): void {
      const key = active === "none" ? "none" : "reinhard";
      for (const btn of segmented.querySelectorAll<HTMLButtonElement>(".st-seg-btn")) {
        btn.classList.toggle("st-seg-btn--active", btn.dataset["value"] === key);
      }
    }

    for (const opt of options) {
      const btn = makeBtn(opt.label, "st-seg-btn");
      btn.dataset["value"] = opt.id;
      btn.addEventListener("click", () => {
        setVideoPrefs({ tonemapper: opt.id });
        syncSegmented(opt.id);
      });
      segmented.appendChild(btn);
    }
    syncSegmented(vpVideo.tonemapper);

    row.appendChild(lbl);
    row.appendChild(segmented);
    panelVideo.appendChild(row);
  }

  // Bloom
  {
    const row = document.createElement("div");
    row.className = "st-settings-toggle-row";
    const lbl = document.createElement("label");
    lbl.textContent = "Bloom";
    const toggleId = "st-toggle-bloom";
    lbl.htmlFor = toggleId;
    const toggle = document.createElement("span");
    toggle.className = "st-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = toggleId;
    input.checked = vpVideo.bloom;
    input.addEventListener("change", () => {
      setVideoPrefs({ bloom: input.checked });
    });
    const track = document.createElement("span");
    track.className = "st-toggle-track";
    toggle.appendChild(input);
    toggle.appendChild(track);
    row.appendChild(lbl);
    row.appendChild(toggle);
    panelVideo.appendChild(row);
  }

  panelsWrap.append(panelAudio, panelControls, panelPacks, panelVideo);
  root.append(title, tabbar, panelsWrap);
  if (opts.signal?.aborted) {
    return;
  }
  host.replaceChildren(root);
  setTab(activeTab);
}
