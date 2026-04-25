/** Main-menu workshop UI: browse, detail, upload, owned mods (DOM + EventBus only). */

import { gunzipSync, unzipSync, zipSync } from "fflate";
import { MOD_PAGE_SIZE } from "../../core/constants";
import { semverGt } from "../../util/semverGt";
import type { EventBus } from "../../core/EventBus";
import type { GameEvent } from "../../core/types";
import { readWorkshopManifestFromZipFiles } from "../../mods/ModRepository";
import type {
  CachedMod,
  ModListEntry,
  ModSortBy,
  ModTypeFilter,
  WorkshopModTypeRow,
} from "../../mods/workshopTypes";
import { findPackPngBytes } from "../../mods/cachedModPackIcon";
import {
  STRATUM_CORE_BEHAVIOR_PACK_PATH,
  STRATUM_CORE_RESOURCE_PACK_PATH,
} from "../../mods/internalPackManifest";
import {
  BLOCK_TEXTURE_MANIFEST_PATH,
  ITEM_TEXTURE_MANIFEST_PATH,
} from "../../core/textureManifest";
import { parseJsoncResponse, parseJsoncText } from "../../core/jsonc";

const templateBehaviorPackJsonFiles = import.meta.glob(
  "/public/assets/mods/behavior_packs/stratum-core/{blocks,items,recipes,loot_tables,smelting,furnace_fuel,features,structures}/**/*.json",
  { eager: false },
);

export type WorkshopScreenDeps = {
  bus: EventBus;
  getModPublicUrl: (storagePath: string) => string;
  isInstalled: (modId: string) => boolean;
  getUserId: () => string | null;
  getInstalledPacks: () => readonly CachedMod[];
};

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

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const s = dataUrl.trim();
  const idx = s.indexOf(",");
  if (!s.startsWith("data:") || idx < 0) {
    return new Uint8Array();
  }
  const meta = s.slice(0, idx);
  const body = s.slice(idx + 1);
  const isB64 = /;base64/i.test(meta);
  if (!isB64) {
    return new Uint8Array();
  }
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function triggerBytesDownload(filename: string, bytes: Uint8Array, mime: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
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

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(res.statusText || `Failed to fetch (${res.status})`);
  }
  return parseJsoncResponse(res, url);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(res.statusText || `Failed to fetch (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

function safeZipName(s: string): string {
  return (s.trim().slice(0, 72) || "pack").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_");
}

function discoverCorePackPaths(globMap: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const path of Object.keys(globMap)) {
    if (!path.startsWith("/public/")) {
      continue;
    }
    out.push(path.slice("/public/".length));
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

function formatWorkshopDownloadCount(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  }
  if (n >= 10_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(2)}K`;
  }
  return String(n);
}

function formatWorkshopRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "";
  }
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 45) {
    return "Just now";
  }
  if (sec < 3600) {
    return `${Math.floor(sec / 60)}m ago`;
  }
  if (sec < 86400) {
    return `${Math.floor(sec / 3600)}h ago`;
  }
  if (sec < 604800) {
    return `${Math.floor(sec / 86400)}d ago`;
  }
  if (sec < 2_628_000) {
    return `${Math.floor(sec / 604800)}w ago`;
  }
  return `${Math.floor(sec / 2_628_000)}mo ago`;
}

function formatWorkshopListMetaLine(m: ModListEntry): string {
  const rc = m.ratingCount;
  const rating =
    rc > 0
      ? `★ ${m.avgRating.toFixed(1)} (${rc})`
      : `★ ${m.avgRating.toFixed(1)}`;
  const downloads = `${formatWorkshopDownloadCount(m.downloadCount)} downloads`;
  const when = formatWorkshopRelativeTime(m.createdAt);
  return when.length > 0 ? `${rating} · ${downloads} · ${when}` : `${rating} · ${downloads}`;
}

function truncateLibraryDescription(raw: string, maxLen: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length === 0) {
    return "";
  }
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatWorkshopFileSize(bytes: number): string {
  const n = Math.max(0, Math.floor(bytes));
  if (n < 1024) {
    return `${n} B`;
  }
  const kb = n / 1024;
  if (kb < 1024) {
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

function workshopModTypeBadgeLabel(modType: WorkshopModTypeRow): string {
  if (modType === "behavior_pack") {
    return "Behavior";
  }
  if (modType === "resource_pack") {
    return "Resource";
  }
  if (modType === "world") {
    return "World";
  }
  return modType;
}

export class WorkshopScreen {
  private readonly deps: WorkshopScreenDeps;

  private unsubs: Array<() => void> = [];

  private root: HTMLElement | null = null;

  private exploreWrap: HTMLElement | null = null;

  private tabExplore: HTMLButtonElement | null = null;

  private tabOwned: HTMLButtonElement | null = null;

  private tabUpload: HTMLButtonElement | null = null;

  private tabLibrary: HTMLButtonElement | null = null;

  private tabTemplates: HTMLButtonElement | null = null;

  private subView:
    | "explore"
    | "detail"
    | "upload"
    | "owned"
    | "library"
    | "templates" = "explore";

  private listOffset = 0;

  private modType: ModTypeFilter = "all";

  private sortBy: ModSortBy = "newest";

  private searchQuery = "";

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private lastList: readonly ModListEntry[] = [];

  private lastHasMore = false;

  private detailRecordId: string | null = null;

  /** Workshop pack id (`manifest.id`) for the open detail view; cleared when leaving detail. */
  private detailModId: string | null = null;

  private readonly installingModIds = new Set<string>();

  private readonly uninstallingModIds = new Set<string>();

  private actionFeedbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  private libraryUpdateByModId = new Map<
    string,
    { latestRecordId: string; latestVersion: string; currentVersion: string }
  >();

  /** Blob URLs for pack icons in My Library; revoked on next library render / unmount. */
  private readonly libraryBlobUrls: string[] = [];

  /** Developer folder status shown in Templates tab. */
  private devFolderDisplayPath: string | null = null;
  private devFolderState: "idle" | "syncing" | "ready" | "error" = "idle";
  private devFolderPackCount = 0;
  private devFolderError: string | null = null;

  constructor(deps: WorkshopScreenDeps) {
    this.deps = deps;
  }

  private subnavKey(): "explore" | "owned" | "upload" | "library" | "templates" {
    if (this.subView === "detail") {
      return "explore";
    }
    return this.subView;
  }

  private updateSubnavHighlight(): void {
    const k = this.subnavKey();
    this.tabExplore?.classList.toggle("mm-workshop-tab-active", k === "explore");
    this.tabOwned?.classList.toggle("mm-workshop-tab-active", k === "owned");
    this.tabLibrary?.classList.toggle("mm-workshop-tab-active", k === "library");
    this.tabUpload?.classList.toggle("mm-workshop-tab-active", k === "upload");
    this.tabTemplates?.classList.toggle("mm-workshop-tab-active", k === "templates");
  }

  private setModDetailChrome(active: boolean): void {
    this.root?.classList.toggle("mm-workshop-root--mod-detail", active);
  }

  private makeField(labelText: string, control: HTMLElement): HTMLElement {
    const f = el("div", "mm-field");
    const lb = el("label");
    lb.textContent = labelText;
    f.appendChild(lb);
    f.appendChild(control);
    return f;
  }

  mount(parent: HTMLElement): () => void {
    this.root = el("div", "mm-panel mm-workshop-root");
    const title = el("p", "mm-panel-title");
    title.textContent = "Workshop";
    this.root.appendChild(title);

    const subNav = el("div", "mm-workshop-tabs");
    const btnExplore = el("button", "mm-workshop-tab mm-workshop-tab-active") as HTMLButtonElement;
    btnExplore.type = "button";
    btnExplore.textContent = "Explore";
    const btnLibrary = el("button", "mm-workshop-tab") as HTMLButtonElement;
    btnLibrary.type = "button";
    btnLibrary.textContent = "My Library";
    const btnOwned = el("button", "mm-workshop-tab mm-workshop-tab-secondary") as HTMLButtonElement;
    btnOwned.type = "button";
    btnOwned.textContent = "My Uploads";
    const btnUpload = el("button", "mm-workshop-tab mm-workshop-tab-secondary") as HTMLButtonElement;
    btnUpload.type = "button";
    btnUpload.textContent = "Upload";
    const btnTemplates = el("button", "mm-workshop-tab mm-workshop-tab-secondary") as HTMLButtonElement;
    btnTemplates.type = "button";
    btnTemplates.textContent = "Templates";
    subNav.appendChild(btnExplore);
    subNav.appendChild(btnLibrary);
    subNav.appendChild(btnOwned);
    subNav.appendChild(btnUpload);
    subNav.appendChild(btnTemplates);
    this.root.appendChild(subNav);

    this.tabExplore = btnExplore;
    this.tabOwned = btnOwned;
    this.tabLibrary = btnLibrary;
    this.tabUpload = btnUpload;
    this.tabTemplates = btnTemplates;

    this.exploreWrap = el("div", "mm-workshop-body");
    this.root.appendChild(this.exploreWrap);

    parent.appendChild(this.root);

    btnExplore.addEventListener("click", () => {
      this.subView = "explore";
      this.detailRecordId = null;
      this.renderExploreChrome();
      this.requestList(0);
      this.updateSubnavHighlight();
    });
    btnOwned.addEventListener("click", () => {
      this.subView = "owned";
      this.detailRecordId = null;
      this.deps.bus.emit({ type: "workshop:request-owned" } satisfies GameEvent);
      this.renderOwnedPlaceholder();
      this.updateSubnavHighlight();
    });
    btnLibrary.addEventListener("click", () => {
      this.subView = "library";
      this.detailRecordId = null;
      this.renderLibrary();
      this.updateSubnavHighlight();
    });
    btnUpload.addEventListener("click", () => {
      this.subView = "upload";
      this.detailRecordId = null;
      this.renderUploadForm();
      this.updateSubnavHighlight();
    });
    btnTemplates.addEventListener("click", () => {
      this.subView = "templates";
      this.detailRecordId = null;
      this.renderTemplates();
      this.updateSubnavHighlight();
    });

    this.wireBus();
    this.renderExploreChrome();
    this.requestList(0);
    this.updateSubnavHighlight();

    return () => this.unmount();
  }

  private unmount(): void {
    for (const u of this.unsubs) {
      u();
    }
    this.unsubs = [];
    this.root?.remove();
    this.root = null;
    this.exploreWrap = null;
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.actionFeedbackTimer !== null) {
      clearTimeout(this.actionFeedbackTimer);
      this.actionFeedbackTimer = null;
    }
    this.installingModIds.clear();
    this.uninstallingModIds.clear();
    this.detailModId = null;
    for (const u of this.libraryBlobUrls) {
      URL.revokeObjectURL(u);
    }
    this.libraryBlobUrls.length = 0;
  }

  private clearWorkshopActionFeedback(): void {
    if (this.actionFeedbackTimer !== null) {
      clearTimeout(this.actionFeedbackTimer);
      this.actionFeedbackTimer = null;
    }
    const fb = this.root?.querySelector<HTMLElement>("[data-role='workshop-action-feedback']") ?? null;
    if (fb !== null) {
      fb.hidden = true;
      fb.textContent = "";
    }
  }

  private showWorkshopActionFeedback(message: string): void {
    this.clearWorkshopActionFeedback();
    const fb = this.root?.querySelector<HTMLElement>("[data-role='workshop-action-feedback']") ?? null;
    if (fb === null) {
      return;
    }
    fb.textContent = message;
    fb.hidden = false;
    this.actionFeedbackTimer = globalThis.setTimeout(() => {
      fb.hidden = true;
      fb.textContent = "";
      this.actionFeedbackTimer = null;
    }, 2800);
  }

  private applyInstallButtonShell(
    btn: HTMLButtonElement,
    modId: string,
    action: "install" | "install-update" = "install",
  ): void {
    btn.dataset.workshopModId = modId;
    btn.dataset.workshopAction = action;
    btn.replaceChildren();
    const idle = el("span", "mm-workshop-btn-content mm-workshop-btn-content--idle");
    const label = el("span", "mm-workshop-btn-label");
    idle.appendChild(label);
    const busy = el("span", "mm-workshop-btn-content mm-workshop-btn-content--busy");
    busy.hidden = true;
    busy.appendChild(el("div", "mm-workshop-spinner mm-workshop-spinner--btn"));
    busy.appendChild(document.createTextNode(" Installing…"));
    btn.appendChild(idle);
    btn.appendChild(busy);
  }

  private applyUninstallButtonShell(btn: HTMLButtonElement, modId: string): void {
    btn.dataset.workshopModId = modId;
    btn.dataset.workshopAction = "uninstall";
    btn.replaceChildren();
    const idle = el("span", "mm-workshop-btn-content mm-workshop-btn-content--idle");
    idle.textContent = "Uninstall";
    const busy = el("span", "mm-workshop-btn-content mm-workshop-btn-content--busy");
    busy.hidden = true;
    busy.appendChild(el("div", "mm-workshop-spinner mm-workshop-spinner--btn"));
    busy.appendChild(document.createTextNode(" Uninstalling…"));
    btn.appendChild(idle);
    btn.appendChild(busy);
  }

  /** Keeps list / detail / library install & uninstall controls in sync with cache and in-flight actions. */
  private syncWorkshopModUi(modId: string): void {
    const root = this.root;
    if (root === null) {
      return;
    }
    const installed = this.deps.isInstalled(modId);
    const installing = this.installingModIds.has(modId);
    const uninstalling = this.uninstallingModIds.has(modId);

    for (const btn of root.querySelectorAll<HTMLButtonElement>(
      "button[data-workshop-action][data-workshop-mod-id]",
    )) {
      if (btn.dataset.workshopModId !== modId) {
        continue;
      }
      const action = btn.dataset.workshopAction;
      if (action === "install" || action === "install-update") {
        const isUpdate = action === "install-update";
        const idle = btn.querySelector<HTMLElement>(".mm-workshop-btn-content--idle");
        const busy = btn.querySelector<HTMLElement>(".mm-workshop-btn-content--busy");
        const idleLabel = btn.querySelector<HTMLElement>(".mm-workshop-btn-label");
        const customIdle = btn.dataset.workshopIdleLabel;
        if (installing) {
          btn.disabled = true;
          btn.classList.add("mm-workshop-btn--working");
          btn.setAttribute("aria-busy", "true");
          if (idle !== null) {
            idle.hidden = true;
          }
          if (busy !== null) {
            busy.hidden = false;
          }
        } else {
          btn.classList.remove("mm-workshop-btn--working");
          btn.removeAttribute("aria-busy");
          if (idle !== null) {
            idle.hidden = false;
          }
          if (busy !== null) {
            busy.hidden = true;
          }
          if (isUpdate) {
            btn.disabled = false;
            btn.classList.add("mm-btn-subtle");
            if (idleLabel !== null) {
              idleLabel.textContent =
                customIdle !== undefined && customIdle.length > 0 ? customIdle : "Update";
            }
          } else if (installed) {
            btn.disabled = true;
            btn.classList.add("mm-btn-subtle");
            if (idleLabel !== null) {
              idleLabel.textContent = "Installed";
            }
          } else {
            btn.disabled = false;
            btn.classList.remove("mm-btn-subtle");
            if (idleLabel !== null) {
              idleLabel.textContent = "Install";
            }
          }
        }
      } else if (action === "uninstall") {
        btn.hidden = !installed;
        if (!installed) {
          continue;
        }
        const idle = btn.querySelector<HTMLElement>(".mm-workshop-btn-content--idle");
        const busy = btn.querySelector<HTMLElement>(".mm-workshop-btn-content--busy");
        if (uninstalling) {
          btn.disabled = true;
          btn.classList.add("mm-workshop-btn--working");
          btn.setAttribute("aria-busy", "true");
          if (idle !== null) {
            idle.hidden = true;
          }
          if (busy !== null) {
            busy.hidden = false;
          }
        } else {
          btn.disabled = false;
          btn.classList.remove("mm-workshop-btn--working");
          btn.removeAttribute("aria-busy");
          if (idle !== null) {
            idle.hidden = false;
          }
          if (busy !== null) {
            busy.hidden = true;
          }
        }
      }
    }
  }

  private wireBus(): void {
    const b = this.deps.bus;
    this.unsubs.push(
      b.on("workshop:list-result", (e) => {
        if (this.subView !== "explore" && this.subView !== "detail") {
          return;
        }
        this.lastList = e.records;
        this.listOffset = e.offset;
        if (this.detailRecordId === null) {
          this.renderModGrid(e.records, e.hasMore);
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:dev-sync-ok", (e) => {
        this.devFolderState = "ready";
        this.devFolderPackCount = e.packCount;
        this.devFolderError = null;
        if (this.subView === "templates") {
          this.showWorkshopActionFeedback(
            e.packCount > 0
              ? `Developer packs loaded (${e.packCount} installed).`
              : "Developer pack folder set.",
          );
          this.renderTemplates();
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:dev-sync-error", (e) => {
        this.devFolderState = "error";
        this.devFolderError = e.message;
        if (this.subView === "templates") {
          this.showWorkshopActionFeedback(e.message);
          this.renderTemplates();
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:detail-result", (e) => {
        this.subView = "detail";
        this.renderDetail(e.record, e.comments);
        this.updateSubnavHighlight();
      }),
    );
    this.unsubs.push(
      b.on("workshop:comment-result", (e) => {
        if (this.detailRecordId === e.recordId) {
          this.renderCommentList(e.comments);
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:publish-result", () => {
        if (this.subView === "upload") {
          this.renderUploadForm(true);
        }
        this.requestList(0);
      }),
    );
    this.unsubs.push(
      b.on("workshop:publish-error", (e) => {
        const errEl = this.root?.querySelector(".mm-workshop-publish-err");
        if (errEl !== null && errEl !== undefined) {
          errEl.textContent = e.message;
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:owned-result", (e) => {
        if (this.subView === "owned") {
          this.renderOwnedList(e.records);
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:deleted", () => {
        this.deps.bus.emit({ type: "workshop:request-owned" } satisfies GameEvent);
      }),
    );
    this.unsubs.push(
      b.on("workshop:library-updates-result", (e) => {
        this.libraryUpdateByModId.clear();
        for (const u of e.updates) {
          this.libraryUpdateByModId.set(u.modId, {
            latestRecordId: u.latestRecordId,
            latestVersion: u.latestVersion,
            currentVersion: u.currentVersion,
          });
        }
        if (this.subView === "library") {
          this.renderLibrary();
        }
      }),
    );
    this.unsubs.push(
      b.on("mod:install-started", (e) => {
        this.installingModIds.add(e.modId);
        this.syncWorkshopModUi(e.modId);
      }),
    );
    this.unsubs.push(
      b.on("mod:install-progress", (e) => {
        this.syncWorkshopModUi(e.modId);
      }),
    );
    this.unsubs.push(
      b.on("mod:install-complete", (e) => {
        this.installingModIds.delete(e.modId);
        this.syncWorkshopModUi(e.modId);
        if (this.subView === "explore" || this.subView === "detail") {
          this.requestList(this.listOffset);
        }
        if (this.subView === "library") {
          this.renderLibrary();
        }
        if (this.subView === "detail" && this.detailModId === e.modId) {
          this.showWorkshopActionFeedback("Installed. Add it from Solo → Edit World or Settings.");
        }
      }),
    );
    this.unsubs.push(
      b.on("mod:install-error", (e) => {
        this.installingModIds.delete(e.modId);
        this.syncWorkshopModUi(e.modId);
        const msg = (e as { modId: string; message?: string }).message;
        if (this.subView === "detail" && this.detailModId === e.modId) {
          this.showWorkshopActionFeedback(msg ?? "Install failed.");
        }
      }),
    );
    this.unsubs.push(
      b.on("mod:uninstalled", (e) => {
        this.uninstallingModIds.delete(e.modId);
        this.syncWorkshopModUi(e.modId);
        if (this.subView === "library") {
          this.renderLibrary();
        }
        if (this.subView === "detail" && this.detailModId === e.modId) {
          this.showWorkshopActionFeedback("Removed from your library.");
        }
      }),
    );
    this.unsubs.push(
      b.on("workshop:error", (e) => {
        const wrap = this.exploreWrap;
        if (
          wrap === null ||
          (this.subView !== "explore" && this.subView !== "detail")
        ) {
          return;
        }
        if (wrap.querySelector(".mm-workshop-err") === null) {
          const p = el("p", "mm-workshop-err");
          p.textContent = e.message;
          wrap.prepend(p);
        }
      }),
    );
  }

  private requestList(offset: number): void {
    this.listOffset = offset;
    this.deps.bus.emit({
      type: "workshop:request-list",
      offset,
      modType: this.modType,
      sortBy: this.sortBy,
      query: this.searchQuery,
    } satisfies GameEvent);
  }

  private renderExploreChrome(): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    this.detailModId = null;
    this.clearWorkshopActionFeedback();
    this.setModDetailChrome(false);
    wrap.replaceChildren();

    const browser = el("div", "mm-workshop-browser");
    const main = el("div", "mm-workshop-main");

    const filterStrip = el("div", "mm-workshop-filter-strip");
    const controlsTop = el("div", "mm-workshop-controls-top");
    controlsTop.setAttribute("role", "group");
    controlsTop.setAttribute("aria-label", "Search and sort");

    const controlsBottom = el("div", "mm-workshop-controls-bottom");
    controlsBottom.setAttribute("role", "group");
    controlsBottom.setAttribute("aria-label", "Type filter");

    const typePills = el("div", "mm-workshop-type-pills");
    const typeDefs: { v: ModTypeFilter; l: string }[] = [
      { v: "all", l: "All" },
      { v: "behavior_pack", l: "Behavior" },
      { v: "resource_pack", l: "Resource" },
      { v: "world", l: "Worlds" },
    ];
    for (const { v, l } of typeDefs) {
      const pb = el("button", "mm-workshop-type-pill") as HTMLButtonElement;
      pb.type = "button";
      pb.textContent = l;
      if (v === this.modType) {
        pb.classList.add("mm-workshop-type-pill-active");
      }
      pb.addEventListener("click", () => {
        this.modType = v;
        this.renderExploreChrome();
        this.requestList(0);
      });
      typePills.appendChild(pb);
    }
    controlsBottom.appendChild(typePills);

    const sortPills = el("div", "mm-workshop-sort-pills");
    sortPills.setAttribute("aria-label", "Sort");
    const sorts: { v: ModSortBy; l: string }[] = [
      { v: "newest", l: "Newest" },
      { v: "downloads", l: "Downloads" },
      { v: "rating", l: "Top rated" },
    ];
    for (const { v, l } of sorts) {
      const sb = el("button", "mm-workshop-sort-pill") as HTMLButtonElement;
      sb.type = "button";
      sb.textContent = l;
      if (v === this.sortBy) {
        sb.classList.add("mm-workshop-sort-pill-active");
      }
      sb.addEventListener("click", () => {
        this.sortBy = v;
        this.renderExploreChrome();
        this.requestList(0);
      });
      sortPills.appendChild(sb);
    }

    const searchWrap = el("div", "mm-workshop-search-wrap");
    const searchIcon = el("span", "mm-workshop-search-icon");
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.textContent = "⌕";
    const search = el("input", "mm-workshop-search-input") as HTMLInputElement;
    search.type = "text";
    search.placeholder = "Search mods…";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search mods");
    search.value = this.searchQuery;
    search.addEventListener("input", () => {
      if (this.searchTimer !== null) {
        clearTimeout(this.searchTimer);
      }
      this.searchTimer = setTimeout(() => {
        this.searchQuery = search.value.trim();
        this.requestList(0);
      }, 300);
    });
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(search);
    controlsTop.appendChild(searchWrap);
    controlsTop.appendChild(sortPills);
    filterStrip.appendChild(controlsTop);
    filterStrip.appendChild(controlsBottom);
    main.appendChild(filterStrip);

    const listStatus = el("p", "mm-workshop-list-status");
    listStatus.setAttribute("aria-live", "polite");
    const page = Math.floor(this.listOffset / MOD_PAGE_SIZE) + 1;
    listStatus.textContent =
      this.lastList.length > 0
        ? `${this.lastList.length} on this page · page ${page}`
        : "";
    listStatus.hidden = this.lastList.length === 0;
    main.appendChild(listStatus);

    const gridHost = el("div", "mm-workshop-grid-host");
    main.appendChild(gridHost);

    browser.appendChild(main);
    wrap.appendChild(browser);

    this.renderModGrid(this.lastList, this.lastHasMore);
    this.updateSubnavHighlight();
  }

  private renderModGrid(records: readonly ModListEntry[], hasMore: boolean): void {
    this.lastHasMore = hasMore;
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    const host = wrap.querySelector(".mm-workshop-grid-host");
    if (host === null) {
      return;
    }
    const statusEl = wrap.querySelector(".mm-workshop-list-status") as HTMLElement | null;
    if (statusEl !== null) {
      const page = Math.floor(this.listOffset / MOD_PAGE_SIZE) + 1;
      if (records.length > 0) {
        statusEl.textContent = `${records.length} on this page · page ${page}`;
        statusEl.hidden = false;
      } else {
        statusEl.textContent = "";
        statusEl.hidden = true;
      }
    }

    host.replaceChildren();

    if (records.length === 0) {
      const empty = el("div", "mm-workshop-empty");
      empty.textContent =
        "No mods match your filters. Try different search terms or content type.";
      host.appendChild(empty);
    } else {
      const grid = el("div", "mm-workshop-tile-grid");
      for (const m of records) {
        grid.appendChild(this.modTileCard(m));
      }
      host.appendChild(grid);
      for (const m of records) {
        this.syncWorkshopModUi(m.modId);
      }
    }

    const pager = el("div", "mm-workshop-pager");
    const prev = el("button", "mm-btn mm-btn-subtle mm-workshop-pager-btn") as HTMLButtonElement;
    prev.type = "button";
    prev.textContent = "Previous";
    prev.disabled = this.listOffset <= 0;
    prev.addEventListener("click", () => {
      this.requestList(Math.max(0, this.listOffset - MOD_PAGE_SIZE));
    });
    const next = el("button", "mm-btn mm-btn-subtle mm-workshop-pager-btn") as HTMLButtonElement;
    next.type = "button";
    next.textContent = "Next";
    next.disabled = !hasMore;
    next.addEventListener("click", () => {
      this.requestList(this.listOffset + MOD_PAGE_SIZE);
    });
    const page = Math.floor(this.listOffset / MOD_PAGE_SIZE) + 1;
    const pageLabel = el("div", "mm-workshop-pager-indicator");
    pageLabel.textContent = `Page ${page}`;
    pager.appendChild(prev);
    pager.appendChild(pageLabel);
    pager.appendChild(next);
    host.appendChild(pager);
  }

  private modTileCard(m: ModListEntry): HTMLElement {
    const card = el("article", "mm-workshop-tile");
    // Tab order guardrail: focus hits the card first, then its CTA button.
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", `${m.name} by ${m.authorName}`);

    const openDetail = (): void => {
      this.detailRecordId = m.id;
      this.deps.bus.emit({ type: "workshop:open-detail", recordId: m.id } satisfies GameEvent);
    };
    card.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("button")) {
        return;
      }
      openDetail();
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openDetail();
      }
    });

    const media = el("div", "mm-workshop-tile-media");
    const img = el("img", "mm-workshop-tile-img") as HTMLImageElement;
    img.loading = "lazy";
    img.alt = "";
    if (m.coverPath.length > 0) {
      img.src = this.deps.getModPublicUrl(m.coverPath);
    }
    media.appendChild(img);
    card.appendChild(media);

    const body = el("div", "mm-workshop-tile-body");
    const title = el("h3", "mm-workshop-tile-title");
    title.textContent = m.name;
    body.appendChild(title);

    const author = el("p", "mm-workshop-tile-author");
    author.textContent = m.authorName.length > 0 ? `by ${m.authorName}` : "by unknown";
    body.appendChild(author);

    const metaRow = el("div", "mm-workshop-tile-meta");
    const badge = el("span", `mm-workshop-badge mm-workshop-badge-${m.modType}`);
    badge.textContent =
      m.modType === "behavior_pack"
        ? "Behavior"
        : m.modType === "resource_pack"
          ? "Resource"
          : m.modType;
    metaRow.appendChild(badge);
    const meta = el("span", "mm-workshop-tile-meta-line");
    meta.textContent = formatWorkshopListMetaLine(m);
    metaRow.appendChild(meta);
    body.appendChild(metaRow);

    const actions = el("div", "mm-workshop-tile-actions");
    const install = el("button", "mm-btn mm-workshop-tile-install") as HTMLButtonElement;
    install.type = "button";
    this.applyInstallButtonShell(install, m.modId);
    install.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (install.disabled || this.installingModIds.has(m.modId)) {
        return;
      }
      this.installingModIds.add(m.modId);
      this.syncWorkshopModUi(m.modId);
      this.deps.bus.emit({
        type: "workshop:install-requested",
        recordId: m.id,
      } satisfies GameEvent);
    });
    if (m.modType === "world") {
      const label = install.querySelector<HTMLElement>(".mm-workshop-btn-label");
      if (label !== null) {
        label.textContent = "Import";
      }
    }
    actions.appendChild(install);
    body.appendChild(actions);

    card.appendChild(body);
    return card;
  }

  private renderDetail(
    m: import("../../mods/workshopTypes").ModDetailEntry,
    comments: readonly import("../../mods/workshopTypes").ModComment[],
  ): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    this.detailModId = m.modId;
    this.clearWorkshopActionFeedback();
    this.setModDetailChrome(true);
    wrap.replaceChildren();

    const page = el("div", "mm-workshop-detail-page");

    const toolbar = el("div", "mm-workshop-detail-toolbar");
    const back = el("button", "mm-btn mm-btn-subtle mm-workshop-detail-back") as HTMLButtonElement;
    back.type = "button";
    back.textContent = "Back to list";
    back.addEventListener("click", () => {
      this.detailRecordId = null;
      this.subView = "explore";
      this.renderExploreChrome();
      this.requestList(this.listOffset);
    });
    const toolCtx = el("span", "mm-workshop-detail-toolbar-context");
    toolCtx.textContent = "Pack details";
    toolbar.appendChild(back);
    toolbar.appendChild(toolCtx);
    page.appendChild(toolbar);

    const coverUrl = m.coverPath.length > 0 ? this.deps.getModPublicUrl(m.coverPath) : "";
    const hero = el("section", "mm-workshop-detail-hero");
    const heroCover = el("div", "mm-workshop-detail-hero-cover");
    if (coverUrl.length > 0) {
      const heroImg = el("img", "mm-workshop-detail-hero-img") as HTMLImageElement;
      heroImg.alt = "";
      heroImg.src = coverUrl;
      heroCover.appendChild(heroImg);
    } else {
      const ph = el("div", "mm-workshop-detail-hero-ph");
      ph.setAttribute("aria-hidden", "true");
      heroCover.appendChild(ph);
    }

    const heroInfo = el("div", "mm-workshop-detail-hero-info");
    const h = el("h2", "mm-workshop-detail-name");
    h.textContent = m.name;
    const author = el("p", "mm-workshop-detail-author");
    author.textContent = m.authorName.length > 0 ? `by ${m.authorName}` : "by unknown";
    const meta = el("div", "mm-workshop-detail-hero-meta");
    const typeBadge = el("span", `mm-workshop-badge mm-workshop-badge-${m.modType}`);
    typeBadge.textContent = workshopModTypeBadgeLabel(m.modType);
    meta.appendChild(typeBadge);
    const rcBanner = m.ratingCount;
    const rateSummary = el("span", "mm-workshop-detail-hero-stat");
    rateSummary.textContent =
      rcBanner > 0
        ? `★ ${m.avgRating.toFixed(1)} · ${rcBanner} rating${rcBanner === 1 ? "" : "s"}`
        : "No ratings yet";
    meta.appendChild(rateSummary);
    const dlSummary = el("span", "mm-workshop-detail-hero-stat");
    dlSummary.textContent = `${formatWorkshopDownloadCount(m.downloadCount)} downloads`;
    meta.appendChild(dlSummary);
    const whenRel = formatWorkshopRelativeTime(m.createdAt);
    if (whenRel.length > 0) {
      const upd = el("span", "mm-workshop-detail-hero-stat");
      upd.textContent = whenRel;
      meta.appendChild(upd);
    }
    heroInfo.appendChild(h);
    heroInfo.appendChild(author);
    heroInfo.appendChild(meta);

    hero.appendChild(heroCover);
    hero.appendChild(heroInfo);
    page.appendChild(hero);

    const columns = el("div", "mm-workshop-detail-columns");
    const mainCol = el("div", "mm-workshop-detail-main");

    const aboutCard = el("section", "mm-workshop-detail-about-card");
    const aboutTitle = el("h3", "mm-workshop-detail-section-title");
    aboutTitle.textContent = "About";
    const desc = el("p", "mm-workshop-detail-desc");
    desc.textContent = m.description;
    aboutCard.appendChild(aboutTitle);
    aboutCard.appendChild(desc);
    mainCol.appendChild(aboutCard);

    const comSection = el("section", "mm-workshop-detail-comments-section");
    const comHead = el("h3", "mm-workshop-detail-section-title");
    comHead.appendChild(document.createTextNode("Comments "));
    const comCount = el("span", "mm-workshop-detail-comments-count");
    comCount.dataset.role = "comment-count";
    comCount.textContent = `(${comments.length})`;
    comHead.appendChild(comCount);
    comSection.appendChild(comHead);

    const list = el("div", "mm-workshop-comment-list");
    list.dataset.role = "comment-list";
    for (const c of comments) {
      list.appendChild(this.commentRow(c));
    }
    comSection.appendChild(list);

    const uid = this.deps.getUserId();
    if (uid !== null) {
      const compose = el("div", "mm-workshop-comment-compose");
      const ta = el("textarea") as HTMLTextAreaElement;
      ta.rows = 2;
      ta.placeholder = "Write a comment…";
      const autoGrow = (): void => {
        ta.style.height = "auto";
        ta.style.height = `${Math.max(0, ta.scrollHeight)}px`;
      };
      ta.addEventListener("input", autoGrow);
      // Initial sizing (once attached).
      window.setTimeout(autoGrow, 0);
      compose.appendChild(this.makeField("Add comment", ta));
      const post = el("button", "mm-btn") as HTMLButtonElement;
      post.type = "button";
      post.textContent = "Post";
      post.addEventListener("click", () => {
        this.deps.bus.emit({
          type: "workshop:post-comment",
          recordId: m.id,
          body: ta.value,
        } satisfies GameEvent);
        ta.value = "";
      });
      compose.appendChild(post);
      comSection.appendChild(compose);
    }

    mainCol.appendChild(comSection);

    const side = el("aside", "mm-workshop-detail-side");
    const sideCard = el("div", "mm-workshop-detail-side-card");

    const feedback = el("p", "mm-workshop-action-feedback");
    feedback.dataset.role = "workshop-action-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    feedback.hidden = true;
    sideCard.appendChild(feedback);

    const actions = el("div", "mm-workshop-detail-actions");
    const install = el("button", "mm-btn mm-workshop-detail-install") as HTMLButtonElement;
    install.type = "button";
    this.applyInstallButtonShell(install, m.modId);
    install.addEventListener("click", () => {
      if (install.disabled || this.installingModIds.has(m.modId)) {
        return;
      }
      this.installingModIds.add(m.modId);
      this.syncWorkshopModUi(m.modId);
      this.deps.bus.emit({
        type: "workshop:install-requested",
        recordId: m.id,
      } satisfies GameEvent);
    });
    if (m.modType === "world") {
      const label = install.querySelector<HTMLElement>(".mm-workshop-btn-label");
      if (label !== null) {
        label.textContent = "Import";
      }
    }
    const uninstall = el("button", "mm-btn mm-btn-subtle mm-workshop-detail-uninstall") as HTMLButtonElement;
    uninstall.type = "button";
    this.applyUninstallButtonShell(uninstall, m.modId);
    uninstall.addEventListener("click", () => {
      if (uninstall.disabled || this.uninstallingModIds.has(m.modId)) {
        return;
      }
      this.uninstallingModIds.add(m.modId);
      this.syncWorkshopModUi(m.modId);
      this.deps.bus.emit({
        type: "workshop:uninstall-requested",
        modId: m.modId,
        version: m.version,
      } satisfies GameEvent);
    });
    actions.appendChild(install);
    if (m.modType !== "world") {
      actions.appendChild(uninstall);
    }
    sideCard.appendChild(actions);

    const metaList = el("dl", "mm-workshop-detail-meta-list");
    const addMetaRow = (term: string, def: string): void => {
      const dt = el("dt", "mm-workshop-detail-meta-term");
      dt.textContent = term;
      const dd = el("dd", "mm-workshop-detail-meta-def");
      dd.textContent = def;
      metaList.appendChild(dt);
      metaList.appendChild(dd);
    };
    addMetaRow("Version", `v${m.version}`);
    addMetaRow("Size", formatWorkshopFileSize(m.fileSize));
    addMetaRow("Downloads", formatWorkshopDownloadCount(m.downloadCount));
    const whenMeta = formatWorkshopRelativeTime(m.createdAt);
    if (whenMeta.length > 0) {
      addMetaRow("Updated", whenMeta);
    }
    addMetaRow("Pack id", m.modId);
    sideCard.appendChild(metaList);

    const rateBlock = el("div", "mm-workshop-detail-rate");
    const rateLabel = el("span", "mm-workshop-detail-rate-label");
    rateLabel.textContent = "Your rating";
    const rateRow = el("div", "mm-workshop-stars");
    for (let s = 1; s <= 5; s++) {
      const star = el("button", "mm-workshop-star") as HTMLButtonElement;
      star.type = "button";
      star.textContent = "★";
      star.disabled = uid === null;
      star.title = uid === null ? "Sign in to rate" : `Rate ${s}`;
      star.addEventListener("click", () => {
        this.deps.bus.emit({
          type: "workshop:post-rating",
          recordId: m.id,
          stars: s,
        } satisfies GameEvent);
      });
      rateRow.appendChild(star);
    }
    rateBlock.appendChild(rateLabel);
    rateBlock.appendChild(rateRow);
    sideCard.appendChild(rateBlock);

    side.appendChild(sideCard);
    columns.appendChild(mainCol);
    columns.appendChild(side);
    page.appendChild(columns);
    wrap.appendChild(page);
    this.syncWorkshopModUi(m.modId);
  }

  private commentRow(c: import("../../mods/workshopTypes").ModComment): HTMLElement {
    const row = el("div", "mm-workshop-comment");
    const head = el("div", "mm-workshop-comment-head");
    head.textContent = `${c.authorName} · ${c.createdAt}`;
    const body = el("div", "mm-workshop-comment-body");
    body.textContent = c.body;
    row.appendChild(head);
    row.appendChild(body);
    return row;
  }

  private renderCommentList(
    comments: readonly import("../../mods/workshopTypes").ModComment[],
  ): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    const list = wrap.querySelector("[data-role='comment-list']");
    if (list === null) {
      return;
    }
    list.replaceChildren();
    for (const c of comments) {
      list.appendChild(this.commentRow(c));
    }
    const countEl = wrap.querySelector("[data-role='comment-count']");
    if (countEl !== null) {
      countEl.textContent = `(${comments.length})`;
    }
  }

  private libraryPackRow(
    c: CachedMod,
    sectionModType: WorkshopModTypeRow,
  ): HTMLElement {
    const displayName = c.manifest.name?.trim() || c.modId;
    const row = el("div", "mm-bedrock-pack-row mm-workshop-library-pack-row");
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-label", `Workshop details: ${displayName}`);

    const openDetail = (): void => {
      this.deps.bus.emit({
        type: "workshop:open-detail",
        recordId: c.recordId,
      } satisfies GameEvent);
    };
    row.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("button")) {
        return;
      }
      openDetail();
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openDetail();
      }
    });

    const iconWrap = el("div", "mm-workshop-library-pack-icon-wrap");
    const png = findPackPngBytes(c.files);
    if (png !== undefined) {
      const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      this.libraryBlobUrls.push(url);
      const img = el("img", "mm-workshop-library-pack-icon") as HTMLImageElement;
      img.alt = "";
      img.src = url;
      iconWrap.appendChild(img);
    } else {
      const ph = el("div", "mm-workshop-library-pack-icon-ph");
      ph.setAttribute("aria-hidden", "true");
      iconWrap.appendChild(ph);
    }

    const textCol = el("div", "mm-workshop-library-pack-text");
    const titleRow = el("div", "mm-workshop-library-pack-title-row");
    const nameEl = el("span", "mm-bedrock-pack-row-label mm-workshop-library-pack-name");
    nameEl.textContent = displayName;
    titleRow.appendChild(nameEl);
    const badge = el("span", `mm-workshop-badge mm-workshop-badge-${sectionModType}`);
    badge.textContent = workshopModTypeBadgeLabel(sectionModType);
    titleRow.appendChild(badge);
    textCol.appendChild(titleRow);

    const meta = el("div", "mm-workshop-library-pack-meta");
    meta.textContent = `${c.modId} · v${c.version}`;
    textCol.appendChild(meta);

    const descRaw = truncateLibraryDescription(c.manifest.description ?? "", 140);
    if (descRaw.length > 0) {
      const desc = el("p", "mm-workshop-library-pack-desc");
      desc.textContent = descRaw;
      textCol.appendChild(desc);
    }

    const aside = el("div", "mm-workshop-library-pack-aside");
    const up = this.libraryUpdateByModId.get(c.modId);
    if (up !== undefined && semverGt(up.latestVersion, c.version)) {
      const upd = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
      upd.type = "button";
      upd.classList.add("mm-workshop-library-action-btn");
      this.applyInstallButtonShell(upd, c.modId, "install-update");
      upd.dataset.workshopIdleLabel = `Update → v${up.latestVersion}`;
      upd.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (upd.disabled || this.installingModIds.has(c.modId)) {
          return;
        }
        this.installingModIds.add(c.modId);
        this.syncWorkshopModUi(c.modId);
        this.deps.bus.emit({
          type: "workshop:install-record-requested",
          recordId: up.latestRecordId,
        } satisfies GameEvent);
      });
      aside.appendChild(upd);
    }
    const un = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    un.type = "button";
    un.classList.add("mm-workshop-library-action-btn");
    this.applyUninstallButtonShell(un, c.modId);
    un.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (un.disabled || this.uninstallingModIds.has(c.modId)) {
        return;
      }
      this.uninstallingModIds.add(c.modId);
      this.syncWorkshopModUi(c.modId);
      this.deps.bus.emit({
        type: "workshop:uninstall-requested",
        modId: c.modId,
        version: c.version,
      } satisfies GameEvent);
    });
    aside.appendChild(un);

    row.appendChild(iconWrap);
    row.appendChild(textCol);
    row.appendChild(aside);
    return row;
  }

  private renderLibrary(): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    for (const u of this.libraryBlobUrls) {
      URL.revokeObjectURL(u);
    }
    this.libraryBlobUrls.length = 0;

    this.detailModId = null;
    this.clearWorkshopActionFeedback();
    this.setModDetailChrome(false);
    wrap.replaceChildren();

    const intro = el("div", "mm-workshop-library-intro");
    const lead = el("p", "mm-bedrock-panel-desc mm-workshop-library-lead");
    lead.textContent =
      "Packs installed on this device. Same library as Edit World → Available — click a row for workshop details.";
    intro.appendChild(lead);
    const tips = el("ul", "mm-workshop-library-tips");
    const tipWorld = el("li");
    tipWorld.textContent = "Worlds: Solo → Edit World → add behavior or resource packs.";
    tips.appendChild(tipWorld);
    const tipTex = el("li");
    tipTex.textContent = "Global textures: Settings → Texture packs.";
    tips.appendChild(tipTex);
    intro.appendChild(tips);
    wrap.appendChild(intro);

    const toolRow = el("div", "mm-workshop-library-toolbar");
    const checkBtn = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    checkBtn.type = "button";
    checkBtn.textContent = "Check for updates";
    checkBtn.addEventListener("click", () => {
      checkBtn.disabled = true;
      this.deps.bus.emit({
        type: "workshop:library-request-updates",
      } satisfies GameEvent);
      window.setTimeout(() => {
        checkBtn.disabled = false;
      }, 2500);
    });
    toolRow.appendChild(checkBtn);
    wrap.appendChild(toolRow);

    const stacks = el("div", "mm-pack-dual-stack mm-workshop-library-stacks");
    wrap.appendChild(stacks);

    const installed = this.deps.getInstalledPacks();
    const behaviors = installed.filter((c) => c.manifest.mod_type === "behavior_pack");
    const resources = installed.filter((c) => c.manifest.mod_type === "resource_pack");

    const addSection = (
      title: string,
      list: readonly CachedMod[],
      sectionModType: WorkshopModTypeRow,
    ): void => {
      const block = el("div", "mm-pack-stack-block");
      const h = el("h3", "mm-pack-stack-block-title");
      h.textContent = title;
      block.appendChild(h);

      const inner = el("div", "mm-pack-installed-inner mm-workshop-library-well");
      if (list.length === 0) {
        const empty = el("p", "mm-note");
        empty.textContent =
          "None installed. Browse Explore, or add packs to a world from Solo → Edit World.";
        inner.appendChild(empty);
      } else {
        for (const c of list) {
          inner.appendChild(this.libraryPackRow(c, sectionModType));
        }
      }
      block.appendChild(inner);
      stacks.appendChild(block);
    };

    addSection("Behavior packs", behaviors, "behavior_pack");
    addSection("Resource packs", resources, "resource_pack");

    for (const c of behaviors) {
      this.syncWorkshopModUi(c.modId);
    }
    for (const c of resources) {
      this.syncWorkshopModUi(c.modId);
    }

    this.updateSubnavHighlight();
  }

  private renderOwnedPlaceholder(): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    this.detailModId = null;
    this.clearWorkshopActionFeedback();
    this.setModDetailChrome(false);
    wrap.replaceChildren();
    const row = el("div", "mm-workshop-loading");
    row.appendChild(el("div", "mm-workshop-spinner"));
    const t = el("span");
    t.textContent = "Loading…";
    row.appendChild(t);
    wrap.appendChild(row);
    this.updateSubnavHighlight();
  }

  private renderOwnedList(records: readonly ModListEntry[]): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    this.detailModId = null;
    this.clearWorkshopActionFeedback();
    wrap.replaceChildren();
    const tbl = el("div", "mm-workshop-owned");
    for (const m of records) {
      const row = el("div", "mm-workshop-owned-row");
      const label = el("span", "mm-workshop-owned-label");
      const pub = m.isPublished === true;
      const strong = el("strong");
      strong.textContent = `${m.name} · v${m.version}`;
      label.appendChild(strong);
      label.appendChild(document.createTextNode(pub ? " · Published" : " · Draft"));
      row.appendChild(label);
      const toggle = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
      toggle.type = "button";
      toggle.textContent = pub ? "Unpublish" : "Publish";
      toggle.addEventListener("click", () => {
        this.deps.bus.emit({
          type: "workshop:set-published-requested",
          recordId: m.id,
          isPublished: !pub,
        } satisfies GameEvent);
      });
      const del = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        this.deps.bus.emit({
          type: "workshop:delete-requested",
          recordId: m.id,
        } satisfies GameEvent);
      });
      const ownedAside = el("div", "mm-workshop-owned-aside");
      ownedAside.appendChild(toggle);
      ownedAside.appendChild(del);
      row.appendChild(ownedAside);
      tbl.appendChild(row);
    }
    wrap.appendChild(tbl);
    this.updateSubnavHighlight();
  }

  private renderUploadForm(clearMsg = false): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    this.detailModId = null;
    this.clearWorkshopActionFeedback();
    this.setModDetailChrome(false);
    wrap.replaceChildren();
    if (this.deps.getUserId() === null) {
      const note = el("p", "mm-note");
      note.textContent =
        "Sign in from the Profile tab to publish mods to the workshop.";
      wrap.appendChild(note);
      this.updateSubnavHighlight();
      return;
    }

    let mode: "pack" | "world" = "pack";
    let zipBytes: Uint8Array | null = null;
    let coverBytes: Uint8Array | null = null;
    let manifestName = "";
    let manifestId = "";
    let manifestVersion = "";
    let manifestType = "";

    let worldJsonBytes: Uint8Array | null = null;
    let worldSuggestedName = "";
    let worldSuggestedDescription = "";

    const stack = el("div", "mm-workshop-upload-stack");
    const steps = el("p", "mm-workshop-upload-steps");
    steps.textContent = "1. File · 2. Cover · 3. Publish";
    stack.appendChild(steps);
    const hint = el("p", "mm-note");
    hint.textContent = "Packs: .zip with manifest.json. Worlds: .stratum-world.json. Cover required.";
    stack.appendChild(hint);

    const modeRow = el("div", "mm-workshop-file-row");
    const modePack = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    modePack.type = "button";
    modePack.textContent = "Upload pack";
    const modeWorld = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    modeWorld.type = "button";
    modeWorld.textContent = "Upload world";
    const modeNote = el("span", "mm-workshop-filename");
    modeNote.textContent = "Choose what you're publishing";
    modeRow.appendChild(modePack);
    modeRow.appendChild(modeWorld);
    modeRow.appendChild(modeNote);
    stack.appendChild(this.makeField("Type", modeRow));

    const zipLabel = el("span", "mm-workshop-filename");
    zipLabel.textContent = "No file chosen";

    const zipInput = el("input", "mm-workshop-file-native") as HTMLInputElement;
    zipInput.type = "file";
    zipInput.accept = ".zip,application/zip";
    const zipPick = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    zipPick.type = "button";
    zipPick.textContent = "Choose .zip";
    zipPick.addEventListener("click", () => {
      zipInput.click();
    });
    const zipRow = el("div", "mm-workshop-file-row");
    zipRow.appendChild(zipInput);
    zipRow.appendChild(zipPick);
    zipRow.appendChild(zipLabel);
    const zipField = this.makeField("Workshop package", zipRow);
    stack.appendChild(zipField);

    const worldLabel = el("span", "mm-workshop-filename");
    worldLabel.textContent = "No file chosen";
    const worldInput = el("input", "mm-workshop-file-native") as HTMLInputElement;
    worldInput.type = "file";
    worldInput.accept = ".json,.gz,application/json,application/gzip,application/octet-stream";
    const worldPick = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    worldPick.type = "button";
    worldPick.textContent = "Choose .stratum-world.json";
    worldPick.addEventListener("click", () => {
      worldInput.click();
    });
    const worldRow = el("div", "mm-workshop-file-row");
    worldRow.appendChild(worldInput);
    worldRow.appendChild(worldPick);
    worldRow.appendChild(worldLabel);
    const worldField = this.makeField("World export", worldRow);
    stack.appendChild(worldField);

    const nameInp = el("input") as HTMLInputElement;
    nameInp.type = "text";
    nameInp.maxLength = 64;
    stack.appendChild(this.makeField("Display name", nameInp));

    const descInp = el("textarea") as HTMLTextAreaElement;
    descInp.rows = 4;
    descInp.maxLength = 500;
    stack.appendChild(this.makeField("Description", descInp));

    const idDisp = el("span", "mm-workshop-readonly-val");
    const verDisp = el("span", "mm-workshop-readonly-val");
    const typeDisp = el("span", "mm-workshop-readonly-val");
    stack.appendChild(this.makeField("Mod id", idDisp));
    stack.appendChild(this.makeField("Version", verDisp));
    stack.appendChild(this.makeField("Type", typeDisp));

    const covLabel = el("span", "mm-workshop-filename");
    covLabel.textContent = "Optional if pack.png is in the zip";

    const coverInput = el("input", "mm-workshop-file-native") as HTMLInputElement;
    coverInput.type = "file";
    coverInput.accept = "image/png,image/jpeg";
    const covPick = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    covPick.type = "button";
    covPick.textContent = "Choose image";
    covPick.addEventListener("click", () => {
      coverInput.click();
    });
    const covRow = el("div", "mm-workshop-file-row");
    covRow.appendChild(coverInput);
    covRow.appendChild(covPick);
    covRow.appendChild(covLabel);

    const preview = el("img", "mm-workshop-upload-preview") as HTMLImageElement;
    preview.alt = "";
    const previewWrap = el("div", "mm-workshop-upload-preview-wrap");
    previewWrap.appendChild(preview);

    stack.appendChild(this.makeField("Cover image", covRow));
    stack.appendChild(previewWrap);

    const err = el("p", "mm-workshop-publish-err");
    if (clearMsg) {
      err.textContent = "";
    }

    const pub = el("button", "mm-btn") as HTMLButtonElement;
    pub.type = "button";
    pub.textContent = "Publish";
    const updatePublishEnabled = (): void => {
      pub.disabled =
        coverBytes === null ||
        (mode === "pack" ? zipBytes === null : worldJsonBytes === null);
    };
    pub.disabled = true;

    const setMode = (next: "pack" | "world"): void => {
      mode = next;
      modePack.classList.toggle("mm-workshop-tab-active", mode === "pack");
      modeWorld.classList.toggle("mm-workshop-tab-active", mode === "world");
      zipField.style.display = mode === "pack" ? "block" : "none";
      worldField.style.display = mode === "world" ? "block" : "none";
      idDisp.textContent = mode === "pack" ? manifestId : "";
      verDisp.textContent = mode === "pack" ? manifestVersion : "1.0.0";
      typeDisp.textContent = mode === "pack" ? manifestType : "world";
      if (mode === "world") {
        if (nameInp.value.trim().length === 0 && worldSuggestedName.length > 0) {
          nameInp.value = worldSuggestedName.slice(0, 64);
        }
        if (descInp.value.trim().length === 0 && worldSuggestedDescription.length > 0) {
          descInp.value = worldSuggestedDescription.slice(0, 500);
        }
      }
      updatePublishEnabled();
    };

    modePack.addEventListener("click", () => setMode("pack"));
    modeWorld.addEventListener("click", () => setMode("world"));

    zipInput.addEventListener("change", () => {
      const f = zipInput.files?.[0];
      if (f === undefined) {
        return;
      }
      zipLabel.textContent = f.name;
      err.textContent = "";
      void f
        .arrayBuffer()
        .then((buf) => {
          zipBytes = new Uint8Array(buf);
          try {
            const raw = unzipSync(zipBytes) as Record<string, Uint8Array>;
            const norm: Record<string, Uint8Array> = {};
            for (const [k, v] of Object.entries(raw)) {
              norm[k.replace(/\\/g, "/").replace(/^\//, "")] = v;
            }
            const parsed = readWorkshopManifestFromZipFiles(norm);
            manifestName = parsed.name;
            manifestId = parsed.id;
            manifestVersion = parsed.version;
            manifestType = parsed.mod_type;
            nameInp.value = manifestName;
            idDisp.textContent = manifestId;
            verDisp.textContent = manifestVersion;
            typeDisp.textContent =
              manifestType === "behavior_pack"
                ? "behavior_pack (blocks, items, recipes, loot)"
                : manifestType === "resource_pack"
                  ? "resource_pack (textures)"
                  : manifestType;
            const png = norm["pack.png"];
            if (png !== undefined) {
              coverBytes = png;
              covLabel.textContent = "Using pack.png from zip";
              preview.src = URL.createObjectURL(
                new Blob([png], { type: "image/png" }),
              );
            }
            updatePublishEnabled();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            err.textContent = msg;
          }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          err.textContent = msg;
        });
    });

    worldInput.addEventListener("change", () => {
      const f = worldInput.files?.[0];
      if (f === undefined) {
        return;
      }
      worldLabel.textContent = f.name;
      err.textContent = "";
      void f
        .arrayBuffer()
        .then((buf) => {
          const pickedBytes = new Uint8Array(buf);
          const jsonBytes = isGzipBytes(pickedBytes) ? gunzipSync(pickedBytes) : pickedBytes;
          worldJsonBytes = pickedBytes;
          const text = new TextDecoder().decode(jsonBytes);
          let parsed: any;
          try {
            parsed = parseJsoncText(text, "uploaded world json") as any;
          } catch {
            throw new Error("World JSON is invalid.");
          }
          const meta = parsed?.metadata;
          worldSuggestedName = String(meta?.name ?? "").trim();
          worldSuggestedDescription = String(meta?.description ?? "").trim();
          if (nameInp.value.trim().length === 0 && worldSuggestedName.length > 0) {
            nameInp.value = worldSuggestedName.slice(0, 64);
          }
          if (descInp.value.trim().length === 0 && worldSuggestedDescription.length > 0) {
            descInp.value = worldSuggestedDescription.slice(0, 500);
          }
          const shot = String(meta?.previewImageDataUrl ?? "");
          const bytes = shot.length > 0 ? dataUrlToBytes(shot) : new Uint8Array();
          if (bytes.length > 0) {
            coverBytes = bytes;
            covLabel.textContent = "Using world photo from export";
            preview.src = shot;
          }
          updatePublishEnabled();
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          err.textContent = msg;
        });
    });

    coverInput.addEventListener("change", () => {
      const f = coverInput.files?.[0];
      if (f === undefined) {
        return;
      }
      covLabel.textContent = f.name;
      err.textContent = "";
      void f
        .arrayBuffer()
        .then((buf) => {
          coverBytes = new Uint8Array(buf);
          preview.src = URL.createObjectURL(f);
          updatePublishEnabled();
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          err.textContent = msg;
        });
    });

    pub.addEventListener("click", () => {
      err.textContent = "";
      if (coverBytes === null) {
        return;
      }
      if (mode === "pack") {
        if (zipBytes === null) {
          return;
        }
        this.deps.bus.emit({
          type: "workshop:publish-requested",
          zipBytes,
          coverBytes,
          displayName: nameInp.value.trim() || manifestName,
        } satisfies GameEvent);
      } else {
        if (worldJsonBytes === null) {
          return;
        }
        this.deps.bus.emit({
          type: "workshop:publish-world-requested",
          worldJsonBytes,
          coverBytes,
          displayName: nameInp.value.trim() || worldSuggestedName || "World",
          description: descInp.value.trim() || worldSuggestedDescription,
        } satisfies GameEvent);
      }
    });

    stack.appendChild(err);
    stack.appendChild(pub);
    wrap.appendChild(stack);
    this.updateSubnavHighlight();

    // Default to pack upload; hide world inputs.
    setMode("pack");
  }

  private renderTemplates(): void {
    const wrap = this.exploreWrap;
    if (wrap === null) {
      return;
    }
    this.detailModId = null;
    this.clearWorkshopActionFeedback();
    this.setModDetailChrome(false);
    wrap.replaceChildren();

    const stack = el("div", "mm-workshop-upload-stack");
    const lead = el("p", "mm-note");
    lead.textContent =
      "Templates are built-in packs you can download, edit, and reload (for dev mode / packaging).";
    stack.appendChild(lead);

    const err = el("p", "mm-workshop-publish-err");
    err.textContent = "";

    const devStatus = el("div", "mm-workshop-owned-row");
    devStatus.style.display = "block";
    devStatus.style.padding = "12px";
    devStatus.style.borderRadius = "10px";
    devStatus.style.background = "rgba(255,255,255,0.03)";
    devStatus.style.border = "1px solid rgba(255,255,255,0.10)";
    devStatus.style.marginBottom = "14px";
    const devStateRow = el("div");
    devStateRow.style.display = "flex";
    devStateRow.style.alignItems = "center";
    devStateRow.style.gap = "8px";
    const devStateTitle = el("strong");
    devStateTitle.textContent = "Developer folder";
    const devStatePill = el("span");
    devStatePill.style.display = "inline-flex";
    devStatePill.style.alignItems = "center";
    devStatePill.style.padding = "2px 8px";
    devStatePill.style.borderRadius = "999px";
    devStatePill.style.fontSize = "12px";
    devStatePill.style.letterSpacing = "0.04em";
    devStatePill.style.textTransform = "uppercase";
    if (this.devFolderState === "ready") {
      devStatePill.textContent = "ready";
      devStatePill.style.background = "rgba(83,183,106,0.20)";
      devStatePill.style.border = "1px solid rgba(83,183,106,0.45)";
      devStatePill.style.color = "#b7f0c5";
    } else if (this.devFolderState === "syncing") {
      devStatePill.textContent = "syncing";
      devStatePill.style.background = "rgba(255,189,89,0.20)";
      devStatePill.style.border = "1px solid rgba(255,189,89,0.45)";
      devStatePill.style.color = "#ffe3a8";
    } else if (this.devFolderState === "error") {
      devStatePill.textContent = "error";
      devStatePill.style.background = "rgba(220,89,89,0.20)";
      devStatePill.style.border = "1px solid rgba(220,89,89,0.45)";
      devStatePill.style.color = "#ffc5c5";
    } else {
      devStatePill.textContent = "not set";
      devStatePill.style.background = "rgba(160,170,190,0.18)";
      devStatePill.style.border = "1px solid rgba(160,170,190,0.35)";
      devStatePill.style.color = "#d7deec";
    }
    devStateRow.appendChild(devStateTitle);
    devStateRow.appendChild(devStatePill);
    devStatus.appendChild(devStateRow);
    const devPath = el("p", "mm-note");
    devPath.style.margin = "8px 0 4px";
    devPath.textContent =
      this.devFolderDisplayPath !== null
        ? `Path: ${this.devFolderDisplayPath}`
        : "Path: (none selected)";
    devStatus.appendChild(devPath);
    const devMeta = el("p", "mm-note");
    devMeta.style.margin = "0";
    if (this.devFolderState === "ready") {
      devMeta.textContent = `Loaded packs: ${this.devFolderPackCount}`;
    } else if (this.devFolderState === "error") {
      devMeta.textContent = this.devFolderError ?? "Developer folder sync failed.";
    } else {
      devMeta.textContent = "Choose a folder to enable local dev packs.";
    }
    devStatus.appendChild(devMeta);
    stack.appendChild(devStatus);

    const mkRow = (
      title: string,
      desc: string,
      actionLabel: string,
      onClick: (btn: HTMLButtonElement) => void,
    ): HTMLElement => {
      const row = el("div", "mm-workshop-owned-row");
      const label = el("span", "mm-workshop-owned-label");
      const strong = el("strong");
      strong.textContent = title;
      label.appendChild(strong);
      const d = el("div");
      d.style.fontFamily = "'M5x7', monospace";
      d.style.fontSize = "18px";
      d.style.color = "#8e8e93";
      d.style.marginTop = "6px";
      d.textContent = desc;
      label.appendChild(d);
      row.appendChild(label);
      const btn = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
      btn.type = "button";
      btn.textContent = actionLabel;
      btn.addEventListener("click", () => onClick(btn));
      const aside = el("div", "mm-workshop-owned-aside");
      aside.appendChild(btn);
      row.appendChild(aside);
      return row;
    };

    const base = import.meta.env.BASE_URL;

    stack.appendChild(
      mkRow(
        "Stratum core behavior pack",
        "Blocks, items, recipes, loot, smelting (internal pack format).",
        "Download .zip",
        (btn) => {
          void (async () => {
            try {
              btn.disabled = true;
              err.textContent = "";
              const packBase = `${base}${STRATUM_CORE_BEHAVIOR_PACK_PATH}`;
              const manifest = (await fetchJson(`${packBase}manifest.json`)) as any;
              const files: Record<string, Uint8Array> = {};
              files["manifest.json"] = new TextEncoder().encode(
                JSON.stringify(manifest, null, 2),
              );
              const listedBlocks: string[] = Array.isArray(manifest.blocks) ? manifest.blocks : [];
              const listedItems: string[] = Array.isArray(manifest.items) ? manifest.items : [];
              const listedRecipes: string[] = Array.isArray(manifest.recipes) ? manifest.recipes : [];
              const listedLoot: string[] = Array.isArray(manifest.loot) ? manifest.loot : [];
              const listedSmelting: string[] = Array.isArray(manifest.smelting) ? manifest.smelting : [];
              const listedFuel: string[] = Array.isArray(manifest.furnace_fuel)
                ? manifest.furnace_fuel
                : [];
              const listedFeatures: string[] = Array.isArray(manifest.features) ? manifest.features : [];
              const listedStructures: string[] = Array.isArray(manifest.structures)
                ? manifest.structures
                : [];
              const listedAll = [
                ...listedRecipes,
                ...listedLoot,
                ...listedSmelting,
                ...listedFuel,
                ...listedFeatures,
                ...listedStructures,
                ...listedBlocks.map((f) => `blocks/${f}`),
                ...listedItems.map((f) => `items/${f}`),
              ];
              const discoveredAll = discoverCorePackPaths(templateBehaviorPackJsonFiles).filter((p) =>
                p.startsWith("assets/mods/behavior_packs/stratum-core/"),
              );
              const relPaths =
                listedAll.length > 0
                  ? [...new Set(listedAll)].sort((a, b) => a.localeCompare(b))
                  : discoveredAll.map((p) =>
                      p.slice("assets/mods/behavior_packs/stratum-core/".length),
                    );
              const jobs: Array<{ rel: string; zipPath: string }> = relPaths.map((rel) => ({
                rel,
                zipPath: rel,
              }));

              const fetched = await Promise.all(
                jobs.map(async (j) => ({ zipPath: j.zipPath, bytes: await fetchBytes(`${packBase}${j.rel}`) })),
              );
              for (const f of fetched) {
                files[f.zipPath] = f.bytes;
              }

              const zip = zipSync(files, { level: 9 });
              const name = safeZipName(String(manifest.name ?? "stratum-core-behavior"));
              triggerBytesDownload(`${name}.zip`, zip, "application/zip");
            } catch (e) {
              err.textContent = e instanceof Error ? e.message : String(e);
            } finally {
              btn.disabled = false;
            }
          })();
        },
      ),
    );

    stack.appendChild(
      mkRow(
        "Stratum core resource pack",
        "Block + item texture manifests, referenced PNGs, and sounds (internal pack format).",
        "Download .zip",
        (btn) => {
          void (async () => {
            try {
              btn.disabled = true;
              err.textContent = "";
              const packBase = `${base}${STRATUM_CORE_RESOURCE_PACK_PATH}`;
              const manifest = (await fetchJson(`${packBase}manifest.json`)) as any;

              const files: Record<string, Uint8Array> = {};
              files["manifest.json"] = new TextEncoder().encode(
                JSON.stringify(manifest, null, 2),
              );

              // Include and rewrite texture manifests to use relative paths inside the pack.
              const blockManifestUrl = `${base}${BLOCK_TEXTURE_MANIFEST_PATH}`;
              const itemManifestUrl = `${base}${ITEM_TEXTURE_MANIFEST_PATH}`;
              const blockDoc = (await fetchJson(blockManifestUrl)) as any;
              const itemDoc = (await fetchJson(itemManifestUrl)) as any;

              const rewrite = (doc: any): any => {
                const out = { ...doc, textures: { ...(doc?.textures ?? {}) } };
                for (const [k, v] of Object.entries(out.textures)) {
                  if (typeof v !== "string") continue;
                  const marker = "assets/mods/resource_packs/stratum-core/";
                  const i = v.indexOf(marker);
                  out.textures[k] = i >= 0 ? v.slice(i + marker.length) : v.replace(/^\/+/, "");
                }
                return out;
              };

              const blockRewritten = rewrite(blockDoc);
              const itemRewritten = rewrite(itemDoc);
              files["textures/block_texture_manifest.json"] = new TextEncoder().encode(
                JSON.stringify(blockRewritten, null, 2),
              );
              files["textures/item_texture_manifest.json"] = new TextEncoder().encode(
                JSON.stringify(itemRewritten, null, 2),
              );

              const texPaths = new Set<string>();
              for (const v of Object.values(blockRewritten.textures ?? {})) {
                if (typeof v === "string" && v.length > 0) texPaths.add(v);
              }
              for (const v of Object.values(itemRewritten.textures ?? {})) {
                if (typeof v === "string" && v.length > 0) texPaths.add(v);
              }

              // Sounds.
              const soundManifestRel = "sounds/sound_manifest.json";
              const soundDoc = (await fetchJson(`${packBase}${soundManifestRel}`)) as any;
              files[soundManifestRel] = new TextEncoder().encode(JSON.stringify(soundDoc, null, 2));
              const soundPaths = new Set<string>();
              const walk = (x: any): void => {
                if (typeof x === "string") {
                  if (x.endsWith(".ogg")) soundPaths.add(x.replace(/^\/+/, ""));
                  return;
                }
                if (Array.isArray(x)) {
                  for (const v of x) walk(v);
                  return;
                }
                if (x !== null && typeof x === "object") {
                  for (const v of Object.values(x)) walk(v);
                }
              };
              walk(soundDoc);

              const jobs: Array<{ url: string; zipPath: string }> = [];
              for (const rel of texPaths) {
                jobs.push({ url: `${packBase}${rel}`, zipPath: rel });
              }
              for (const rel of soundPaths) {
                jobs.push({ url: `${packBase}${rel}`, zipPath: rel });
              }

              const fetched = await Promise.all(
                jobs.map(async (j) => ({ zipPath: j.zipPath, bytes: await fetchBytes(j.url) })),
              );
              for (const f of fetched) {
                files[f.zipPath] = f.bytes;
              }

              const zip = zipSync(files, { level: 9 });
              const name = safeZipName(String(manifest.name ?? "stratum-core-resource"));
              triggerBytesDownload(`${name}.zip`, zip, "application/zip");
            } catch (e) {
              err.textContent = e instanceof Error ? e.message : String(e);
            } finally {
              btn.disabled = false;
            }
          })();
        },
      ),
    );

    const devBlock = el("div", "mm-workshop-owned-row");
    const devLabel = el("span", "mm-workshop-owned-label");
    const devStrong = el("strong");
    devStrong.textContent = "Developer mode (local folder)";
    devLabel.appendChild(devStrong);
    const devDesc = el("div");
    devDesc.style.fontFamily = "'M5x7', monospace";
    devDesc.style.fontSize = "18px";
    devDesc.style.color = "#8e8e93";
    devDesc.style.marginTop = "6px";
    devDesc.textContent =
      "Pick a folder containing workshop .zip packs and/or unpacked pack folders. Refresh to sync live edits.";
    devLabel.appendChild(devDesc);
    devBlock.appendChild(devLabel);
    const devAside = el("div", "mm-workshop-owned-aside");
    const pick = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    pick.type = "button";
    pick.textContent = "Choose folder";
    const folderFallbackInput = el("input", "mm-workshop-file-native") as HTMLInputElement;
    folderFallbackInput.type = "file";
    folderFallbackInput.hidden = true;
    // Chromium fallback when showDirectoryPicker is unavailable.
    (
      folderFallbackInput as HTMLInputElement & {
        webkitdirectory?: boolean;
        directory?: boolean;
      }
    ).webkitdirectory = true;
    (
      folderFallbackInput as HTMLInputElement & {
        webkitdirectory?: boolean;
        directory?: boolean;
      }
    ).directory = true;
    folderFallbackInput.addEventListener("change", () => {
      const selected = folderFallbackInput.files;
      const selectedFiles = selected !== null ? Array.from(selected) : [];
      if (selectedFiles.length > 0) {
        const firstRel =
          (selectedFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
        const root = firstRel.split("/")[0] ?? "";
        this.devFolderDisplayPath = root.length > 0 ? root : selectedFiles[0]!.name;
        this.devFolderState = "syncing";
        this.devFolderError = null;
        this.renderTemplates();
      }
      // #region agent log
      fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run2",hypothesisId:"H5",location:"WorkshopScreen.ts:folderFallbackInput:change",message:"folder fallback changed",data:{selectedCount:selectedFiles.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      folderFallbackInput.value = "";
      if (selectedFiles.length === 0) {
        // #region agent log
        fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run4",hypothesisId:"H6",location:"WorkshopScreen.ts:folderFallbackInput:emptyAfterSnapshot",message:"no files in snapshot",data:{},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return;
      }
      void (async () => {
        try {
          err.textContent = "";
          const out: Array<{ name: string; relativePath: string; bytes: Uint8Array }> = [];
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run3",hypothesisId:"H6",location:"WorkshopScreen.ts:folderFallbackInput:read:start",message:"starting fallback file reads",data:{selectedCount:selectedFiles.length},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          for (let i = 0; i < selectedFiles.length; i++) {
            const f = selectedFiles[i]!;
            const rel =
              (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
            out.push({
              name: f.name,
              relativePath: rel,
              bytes: new Uint8Array(await f.arrayBuffer()),
            });
            if (i === 0 || i === selectedFiles.length - 1 || (i + 1) % 50 === 0) {
              // #region agent log
              fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run3",hypothesisId:"H6",location:"WorkshopScreen.ts:folderFallbackInput:read:progress",message:"fallback read progress",data:{readCount:i+1,total:selectedFiles.length,lastPath:rel},timestamp:Date.now()})}).catch(()=>{});
              // #endregion
            }
          }
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run3",hypothesisId:"H6",location:"WorkshopScreen.ts:folderFallbackInput:read:done",message:"finished fallback file reads",data:{outCount:out.length},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          this.deps.bus.emit({
            type: "workshop:dev-folder-files-picked",
            files: out,
          } satisfies GameEvent);
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run2",hypothesisId:"H5",location:"WorkshopScreen.ts:emit:dev-folder-files-picked",message:"emitted folder files event",data:{fileCount:out.length,sample:out.slice(0,3).map((f)=>f.relativePath)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          this.showWorkshopActionFeedback("Folder selected. Loading dev packs…");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run2",hypothesisId:"H5",location:"WorkshopScreen.ts:folderFallbackInput:error",message:"folder fallback read failed",data:{error:msg},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          err.textContent = msg;
        }
      })();
    });
    pick.addEventListener("click", () => {
      void (async () => {
        try {
          err.textContent = "";
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run2",hypothesisId:"H5",location:"WorkshopScreen.ts:pick:click",message:"choose folder clicked",data:{hasShowDirectoryPicker:typeof (window as any).showDirectoryPicker==="function"},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          if (typeof (window as any).showDirectoryPicker !== "function") {
            folderFallbackInput.click();
            return;
          }
          // @ts-expect-error showDirectoryPicker is not in all DOM lib targets
          const h = (await window.showDirectoryPicker()) as FileSystemDirectoryHandle;
          this.devFolderDisplayPath = h.name;
          this.devFolderState = "syncing";
          this.devFolderError = null;
          this.renderTemplates();
          this.deps.bus.emit({
            type: "workshop:dev-folder-picked",
            handle: h,
          } satisfies GameEvent);
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run2",hypothesisId:"H5",location:"WorkshopScreen.ts:emit:dev-folder-picked",message:"emitted folder handle event",data:{handleName:h?.name??null},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          this.showWorkshopActionFeedback("Folder selected. Reloading dev packs…");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // #region agent log
          fetch("http://127.0.0.1:7275/ingest/727e9e1b-a01c-4093-b975-7544742cff29",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"a009aa"},body:JSON.stringify({sessionId:"a009aa",runId:"run2",hypothesisId:"H5",location:"WorkshopScreen.ts:pick:error",message:"choose folder flow failed",data:{error:msg},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          err.textContent = msg;
        }
      })();
    });
    const clear = el("button", "mm-btn mm-btn-subtle") as HTMLButtonElement;
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      this.devFolderDisplayPath = null;
      this.devFolderState = "idle";
      this.devFolderPackCount = 0;
      this.devFolderError = null;
      this.deps.bus.emit({
        type: "workshop:dev-folder-picked",
        handle: null,
      } satisfies GameEvent);
      this.showWorkshopActionFeedback("Developer folder cleared.");
      this.renderTemplates();
    });
    devAside.appendChild(pick);
    devAside.appendChild(folderFallbackInput);
    devAside.appendChild(clear);
    devBlock.appendChild(devAside);
    stack.appendChild(devBlock);

    stack.appendChild(err);
    wrap.appendChild(stack);
    this.updateSubnavHighlight();
  }
}
