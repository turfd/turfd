/**
 * Stratum — application entry.
 */
import type { IAuthProvider } from "./auth/IAuthProvider";
import { createAuthProvider } from "./auth/createAuthProvider";
import { getOrCreateLocalGuestIdentity } from "./auth/localGuestIdentity";
import { loadLocalSecretsFile } from "./config/secretsLoader";
import { EventBus } from "./core/EventBus";
import { unixRandom01 } from "./core/unixRandom";
import { DEFAULT_SKIN_ID } from "./core/constants";
import {
  Game,
  type MultiplayerHostFromMenuSpec,
  type PlayerSavedState,
} from "./core/Game";
import { CrashReporter } from "./core/crash/CrashReporter";
import type { GameEvent, WorldGameMode, WorldGenType } from "./core/types";
import { normalizeWorldGameMode, normalizeWorldGenType } from "./core/types";
import { AudioEngine } from "./audio/AudioEngine";
import { OstPlaylistController } from "./audio/ostPlaylist";
import { readVolumeStored, VOL_KEYS } from "./audio/volumeSettings";
import { ModRepository } from "./mods/ModRepository";
import { STRATUM_CORE_RESOURCE_PACK_PATH } from "./mods/internalPackManifest";
import { asModRecordId } from "./mods/workshopTypes";
import {
  getLatestPublishedStratumModByModId,
  getStratumModJson,
  modDetailToListEntry,
} from "./network/workshopModApi";
import { semverGt } from "./util/semverGt";
import { createSupabaseSignalRelay } from "./network/SupabaseSignalAdapter";
import { IndexedDBStore } from "./persistence/IndexedDBStore";
import { pinWorkshopModToWorld } from "./persistence/pinWorkshopModToWorld";
import { mountEarlyMenuBackdrop } from "./ui/screens/menuSkyPaint";
import { MainMenu } from "./ui/screens/MainMenu";
import { MenuBackground } from "./ui/screens/MenuBackground";
import { runGameEntryBlackTransition } from "./ui/screens/gameEntryTransition";
import { WorldLoadingScreen } from "./ui/screens/WorldLoadingScreen";
import { getSkipIntro } from "./ui/settings/uiPrefs";
import { getVideoPrefs, setVideoPrefs } from "./ui/settings/videoPrefs";
import { installStaleClientGuard } from "./clientUpdateCheck";
import {
  formatStratumBuildLine,
  getStratumBuildInfo,
} from "./versionInfo";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "./styles/global.css";

/** Minimum time the loading overlay stays up (ms), so the bar and tips feel intentional. */
function randomLoadingHoldMs(): number {
  return 3000 + Math.floor(unixRandom01() * 1000);
}

function menuMusicFadeOutSec(): number {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.12 : 1.2;
}

function loadingErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") {
    const m = err.message;
    if (m.includes("PeerJSAdapter.join: connection timeout")) {
      return `${m} The host may have left, or the room listing may be out of date — try again in a minute or join with a fresh code.`;
    }
    return m;
  }
  return "An unknown error occurred while preparing the world.";
}

function mountStartupBootOverlay(): void {
  if (document.getElementById("stratum-startup-boot") !== null) {
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = "stratum-startup-boot";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:20000",
    "pointer-events:none",
    "background:#000",
    "display:flex",
    "align-items:center",
    "justify-content:center",
  ].join(";");
  const title = document.createElement("div");
  title.textContent = "Stratum Studios Presents...";
  title.style.cssText = [
    "font-family:'BoldPixels','Courier New',monospace",
    "font-size:clamp(18px, 2.3vw, 28px)",
    "letter-spacing:0.06em",
    "text-transform:uppercase",
    "color:rgba(255,255,255,0.92)",
    "text-shadow:0 2px 0 rgba(0,0,0,0.42), 0 0 10px rgba(0,0,0,0.2)",
    "opacity:0",
    "transition:opacity 420ms ease-out",
    "white-space:nowrap",
  ].join(";");
  const skipHint = document.createElement("div");
  skipHint.textContent = "Click or press Esc to skip";
  skipHint.style.cssText = [
    "position:fixed",
    "bottom:20px",
    "right:24px",
    "font-family:'BoldPixels','Courier New',monospace",
    "font-size:13px",
    "letter-spacing:0.08em",
    "text-transform:uppercase",
    "color:rgba(255,255,255,0.4)",
    "pointer-events:none",
    "user-select:none",
    "opacity:0",
    "transition:opacity 500ms ease-out 2000ms",
  ].join(";");
  overlay.appendChild(title);
  overlay.appendChild(skipHint);
  document.body.appendChild(overlay);

  const dismiss = (): void => {
    overlay.remove();
  };
  overlay.style.pointerEvents = "auto";
  overlay.style.cursor = "pointer";
  overlay.addEventListener("click", dismiss, { once: true });
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", escHandler);
      dismiss();
    }
  };
  document.addEventListener("keydown", escHandler);

  performance.mark("startup-boot-overlay-mounted");
  requestAnimationFrame(() => {
    title.style.opacity = "1";
    skipHint.style.opacity = "1";
    performance.mark("startup-boot-overlay-visible");
    performance.measure(
      "startup-boot-overlay-appear",
      "startup-boot-overlay-mounted",
      "startup-boot-overlay-visible",
    );
  });
}

function wireWorkshopHandlers(
  menuBus: EventBus,
  auth: IAuthProvider,
  store: IndexedDBStore,
  modRepo: ModRepository,
): void {
  menuBus.on("workshop:request-list", async (e) => {
    try {
      const r = await modRepo.list({
        offset: e.offset,
        modType: e.modType,
        sortBy: e.sortBy,
        query: e.query,
      });
      menuBus.emit({
        type: "workshop:list-result",
        records: r.records,
        offset: e.offset,
        hasMore: r.hasMore,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:open-detail", async (e) => {
    try {
      const d = await modRepo.getDetail(asModRecordId(e.recordId));
      menuBus.emit({
        type: "workshop:detail-result",
        record: d.record,
        comments: d.comments,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:install-requested", async (e) => {
    try {
      const client = auth.getSupabaseClient();
      if (client === null) {
        return;
      }
      const detail = await getStratumModJson(client, e.recordId);
      if (detail === null) {
        throw new Error("Mod not found.");
      }
      const entry = modDetailToListEntry(detail);
      await modRepo.install(entry);
      if (e.pinToWorldUuid !== undefined && e.pinToWorldUuid.length > 0) {
        await pinWorkshopModToWorld(store, e.pinToWorldUuid, entry, modRepo);
      }
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:install-record-requested", async (e) => {
    try {
      const client = auth.getSupabaseClient();
      if (client === null) {
        return;
      }
      const detail = await getStratumModJson(client, e.recordId);
      if (detail === null) {
        throw new Error("Mod not found.");
      }
      await modRepo.install(modDetailToListEntry(detail));
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:library-request-updates", async () => {
    const client = auth.getSupabaseClient();
    if (client === null) {
      menuBus.emit({ type: "workshop:library-updates-result", updates: [] } satisfies GameEvent);
      return;
    }
    try {
      const installed = modRepo.getInstalled();
      const seen = new Set<string>();
      const updates: {
        modId: string;
        latestRecordId: string;
        latestVersion: string;
        currentVersion: string;
      }[] = [];
      for (const c of installed) {
        if (seen.has(c.modId)) {
          continue;
        }
        seen.add(c.modId);
        const latest = await getLatestPublishedStratumModByModId(client, c.modId);
        if (
          latest !== null &&
          latest.id !== c.recordId &&
          semverGt(latest.version, c.version)
        ) {
          updates.push({
            modId: c.modId,
            latestRecordId: latest.id,
            latestVersion: latest.version,
            currentVersion: c.version,
          });
        }
      }
      menuBus.emit({
        type: "workshop:library-updates-result",
        updates,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:uninstall-requested", async (e) => {
    try {
      await modRepo.uninstall(e.modId);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:post-comment", async (e) => {
    const uid = auth.getSession()?.userId;
    if (uid === undefined) {
      return;
    }
    try {
      const comments = await modRepo.postComment(asModRecordId(e.recordId), e.body, uid);
      menuBus.emit({
        type: "workshop:comment-result",
        recordId: e.recordId,
        comments,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:post-rating", async (e) => {
    const uid = auth.getSession()?.userId;
    if (uid === undefined) {
      return;
    }
    try {
      await modRepo.postRating(asModRecordId(e.recordId), e.stars, uid);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:publish-requested", async (e) => {
    const uid = auth.getSession()?.userId;
    if (uid === undefined) {
      menuBus.emit({
        type: "workshop:publish-error",
        message: "Sign in to publish.",
      } satisfies GameEvent);
      return;
    }
    try {
      const rec = await modRepo.publish(e.zipBytes, e.coverBytes, e.displayName, uid);
      menuBus.emit({ type: "workshop:publish-result", record: rec } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:publish-error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:publish-world-requested", async (e) => {
    const uid = auth.getSession()?.userId;
    if (uid === undefined) {
      menuBus.emit({
        type: "workshop:publish-error",
        message: "Sign in to publish.",
      } satisfies GameEvent);
      return;
    }
    try {
      const rec = await modRepo.publishWorld(
        e.worldJsonBytes,
        e.coverBytes,
        e.displayName,
        e.description,
        uid,
      );
      menuBus.emit({ type: "workshop:publish-result", record: rec } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:publish-error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:request-owned", async () => {
    try {
      const records = await modRepo.listOwned();
      menuBus.emit({ type: "workshop:owned-result", records } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:delete-requested", async (e) => {
    try {
      await modRepo.deleteMod(asModRecordId(e.recordId));
      menuBus.emit({ type: "workshop:deleted", recordId: e.recordId } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:set-published-requested", async (e) => {
    try {
      await modRepo.setPublished(asModRecordId(e.recordId), e.isPublished);
      menuBus.emit({ type: "workshop:request-owned" } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:dev-folder-picked", async (e) => {
    try {
      await store.openDB();
      await modRepo.setDevFolder(e.handle);
      menuBus.emit({
        type: "workshop:dev-sync-ok",
        packCount: modRepo.getInstalled().length,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:dev-sync-error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });

  menuBus.on("workshop:dev-zips-picked", async (e) => {
    try {
      await store.openDB();
      await modRepo.importDevZipFiles(e.files);
      menuBus.emit({
        type: "workshop:dev-sync-ok",
        packCount: modRepo.getInstalled().length,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:dev-sync-error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });
  menuBus.on("workshop:dev-folder-files-picked", async (e) => {
    try {
      await store.openDB();
      await modRepo.importDevFolderFiles(e.files);
      menuBus.emit({
        type: "workshop:dev-sync-ok",
        packCount: modRepo.getInstalled().length,
      } satisfies GameEvent);
    } catch (err) {
      menuBus.emit({
        type: "workshop:dev-sync-error",
        message: loadingErrorMessage(err),
      } satisfies GameEvent);
    }
  });
}

async function main(): Promise<void> {
  const mount = document.getElementById("app");
  if (!mount) {
    throw new Error('Missing root element: expected <div id="app"></div>');
  }
  {
    const w = window as typeof window & {
      getVideoPrefs?: typeof getVideoPrefs;
      setVideoPrefs?: typeof setVideoPrefs;
      stratumBuild?: ReturnType<typeof getStratumBuildInfo>;
      /** DevTools: run `stratumPrintVersion()` for build id + wire range; reload if banner shows before MP. */
      stratumPrintVersion?: () => string;
    };
    w.stratumBuild = getStratumBuildInfo();
    w.stratumPrintVersion = (): string => {
      const line = formatStratumBuildLine();
      console.log(line);
      return line;
    };
    if (import.meta.env.DEV) {
      w.getVideoPrefs = getVideoPrefs;
      w.setVideoPrefs = setVideoPrefs;
    }
  }
  installStaleClientGuard();
  mountStartupBootOverlay();

  // ---------------------------------------------------------------------------
  // Entry routes (no router dependency; use BASE_URL-aware pathname parsing)
  // ---------------------------------------------------------------------------

  const getEntrySlug = (): string => {
    const base = import.meta.env.BASE_URL ?? "/";
    const basePath = base.endsWith("/") ? base : `${base}/`;
    let p = window.location.pathname;
    if (p.startsWith(basePath)) {
      p = p.slice(basePath.length);
    } else if (p.startsWith(base)) {
      p = p.slice(base.length);
    }
    p = p.replace(/^\/+/, "").replace(/\/+$/, "");
    return p;
  };

  if (getEntrySlug() === "background") {
    // Full-viewport, scroll-free render surface for capturing background art.
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    mount.style.position = "fixed";
    mount.style.inset = "0";
    mount.style.overflow = "hidden";
    mount.style.touchAction = "none";

    mount.replaceChildren();
    mountEarlyMenuBackdrop(mount);

    const params = new URLSearchParams(window.location.search);
    const blocksParam = params.get("blocks");
    const zoomParam = params.get("zoom");
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    const initialBlocks = blocksParam !== null && blocksParam.trim() !== ""
      ? clamp(Number.parseFloat(blocksParam), 8, 240)
      : 60;
    const initialMinZoom = zoomParam !== null && zoomParam.trim() !== ""
      ? clamp(Number.parseFloat(zoomParam), 0.25, 8)
      : 1;

    const bg = new MenuBackground({
      // More zoomed-out than default: more blocks along the shorter viewport edge.
      maxVisibleBlocksX: initialBlocks,
      // Allow zoom to go a bit smaller on narrow viewports.
      minZoom: initialMinZoom,
      // Capture mode should be static.
      disableMotion: true,
    });
    const onWheel = (e: WheelEvent): void => {
      // Zoom control for capture mode:
      // - wheel up: zoom in (fewer blocks visible)
      // - wheel down: zoom out (more blocks visible)
      e.preventDefault();
      const { maxVisibleBlocksX } = bg.getZoomConfig();
      const dir = e.deltaY > 0 ? 1 : -1;
      const step = e.shiftKey ? 10 : 2;
      bg.setZoomConfig({ maxVisibleBlocksX: clamp(maxVisibleBlocksX + dir * step, 8, 240) });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    const onZoomKeys = (e: KeyboardEvent): void => {
      // Quick keys: - / = also zoom.
      if (e.key !== "-" && e.key !== "=" && e.key !== "+" && e.key !== "_") return;
      e.preventDefault();
      const { maxVisibleBlocksX } = bg.getZoomConfig();
      const dir = e.key === "-" || e.key === "_" ? 1 : -1;
      const step = e.shiftKey ? 10 : 2;
      bg.setZoomConfig({ maxVisibleBlocksX: clamp(maxVisibleBlocksX + dir * step, 8, 240) });
    };
    window.addEventListener("keydown", onZoomKeys);

    // Pan (drag) + nudge keys for framing captures.
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      bg.panBy(dx, dy);
      e.preventDefault();
    };
    const onPointerUp = (e: PointerEvent): void => {
      isDragging = false;
      (e.currentTarget as HTMLElement | null)?.releasePointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    mount.addEventListener("pointerdown", onPointerDown, { passive: false });
    mount.addEventListener("pointermove", onPointerMove, { passive: false });
    mount.addEventListener("pointerup", onPointerUp, { passive: false });
    mount.addEventListener("pointercancel", onPointerUp, { passive: false });

    // Mouse fallback (some environments disable PointerEvents).
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      bg.panBy(dx, dy);
      e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent): void => {
      if (!isDragging) return;
      isDragging = false;
      e.preventDefault();
    };
    mount.addEventListener("mousedown", onMouseDown, { passive: false });
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp, { passive: false });

    const onPanKeys = (e: KeyboardEvent): void => {
      const step = e.shiftKey ? 64 : 16;
      switch (e.key) {
        case "ArrowUp": bg.panBy(0, step); e.preventDefault(); break;
        case "ArrowDown": bg.panBy(0, -step); e.preventDefault(); break;
        case "ArrowLeft": bg.panBy(step, 0); e.preventDefault(); break;
        case "ArrowRight": bg.panBy(-step, 0); e.preventDefault(); break;
        case "PageDown": bg.panBy(0, -step * 4); e.preventDefault(); break;
        case "PageUp": bg.panBy(0, step * 4); e.preventDefault(); break;
        case "Home": bg.setPan({ x: 0, y: 0 }); e.preventDefault(); break;
      }
    };
    window.addEventListener("keydown", onPanKeys);

    // Important: do NOT immediately remove listeners.
    // This route is meant to stay interactive for captures.
    await bg.init(mount);
    return;
  }

  document.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
    },
    true,
  );

  mountEarlyMenuBackdrop(mount);
  let prewarmedMenuBackground: MenuBackground | null = new MenuBackground();
  void prewarmedMenuBackground.init(mount).catch((err: unknown) => {
    console.warn("[main] Failed to prewarm menu background:", err);
    prewarmedMenuBackground = null;
  });

  const store = new IndexedDBStore();
  await store.openDB();
  await loadLocalSecretsFile();
  const auth = createAuthProvider();
  const crashReporter = new CrashReporter({
    sendReport: async (payload) => {
      try {
        const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
        const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
        if (url === "" || anon === "") {
          return { ok: false, detail: "Supabase is not configured." };
        }
        const res = await fetch(`${url}/functions/v1/crash-report`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${anon}`,
            apikey: anon,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string; message?: string };
            const msg = body.error ?? body.message;
            if (typeof msg === "string" && msg.trim() !== "") {
              detail = `${detail}: ${msg}`;
            }
          } catch {
            try {
              const txt = await res.text();
              if (txt.trim() !== "") {
                detail = `${detail}: ${txt.slice(0, 300)}`;
              }
            } catch {
              /* ignore */
            }
          }
          return { ok: false, detail };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail:
            err instanceof Error
              ? `${err.message} (Ensure \`supabase functions serve/deploy crash-report\` is running and project is linked.)`
              : "Failed to send report",
        };
      }
    },
  });
  window.addEventListener("error", (e) => {
    void crashReporter.report("error", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    void crashReporter.report("unhandledrejection", e.reason);
  });
  const signalRelay = createSupabaseSignalRelay(auth);

  const menuBus = new EventBus();
  const modRepository = new ModRepository(auth.getSupabaseClient(), store, menuBus);
  await modRepository.init();
  wireWorkshopHandlers(menuBus, auth, store, modRepository);

  const assetBase = import.meta.env.BASE_URL;
  const stratumResBase = `${assetBase}${STRATUM_CORE_RESOURCE_PACK_PATH}`;
  const sharedAudio = new AudioEngine();
  sharedAudio.setMasterVolume(readVolumeStored(VOL_KEYS.master, 80) / 100);
  sharedAudio.setMusicVolume(readVolumeStored(VOL_KEYS.music, 60) / 100);
  sharedAudio.setSfxVolume(readVolumeStored(VOL_KEYS.sfx, 100) / 100);
  const ost = new OstPlaylistController(sharedAudio, stratumResBase);
  await ost.loadManifest();
  ost.preloadMode("menu");
  ost.preloadMode("game");
  const primeAudioOnce = (): void => {
    sharedAudio.primeAudioFromUserGesture();
    window.removeEventListener("pointerdown", primeAudioOnce, true);
  };
  window.addEventListener("pointerdown", primeAudioOnce, true);

  window.addEventListener(
    "pagehide",
    (ev: PageTransitionEvent) => {
      if (ev.persisted) {
        sharedAudio.suspendContext();
      } else {
        ost.setMode(null);
      }
    },
    true,
  );
  window.addEventListener(
    "pageshow",
    (ev: PageTransitionEvent) => {
      if (ev.persisted) {
        sharedAudio.resumeContext();
      }
    },
    true,
  );

  let playStartupIntro = !getSkipIntro();
  if (!playStartupIntro) {
    document.getElementById("stratum-startup-boot")?.remove();
  }
  while (true) {
    performance.mark("menu-cycle:start");
    mount.classList.remove("stratum-game-loading");
    mount.replaceChildren();
    mountEarlyMenuBackdrop(mount);

    ost.preloadMode("menu");
    ost.setMode("menu", 0);

    const workshopDeps = auth.isConfigured
      ? { bus: menuBus, modRepository }
      : undefined;
    const { result, menuBackground } = await MainMenu.show(
      mount,
      store,
      auth,
      workshopDeps,
      sharedAudio,
      {
        playStartupIntro,
        prewarmedBackground: prewarmedMenuBackground ?? undefined,
      },
    );
    prewarmedMenuBackground = null;
    performance.mark("menu-cycle:ready");
    performance.measure("menu-cycle-ready", "menu-cycle:start", "menu-cycle:ready");
    playStartupIntro = false;
    await menuBackground.initFinished;
    ost.stopAdvancingPlaylist();
    mount.classList.add("stratum-game-loading");
    const loadingUi = new WorldLoadingScreen(mount);
    loadingUi.update({
      stage: "Preparing session",
      detail: "Loading world metadata...",
    });

    let worldUuid: string;
    let seed: number;
    let worldName: string;
    let playerSavedState: PlayerSavedState | undefined;
    let multiplayerJoinRoomCode: string | undefined;
    let multiplayerJoinPassword: string | undefined;
    let multiplayerHostFromMenu: MultiplayerHostFromMenuSpec | undefined;
    let initialWorldTimeMs: number | undefined;
    let gameMode: WorldGameMode = "survival";
    let worldGenType: WorldGenType = "normal";
    let game: Game | null = null;
    let loadingBackdrop: MenuBackground | null = null;
    try {
      if (result.action === "new") {
        worldUuid = crypto.randomUUID();
        seed = result.seed;
        worldName = result.name.trim() || "My World";
        gameMode = result.gameMode;
        worldGenType = result.worldGenType;
        localStorage.setItem("stratum_worldUuid", worldUuid);
      } else if (result.action === "load") {
        worldUuid = result.uuid;
        const meta = await store.loadWorld(result.uuid);
        if (meta === undefined) {
          throw new Error(`Saved world not found: ${result.uuid}`);
        }
        seed = meta.seed;
        worldName = meta.name;
        gameMode = normalizeWorldGameMode(meta.gameMode);
        worldGenType = normalizeWorldGenType(meta.worldGenType);
        playerSavedState = {
          x: meta.playerX,
          y: meta.playerY,
          hotbarSlot: meta.hotbarSlot,
          inventory: meta.playerInventory,
          health: meta.playerHealth,
          armor: meta.playerArmor,
        };
        initialWorldTimeMs = meta.worldTimeMs ?? 0;
        localStorage.setItem("stratum_worldUuid", worldUuid);
      } else if (result.action === "multiplayer-host") {
        worldUuid = result.worldUuid;
        const meta = await store.loadWorld(result.worldUuid);
        if (meta === undefined) {
          throw new Error(`Saved world not found: ${result.worldUuid}`);
        }
        seed = meta.seed;
        worldName = meta.name;
        gameMode = normalizeWorldGameMode(meta.gameMode);
        worldGenType = normalizeWorldGenType(meta.worldGenType);
        playerSavedState = {
          x: meta.playerX,
          y: meta.playerY,
          hotbarSlot: meta.hotbarSlot,
          inventory: meta.playerInventory,
          health: meta.playerHealth,
          armor: meta.playerArmor,
        };
        initialWorldTimeMs = meta.worldTimeMs ?? 0;
        localStorage.setItem("stratum_worldUuid", worldUuid);
        multiplayerHostFromMenu = {
          roomTitle: result.roomTitle,
          motd: result.motd,
          isPrivate: result.isPrivate,
          roomPassword: result.roomPassword,
        };
      } else {
        const remembered = localStorage.getItem("stratum_worldUuid");
        const joinReuse =
          remembered !== null && remembered.length > 0
            ? await store.loadWorld(remembered)
            : undefined;
        if (joinReuse !== undefined) {
          worldUuid = joinReuse.uuid;
          seed = 0;
          worldName = joinReuse.name;
          gameMode = normalizeWorldGameMode(joinReuse.gameMode);
          worldGenType = normalizeWorldGenType(joinReuse.worldGenType);
        } else {
          worldUuid = crypto.randomUUID();
          seed = 0;
          worldName = "Multiplayer World";
          gameMode = "survival";
          worldGenType = "normal";
        }
        multiplayerJoinRoomCode = result.roomCode;
        multiplayerJoinPassword = result.password;
      }

      if (menuBackground.isLive()) {
        loadingBackdrop = menuBackground;
      } else {
        loadingBackdrop = new MenuBackground();
        await loadingBackdrop.init(mount);
      }

      await auth.ensureAuthHydrated();
      const session = auth.getSession();
      const playerSettings = await store.loadPlayerSettings();
      let skinId = playerSettings.selectedSkinId;
      if (
        session === null &&
        typeof skinId === "string" &&
        skinId.startsWith("custom:")
      ) {
        skinId = DEFAULT_SKIN_ID;
      }
      game = new Game({
        mount,
        seed,
        worldUuid,
        store,
        worldName,
        gameMode,
        worldGenType,
        multiplayerJoinRoomCode,
        multiplayerJoinPassword,
        multiplayerHostFromMenu,
        initialWorldTimeMs,
        signalRelay,
        displayName: auth.getDisplayLabel(),
        accountId: session?.userId ?? null,
        localGuestUuid:
          session === null ? getOrCreateLocalGuestIdentity().uuid : null,
        skinId,
        modRepository,
        sharedAudio,
        preloadedBlockAtlas: loadingBackdrop?.getBlockAtlasLoader() ?? null,
      });
      crashReporter.setSessionContext({
        worldName,
        worldUuid,
      });
      crashReporter.attachBus(game.bus);
      const loadStartedAt = Date.now();
      const minHoldMs = randomLoadingHoldMs();
      await game.init(playerSavedState, (progress) => {
        loadingUi.update(progress);
      });
      const elapsed = Date.now() - loadStartedAt;
      const remaining = minHoldMs - elapsed;
      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
      }
      await loadingUi.finishAndHold();
      if (loadingBackdrop === null || game === null) {
        throw new Error("Internal error: world load finished without backdrop or game.");
      }
      await sharedAudio.fadeOutAndStopMusic(menuMusicFadeOutSec());
      const fadeBackdrop = loadingBackdrop;
      const gameToStart = game;
      await runGameEntryBlackTransition(mount, async () => {
        fadeBackdrop.destroy();
        loadingBackdrop = null;
        loadingUi.destroy();
        mount.classList.remove("stratum-game-loading");
        ost.setMode("game", 0);
        gameToStart.start();
      });

      await game.waitForStop();

      ost.setMode(null);
      await game.destroy();
      crashReporter.detachBus();
    } catch (err: unknown) {
      console.error(err);
      void crashReporter.report("error", err);
      ost.setMode(null);
      loadingBackdrop?.destroy();
      loadingBackdrop = null;
      loadingUi.setError(loadingErrorMessage(err));
      if (game !== null) {
        await game.destroy();
        crashReporter.detachBus();
      }
      await loadingUi.waitForBackToMenu();
      loadingUi.destroy();
      mount.classList.remove("stratum-game-loading");
    }
  }
}


void main().catch((err: unknown) => {
  console.error(err);
});
