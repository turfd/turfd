/** Main-menu workshop UI: browse, detail, upload, owned mods (DOM + EventBus only). */

import { unzipSync } from "fflate";
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

  private subView: "explore" | "detail" | "upload" | "owned" | "library" = "explore";

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

  constructor(deps: WorkshopScreenDeps) {
    this.deps = deps;
  }

  private subnavKey(): "explore" | "owned" | "upload" | "library" {
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
    subNav.appendChild(btnExplore);
    subNav.appendChild(btnLibrary);
    subNav.appendChild(btnOwned);
    subNav.appendChild(btnUpload);
    this.root.appendChild(subNav);

    this.tabExplore = btnExplore;
    this.tabOwned = btnOwned;
    this.tabLibrary = btnLibrary;
    this.tabUpload = btnUpload;

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
    const stripRow = el("div", "mm-workshop-filter-strip-row");
    stripRow.setAttribute("role", "group");
    stripRow.setAttribute("aria-label", "Type and sort");

    const typePills = el("div", "mm-workshop-type-pills");
    const typeDefs: { v: ModTypeFilter; l: string }[] = [
      { v: "all", l: "All" },
      { v: "behavior_pack", l: "Behavior" },
      { v: "resource_pack", l: "Resource" },
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
    stripRow.appendChild(typePills);

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
    stripRow.appendChild(sortPills);
    filterStrip.appendChild(stripRow);

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
    filterStrip.appendChild(searchWrap);
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
      const list = el("div", "mm-workshop-list");
      for (const m of records) {
        list.appendChild(this.modRowCard(m));
      }
      host.appendChild(list);
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
    pager.appendChild(prev);
    pager.appendChild(next);
    host.appendChild(pager);
  }

  private modRowCard(m: ModListEntry): HTMLElement {
    const row = el("article", "mm-workshop-rowcard");
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-label", `${m.name} by ${m.authorName}`);

    const openDetail = (): void => {
      this.detailRecordId = m.id;
      this.deps.bus.emit({ type: "workshop:open-detail", recordId: m.id } satisfies GameEvent);
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

    const iconWrap = el("div", "mm-workshop-rowcard-icon");
    const img = el("img", "mm-workshop-rowcard-img") as HTMLImageElement;
    img.loading = "lazy";
    img.alt = "";
    if (m.coverPath.length > 0) {
      img.src = this.deps.getModPublicUrl(m.coverPath);
    }
    iconWrap.appendChild(img);

    const mid = el("div", "mm-workshop-rowcard-main");
    const titleRow = el("div", "mm-workshop-rowcard-title-row");
    const title = el("h3", "mm-workshop-rowcard-title");
    title.textContent = m.name;
    titleRow.appendChild(title);
    mid.appendChild(titleRow);

    const author = el("p", "mm-workshop-rowcard-author");
    author.textContent =
      m.authorName.length > 0 ? `by ${m.authorName}` : "by unknown";
    mid.appendChild(author);

    const tags = el("div", "mm-workshop-rowcard-tags");
    const badge = el("span", `mm-workshop-badge mm-workshop-badge-${m.modType}`);
    badge.textContent =
      m.modType === "behavior_pack"
        ? "Behavior"
        : m.modType === "resource_pack"
          ? "Resource"
          : m.modType;
    tags.appendChild(badge);
    mid.appendChild(tags);

    const aside = el("div", "mm-workshop-rowcard-aside");
    const meta = el("p", "mm-workshop-rowcard-meta");
    const metaText = formatWorkshopListMetaLine(m);
    meta.textContent = metaText;
    meta.title = metaText;
    aside.appendChild(meta);

    const install = el("button", "mm-btn mm-workshop-rowcard-install") as HTMLButtonElement;
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
    aside.appendChild(install);

    row.appendChild(iconWrap);
    row.appendChild(mid);
    row.appendChild(aside);
    return row;
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
    const banner = el("section", "mm-workshop-detail-banner");
    if (coverUrl.length > 0) {
      banner.classList.add("mm-workshop-detail-banner--has-cover");
      banner.style.backgroundImage = `url("${coverUrl}")`;
    }
    const scrim = el("div", "mm-workshop-detail-banner-scrim");
    const bannerInner = el("div", "mm-workshop-detail-banner-inner");
    const iconWrap = el("div", "mm-workshop-detail-banner-icon");
    if (coverUrl.length > 0) {
      const iconImg = el("img", "mm-workshop-detail-banner-icon-img") as HTMLImageElement;
      iconImg.alt = "";
      iconImg.src = coverUrl;
      iconWrap.appendChild(iconImg);
    } else {
      const ph = el("div", "mm-workshop-detail-banner-icon-ph");
      ph.setAttribute("aria-hidden", "true");
      iconWrap.appendChild(ph);
    }

    const bannerText = el("div", "mm-workshop-detail-banner-text");
    const h = el("h2", "mm-workshop-detail-name");
    h.textContent = m.name;
    const author = el("p", "mm-workshop-detail-author");
    author.textContent =
      m.authorName.length > 0 ? `by ${m.authorName}` : "by unknown";
    const bannerMeta = el("div", "mm-workshop-detail-banner-meta");
    const typeBadge = el("span", `mm-workshop-badge mm-workshop-badge-${m.modType}`);
    typeBadge.textContent = workshopModTypeBadgeLabel(m.modType);
    bannerMeta.appendChild(typeBadge);
    const rcBanner = m.ratingCount;
    const rateSummary = el("span", "mm-workshop-detail-banner-stat");
    rateSummary.textContent =
      rcBanner > 0
        ? `★ ${m.avgRating.toFixed(1)} · ${rcBanner} rating${rcBanner === 1 ? "" : "s"}`
        : "No ratings yet";
    bannerMeta.appendChild(rateSummary);
    const dlSummary = el("span", "mm-workshop-detail-banner-stat");
    dlSummary.textContent = `${formatWorkshopDownloadCount(m.downloadCount)} downloads`;
    bannerMeta.appendChild(dlSummary);
    bannerText.appendChild(h);
    bannerText.appendChild(author);
    bannerText.appendChild(bannerMeta);
    bannerInner.appendChild(iconWrap);
    bannerInner.appendChild(bannerText);
    banner.appendChild(scrim);
    banner.appendChild(bannerInner);
    page.appendChild(banner);

    const columns = el("div", "mm-workshop-detail-columns");
    const mainCol = el("div", "mm-workshop-detail-main");

    const aboutTitle = el("h3", "mm-workshop-detail-section-title");
    aboutTitle.textContent = "About";
    const desc = el("p", "mm-workshop-detail-desc");
    desc.textContent = m.description;
    mainCol.appendChild(aboutTitle);
    mainCol.appendChild(desc);

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
      ta.rows = 3;
      ta.placeholder = "Write a comment…";
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
    actions.appendChild(uninstall);
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
    const when = formatWorkshopRelativeTime(m.createdAt);
    if (when.length > 0) {
      addMetaRow("Updated", when);
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

    let zipBytes: Uint8Array | null = null;
    let coverBytes: Uint8Array | null = null;
    let manifestName = "";
    let manifestId = "";
    let manifestVersion = "";
    let manifestType = "";

    const stack = el("div", "mm-workshop-upload-stack");
    const steps = el("p", "mm-workshop-upload-steps");
    steps.textContent = "1. Package · 2. Cover · 3. Publish";
    stack.appendChild(steps);
    const hint = el("p", "mm-note");
    hint.textContent = ".zip with manifest.json (max 2 MB). Cover required.";
    stack.appendChild(hint);

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
    stack.appendChild(this.makeField("Workshop package", zipRow));

    const nameInp = el("input") as HTMLInputElement;
    nameInp.type = "text";
    nameInp.maxLength = 64;
    stack.appendChild(this.makeField("Display name", nameInp));

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
      pub.disabled = zipBytes === null || coverBytes === null;
    };
    pub.disabled = true;

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
      if (zipBytes === null || coverBytes === null) {
        return;
      }
      err.textContent = "";
      this.deps.bus.emit({
        type: "workshop:publish-requested",
        zipBytes,
        coverBytes,
        displayName: nameInp.value.trim() || manifestName,
      } satisfies GameEvent);
    });

    stack.appendChild(err);
    stack.appendChild(pub);
    wrap.appendChild(stack);
    this.updateSubnavHighlight();
  }
}
