/**
 * Edit-world pack panels: behavior and resource stacks (Bedrock-style Active / Available).
 * Pack join options for multiplayer live on the General tab.
 */
import type { IModRepository } from "../mods/IModRepository";
import type { CachedMod } from "../mods/workshopTypes";
import {
  workshopPackLoadsBlocks,
  workshopPackLoadsTextures,
} from "../mods/workshopTypes";
import type {
  WorldMetadata,
  WorkshopModRef,
} from "../persistence/IndexedDBStore";
import { resolveWorldWorkshopStacks } from "../persistence/worldWorkshopStacks";

export type WorldPackPatch = {
  workshopBehaviorMods: WorkshopModRef[];
  workshopResourceMods: WorkshopModRef[];
  requirePacksBeforeJoin: boolean;
};

function refKey(r: WorkshopModRef): string {
  return `${r.recordId}:${r.modId}:${r.version}`;
}

function cachedToRef(c: CachedMod): WorkshopModRef {
  return {
    recordId: c.recordId,
    modId: c.modId,
    version: c.version,
  };
}

function createPackSourcePill(c: CachedMod): HTMLSpanElement {
  const pill = document.createElement("span");
  const isDev = String(c.recordId).startsWith("dev:");
  pill.textContent = isDev ? "dev" : "workshop";
  pill.style.display = "inline-flex";
  pill.style.alignItems = "center";
  pill.style.justifyContent = "center";
  pill.style.padding = "2px 7px";
  pill.style.borderRadius = "999px";
  pill.style.fontSize = "12px";
  pill.style.lineHeight = "1";
  pill.style.letterSpacing = "0.04em";
  pill.style.textTransform = "uppercase";
  pill.style.marginLeft = "8px";
  if (isDev) {
    pill.style.background = "rgba(83, 183, 106, 0.2)";
    pill.style.border = "1px solid rgba(83, 183, 106, 0.45)";
    pill.style.color = "#b7f0c5";
  } else {
    pill.style.background = "rgba(95, 159, 255, 0.2)";
    pill.style.border = "1px solid rgba(95, 159, 255, 0.45)";
    pill.style.color = "#bfd7ff";
  }
  return pill;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className !== undefined) {
    n.className = className;
  }
  return n;
}

function appendDragHandle(li: HTMLElement): void {
  const handle = el("span", "mm-pack-drag-handle");
  handle.setAttribute("aria-hidden", "true");
  handle.title = "Drag to reorder";
  const dots = el("span", "mm-pack-drag-handle-dots");
  for (let i = 0; i < 6; i++) {
    dots.appendChild(el("span"));
  }
  handle.appendChild(dots);
  li.insertBefore(handle, li.firstChild);
}

export type WorldPackEditorController = {
  getPatch: () => WorldPackPatch;
  behaviorPanel: HTMLElement;
  resourcePanel: HTMLElement;
  /** Pack-related options shown on the General tab (join / download rules). */
  generalPackOptions: HTMLElement;
};

/**
 * Creates behavior + resource panels (Bedrock-style Active | Available) and general options.
 */
export function createWorldPackEditorController(opts: {
  worldMeta: WorldMetadata;
  repo: IModRepository | null;
  getInstalled: (() => readonly CachedMod[]) | null;
  /**
   * Called after any change to active stacks or pack options.
   * Persists to storage so closing the editor without pressing Save still keeps pack lists.
   */
  persistPackMetadata?: (patch: WorldPackPatch) => void | Promise<void>;
}): WorldPackEditorController {
  const resolved = resolveWorldWorkshopStacks(opts.worldMeta, opts.repo);
  const behaviorRefs: WorkshopModRef[] = resolved.behaviorRefs.map((r) => ({
    recordId: r.recordId,
    modId: r.modId,
    version: r.version,
  }));
  const resourceRefs: WorkshopModRef[] = resolved.resourceRefs.map((r) => ({
    recordId: r.recordId,
    modId: r.modId,
    version: r.version,
  }));
  let requirePacks = opts.worldMeta.requirePacksBeforeJoin === true;

  let dragFrom: { list: "b" | "r"; index: number } | null = null;

  const currentPatch = (): WorldPackPatch => ({
    workshopBehaviorMods: behaviorRefs.map((r) => ({ ...r })),
    workshopResourceMods: resourceRefs.map((r) => ({ ...r })),
    requirePacksBeforeJoin: requirePacks,
  });

  const flushPackMetadata = (): void => {
    const persist = opts.persistPackMetadata;
    if (persist === undefined) {
      return;
    }
    void Promise.resolve(persist(currentPatch())).catch((err: unknown) => {
      console.error("persistPackMetadata failed:", err);
    });
  };

  const ulBeh = el("ul") as HTMLUListElement;
  const ulRes = el("ul") as HTMLUListElement;
  const installedBehMount = el("div", "mm-pack-available-mount");
  const installedResMount = el("div", "mm-pack-available-mount");

  const renderBoth = (): void => {
    renderActiveList(behaviorRefs, "b", ulBeh);
    renderActiveList(resourceRefs, "r", ulRes);
    renderInstalledSection("b", installedBehMount, behaviorRefs);
    renderInstalledSection("r", installedResMount, resourceRefs);
  };

  function renderActiveList(
    list: WorkshopModRef[],
    kind: "b" | "r",
    ul: HTMLUListElement,
  ): void {
    ul.replaceChildren();
    ul.className = "mm-pack-drag-list mm-bedrock-pack-list";
    ul.style.listStyle = "none";
    ul.style.padding = "0";
    ul.style.margin = "0";
    if (list.length === 0) {
      const empty = el("li", "mm-pack-active-empty mm-note");
      empty.textContent =
        "No add-on packs. Open Available to add packs from your library.";
      ul.appendChild(empty);
      return;
    }
    list.forEach((ref, index) => {
      const li = el("li", "mm-pack-drag-row mm-bedrock-pack-row");
      li.draggable = true;
      li.dataset.index = String(index);

      appendDragHandle(li);

      const rowMain = el("div", "mm-pack-drag-row-main");
      const idx = el("span", "mm-pack-drag-row-index");
      idx.textContent = `#${index + 1}`;
      const lab = el("span", "mm-bedrock-pack-row-label");
      lab.textContent = `${ref.modId} · v${ref.version}`;
      rowMain.appendChild(idx);
      rowMain.appendChild(lab);

      const rm = el(
        "button",
        "mm-btn mm-btn-subtle mm-bedrock-pack-remove",
      ) as HTMLButtonElement;
      rm.type = "button";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        if (kind === "b") {
          behaviorRefs.splice(index, 1);
        } else {
          resourceRefs.splice(index, 1);
        }
        renderBoth();
        flushPackMetadata();
      });
      li.appendChild(rowMain);
      li.appendChild(rm);
      li.addEventListener("dragstart", () => {
        dragFrom = { list: kind, index };
      });
      li.addEventListener("dragover", (ev) => {
        ev.preventDefault();
      });
      li.addEventListener("drop", (ev) => {
        ev.preventDefault();
        if (dragFrom === null) {
          return;
        }
        const fromList = dragFrom.list;
        const fromI = dragFrom.index;
        const targetIdx = parseInt(li.dataset.index ?? "0", 10);
        const fromArr = fromList === "b" ? behaviorRefs : resourceRefs;
        const toArr = kind === "b" ? behaviorRefs : resourceRefs;
        const [moved] = fromArr.splice(fromI, 1);
        dragFrom = null;
        if (moved === undefined) {
          renderBoth();
          return;
        }
        let insertAt = targetIdx;
        if (fromList === kind && fromI < targetIdx) {
          insertAt -= 1;
        }
        toArr.splice(insertAt, 0, moved);
        renderBoth();
        flushPackMetadata();
      });
      ul.appendChild(li);
    });
  }

  function renderInstalledSection(
    kind: "b" | "r",
    mount: HTMLElement,
    activeRefs: WorkshopModRef[],
  ): void {
    mount.replaceChildren();
    if (opts.getInstalled === null) {
      const p = el("p", "mm-note");
      p.textContent =
        "Workshop unavailable — sign in and use the Workshop tab to install packs.";
      mount.appendChild(p);
      return;
    }
    const activeKeys = new Set(activeRefs.map(refKey));
    const matchesKind = (c: CachedMod): boolean =>
      kind === "b"
        ? workshopPackLoadsBlocks(c.manifest.mod_type)
        : workshopPackLoadsTextures(c.manifest.mod_type);
    const installedRaw = opts.getInstalled();
    const all = installedRaw.filter(matchesKind);
    const idle = all.filter((c) => !activeKeys.has(refKey(cachedToRef(c))));
    if (idle.length === 0) {
      const p = el("p", "mm-note");
      p.textContent =
        all.length === 0
          ? "No packs of this type installed. Get them from the Workshop."
          : "Every installed pack is already active for this world.";
      mount.appendChild(p);
      return;
    }
    const ul = el("ul", "mm-pack-installed-list") as HTMLUListElement;
    ul.style.listStyle = "none";
    ul.style.padding = "0";
    ul.style.margin = "0";
    for (const c of idle) {
      const li = el("li", "mm-bedrock-pack-row mm-pack-installed-row");
      const titleRow = el("div");
      titleRow.style.display = "flex";
      titleRow.style.alignItems = "center";
      const lab = el("span", "mm-bedrock-pack-row-label");
      const title = c.manifest.name?.trim() || c.modId;
      lab.textContent = `${title} · ${c.modId} v${c.version}`;
      titleRow.appendChild(lab);
      titleRow.appendChild(createPackSourcePill(c));
      const addBtn = el(
        "button",
        "mm-btn mm-btn-subtle mm-bedrock-pack-add",
      ) as HTMLButtonElement;
      addBtn.type = "button";
      addBtn.textContent = "Add";
      addBtn.addEventListener("click", () => {
        const ref = cachedToRef(c);
        const arr = kind === "b" ? behaviorRefs : resourceRefs;
        if (!arr.some((x) => refKey(x) === refKey(ref))) {
          arr.push(ref);
        }
        renderBoth();
        flushPackMetadata();
      });
      li.appendChild(titleRow);
      li.appendChild(addBtn);
      ul.appendChild(li);
    }
    mount.appendChild(ul);
  }

  function appendBuiltInStratumRow(mount: HTMLElement, subtitle: string): void {
    const wrap = el("div", "mm-pack-built-in-block");
    wrap.style.marginBottom = "10px";
    wrap.style.padding = "8px 10px";
    wrap.style.borderRadius = "8px";
    wrap.style.background = "rgba(255,255,255,0.04)";
    wrap.style.border = "1px solid rgba(255,255,255,0.08)";
    const title = el("div", "mm-bedrock-pack-row-label");
    title.textContent = "Stratum Core (built-in)";
    const sub = el("p", "mm-note mm-pack-built-in-sub");
    sub.style.margin = "6px 0 0";
    sub.textContent = subtitle;
    wrap.appendChild(title);
    wrap.appendChild(sub);
    mount.appendChild(wrap);
  }

  function createBedrockPackPanel(
    introText: string,
    activeUl: HTMLUListElement,
    installedMount: HTMLElement,
    builtInSubtitle: string,
    footnote: string,
  ): HTMLElement {
    let sub: "active" | "available" = "active";
    const panel = el("div", "mm-bedrock-pack-panel");

    const intro = el("p", "mm-bedrock-panel-desc");
    intro.textContent = introText;
    panel.appendChild(intro);

    const tabBar = el("div", "mm-pack-bedrock-tabs");
    const btnActive = el("button", "mm-pack-bedrock-tab mm-pack-bedrock-tab--active") as HTMLButtonElement;
    btnActive.type = "button";
    btnActive.textContent = "Active";
    const btnAvail = el("button", "mm-pack-bedrock-tab") as HTMLButtonElement;
    btnAvail.type = "button";
    btnAvail.textContent = "Available";
    tabBar.appendChild(btnActive);
    tabBar.appendChild(btnAvail);
    panel.appendChild(tabBar);

    const body = el("div", "mm-pack-bedrock-tab-body");

    const activeWell = el("div", "mm-pack-active-well");
    appendBuiltInStratumRow(activeWell, builtInSubtitle);
    activeWell.appendChild(activeUl);

    const paint = (): void => {
      btnActive.classList.toggle("mm-pack-bedrock-tab--active", sub === "active");
      btnAvail.classList.toggle("mm-pack-bedrock-tab--active", sub === "available");
      body.replaceChildren();
      if (sub === "active") {
        const pane = el("div", "mm-pack-bedrock-pane");
        const localLab = el("p", "mm-pack-bedrock-pane-label");
        localLab.textContent = "Local";
        pane.appendChild(localLab);
        pane.appendChild(activeWell);
        const foot = el("p", "mm-pack-bedrock-footnote mm-note");
        foot.textContent = footnote;
        pane.appendChild(foot);
        body.appendChild(pane);
      } else {
        const pane = el("div", "mm-pack-bedrock-pane");
        const localLab = el("p", "mm-pack-bedrock-pane-label");
        localLab.textContent = "Available";
        const scroll = el("div", "mm-pack-installed-inner mm-pack-available-well");
        scroll.appendChild(installedMount);
        pane.appendChild(localLab);
        pane.appendChild(scroll);
        body.appendChild(pane);
      }
    };

    btnActive.addEventListener("click", () => {
      sub = "active";
      paint();
    });
    btnAvail.addEventListener("click", () => {
      sub = "available";
      paint();
    });

    panel.appendChild(body);
    paint();
    return panel;
  }

  const behaviorPanel = createBedrockPackPanel(
    "Stratum Core behavior loads first. On Active, drag packs by the grip to reorder (top = highest priority). Add more from Available.",
    ulBeh,
    installedBehMount,
    "Vanilla blocks, items, recipes, and loot from the built-in behavior pack. Cannot be removed.",
    "If two packs change the same content, the higher pack in the list wins.",
  );

  const resourcePanel = createBedrockPackPanel(
    "Stratum Core textures load first. On Active, drag packs by the grip to reorder. World packs apply before global texture packs in Settings.",
    ulRes,
    installedResMount,
    "Vanilla terrain and item textures from the built-in resource pack. Cannot be removed.",
    "Higher packs override lower packs when both provide the same texture.",
  );

  const generalPackOptions = el("div", "mm-bedrock-pack-general-options");
  const optIntro = el("p", "mm-bedrock-panel-desc");
  optIntro.textContent =
    "Multiplayer (when available): control whether joiners must download this world’s packs first.";
  generalPackOptions.appendChild(optIntro);
  const reqRow = el("label", "mm-bedrock-mp-toggle");
  const reqCb = el("input") as HTMLInputElement;
  reqCb.type = "checkbox";
  reqCb.checked = requirePacks;
  reqCb.addEventListener("change", () => {
    requirePacks = reqCb.checked;
    flushPackMetadata();
  });
  const reqLab = el("span", "mm-bedrock-mp-toggle-label");
  reqLab.textContent =
    "Require players to download packs before joining (coming soon)";
  reqRow.appendChild(reqCb);
  reqRow.appendChild(reqLab);
  generalPackOptions.appendChild(reqRow);

  renderBoth();

  return {
    getPatch: () => currentPatch(),
    behaviorPanel,
    resourcePanel,
    generalPackOptions,
  };
}

/** @deprecated Use {@link createWorldPackEditorController} for split panels. */
export function appendWorldPacksEditor(
  parent: HTMLElement,
  opts: {
    worldMeta: WorldMetadata;
    repo: IModRepository | null;
    getInstalled: (() => readonly CachedMod[]) | null;
    persistPackMetadata?: (patch: WorldPackPatch) => void | Promise<void>;
  },
): { getPatch: () => WorldPackPatch } {
  const c = createWorldPackEditorController({
    worldMeta: opts.worldMeta,
    repo: opts.repo,
    getInstalled: opts.getInstalled,
    persistPackMetadata: opts.persistPackMetadata,
  });
  const wrap = el("div");
  wrap.appendChild(c.behaviorPanel);
  wrap.appendChild(c.resourcePanel);
  wrap.appendChild(c.generalPackOptions);
  parent.appendChild(wrap);
  return { getPatch: c.getPatch };
}
