/**
 * Global resource (texture) pack stack — Settings / pause menu.
 */
import type { CachedMod } from "../mods/workshopTypes";
import type { IndexedDBStore, WorkshopModRef } from "../persistence/IndexedDBStore";

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

function refKey(r: WorkshopModRef): string {
  return `${r.recordId}:${r.modId}:${r.version}`;
}

/** Opens a modal; saves to IndexedDB on Done. */
export async function openGlobalTexturePacksModal(opts: {
  store: IndexedDBStore;
  getInstalled: () => readonly CachedMod[];
}): Promise<void> {
  await opts.store.openDB();
  const settings = await opts.store.loadPlayerSettings();
  const refs: WorkshopModRef[] = settings.globalResourcePackRefs.map((r) => ({
    recordId: r.recordId,
    modId: r.modId,
    version: r.version,
  }));

  let dragFrom: number | null = null;

  const backdrop = el("div", "mm-modal");
  const card = el("div", "mm-modal-card");
  card.style.maxWidth = "min(440px, 94vw)";
  const h = el("h3", "mm-modal-title");
  h.textContent = "Texture packs";
  card.appendChild(h);
  const meta = el("p", "mm-modal-meta");
  meta.textContent =
    "Stratum Core and each world’s resource packs load first. Global packs below stack on top; lower rows load earlier, so the bottom row wins texture conflicts. Drag to reorder.";
  card.appendChild(meta);

  const builtIn = el("div", "mm-pack-built-in-block");
  builtIn.style.margin = "10px 0";
  builtIn.style.padding = "8px 10px";
  builtIn.style.borderRadius = "8px";
  builtIn.style.background = "rgba(255,255,255,0.04)";
  builtIn.style.border = "1px solid rgba(255,255,255,0.08)";
  const biTitle = el("div", "mm-bedrock-pack-row-label");
  biTitle.textContent = "Stratum Core (built-in)";
  const biSub = el("p", "mm-note");
  biSub.style.margin = "6px 0 0";
  biSub.style.fontSize = "12px";
  biSub.textContent =
    "Core textures always load first. This list only controls optional global packs on top.";
  builtIn.appendChild(biTitle);
  builtIn.appendChild(biSub);
  card.appendChild(builtIn);

  const ul = el("ul") as HTMLUListElement;
  ul.style.listStyle = "none";
  ul.style.padding = "0";
  ul.style.margin = "10px 0";
  ul.style.maxHeight = "min(40vh, 320px)";
  ul.style.overflowY = "auto";

  const render = (): void => {
    ul.replaceChildren();
    refs.forEach((ref, index) => {
      const li = el("li");
      li.draggable = true;
      li.style.display = "flex";
      li.style.alignItems = "center";
      li.style.justifyContent = "space-between";
      li.style.gap = "8px";
      li.style.padding = "6px 8px";
      li.style.marginBottom = "4px";
      li.style.borderRadius = "8px";
      li.style.background = "rgba(255,255,255,0.06)";
      li.style.border = "1px solid rgba(255,255,255,0.08)";
      li.dataset.index = String(index);
      const lab = el("span");
      lab.style.fontSize = "13px";
      lab.textContent = `${ref.modId} · v${ref.version}`;
      const rm = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
      rm.type = "button";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        refs.splice(index, 1);
        render();
      });
      li.appendChild(lab);
      li.appendChild(rm);
      li.addEventListener("dragstart", () => {
        dragFrom = index;
      });
      li.addEventListener("dragover", (ev) => {
        ev.preventDefault();
      });
      li.addEventListener("drop", (ev) => {
        ev.preventDefault();
        if (dragFrom === null) {
          return;
        }
        const targetIdx = parseInt(li.dataset.index ?? "0", 10);
        const fromI = dragFrom;
        dragFrom = null;
        const [moved] = refs.splice(fromI, 1);
        if (moved === undefined) {
          render();
          return;
        }
        let insertAt = targetIdx;
        if (fromI < targetIdx) {
          insertAt -= 1;
        }
        refs.splice(insertAt, 0, moved);
        render();
      });
      ul.appendChild(li);
    });
  };

  render();
  card.appendChild(ul);

  const add = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
  add.type = "button";
  add.textContent = "Add resource pack…";
  add.style.marginBottom = "8px";
  add.addEventListener("click", () => {
    const candidates = opts
      .getInstalled()
      .filter((c) => c.manifest.mod_type === "resource_pack");
    const pickBackdrop = el("div", "mm-modal");
    const pickCard = el("div", "mm-modal-card");
    const ph = el("h3", "mm-modal-title");
    ph.textContent = "Pick resource pack";
    pickCard.appendChild(ph);
    if (candidates.length === 0) {
      const empty = el("p", "mm-modal-meta");
      empty.textContent = "No resource packs installed.";
      pickCard.appendChild(empty);
    } else {
      const list = el("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "6px";
      list.style.maxHeight = "200px";
      list.style.overflowY = "auto";
      for (const c of candidates) {
        const b = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
        b.type = "button";
        b.style.textAlign = "left";
        b.textContent = `${c.manifest.name} · ${c.modId} v${c.version}`;
        b.addEventListener("click", () => {
          const r: WorkshopModRef = {
            recordId: c.recordId,
            modId: c.modId,
            version: c.version,
          };
          if (!refs.some((x) => refKey(x) === refKey(r))) {
            refs.push(r);
          }
          render();
          pickBackdrop.remove();
        });
        list.appendChild(b);
      }
      pickCard.appendChild(list);
    }
    const prow = el("div", "mm-modal-actions");
    const pc = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    pc.type = "button";
    pc.textContent = "Cancel";
    pc.addEventListener("click", () => pickBackdrop.remove());
    prow.appendChild(pc);
    pickCard.appendChild(prow);
    pickBackdrop.appendChild(pickCard);
    pickBackdrop.addEventListener("click", (ev) => {
      if (ev.target === pickBackdrop) {
        pickBackdrop.remove();
      }
    });
    document.body.appendChild(pickBackdrop);
  });
  card.appendChild(add);

  const actions = el("div", "mm-modal-actions");
  const cancel = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => backdrop.remove());
  const done = el("button", "mm-btn") as HTMLButtonElement;
  done.type = "button";
  done.textContent = "Done";
  done.addEventListener("click", async () => {
    await opts.store.savePlayerSettings({
      key: "v1",
      globalResourcePackRefs: refs.map((r) => ({ ...r })),
    });
    backdrop.remove();
  });
  actions.appendChild(cancel);
  actions.appendChild(done);
  card.appendChild(actions);

  backdrop.appendChild(card);
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) {
      backdrop.remove();
    }
  });
  document.body.appendChild(backdrop);
}
