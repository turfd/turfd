/**
 * Stratum — application entry.
 */
import type { IAuthProvider } from "./auth/IAuthProvider";
import { createAuthProvider } from "./auth/createAuthProvider";
import { loadLocalSecretsFile } from "./config/secretsLoader";
import { EventBus } from "./core/EventBus";
import { unixRandom01 } from "./core/unixRandom";
import {
  Game,
  type MultiplayerHostFromMenuSpec,
  type PlayerSavedState,
} from "./core/Game";
import type { GameEvent } from "./core/types";
import { ModRepository } from "./mods/ModRepository";
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
import { MainMenu } from "./ui/screens/MainMenu";
import { MenuBackground } from "./ui/screens/MenuBackground";
import { runGameEntryBlackTransition } from "./ui/screens/gameEntryTransition";
import { WorldLoadingScreen } from "./ui/screens/WorldLoadingScreen";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "./styles/global.css";

/** Minimum time the loading overlay stays up (ms), so the bar and tips feel intentional. */
function randomLoadingHoldMs(): number {
  return 3000 + Math.floor(unixRandom01() * 1000);
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
}

async function main(): Promise<void> {
  const mount = document.getElementById("app");
  if (!mount) {
    throw new Error('Missing root element: expected <div id="app"></div>');
  }

  document.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      e.preventDefault();
    },
    true,
  );

  const store = new IndexedDBStore();
  await store.openDB();
  await loadLocalSecretsFile();
  const auth = createAuthProvider();
  const signalRelay = createSupabaseSignalRelay(auth);

  const menuBus = new EventBus();
  const modRepository = new ModRepository(auth.getSupabaseClient(), store, menuBus);
  await modRepository.init();
  wireWorkshopHandlers(menuBus, auth, store, modRepository);

  while (true) {
    mount.classList.remove("stratum-game-loading");
    mount.replaceChildren();

    const workshopDeps = auth.isConfigured
      ? { bus: menuBus, modRepository }
      : undefined;
    const { result, menuBackground } = await MainMenu.show(
      mount,
      store,
      auth,
      workshopDeps,
    );
    await menuBackground.initFinished;
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
    let game: Game | null = null;
    let loadingBackdrop: MenuBackground | null = null;
    try {
      if (result.action === "new") {
        worldUuid = crypto.randomUUID();
        seed = result.seed;
        worldName = result.name.trim() || "My World";
        localStorage.setItem("stratum_worldUuid", worldUuid);
      } else if (result.action === "load") {
        worldUuid = result.uuid;
        const meta = await store.loadWorld(result.uuid);
        if (meta === undefined) {
          throw new Error(`Saved world not found: ${result.uuid}`);
        }
        seed = meta.seed;
        worldName = meta.name;
        playerSavedState = {
          x: meta.playerX,
          y: meta.playerY,
          hotbarSlot: meta.hotbarSlot,
          inventory: meta.playerInventory,
          health: meta.playerHealth,
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
        playerSavedState = {
          x: meta.playerX,
          y: meta.playerY,
          hotbarSlot: meta.hotbarSlot,
          inventory: meta.playerInventory,
          health: meta.playerHealth,
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
        } else {
          worldUuid = crypto.randomUUID();
          seed = 0;
          worldName = "Multiplayer World";
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

      const session = auth.getSession();
      game = new Game({
        mount,
        seed,
        worldUuid,
        store,
        worldName,
        multiplayerJoinRoomCode,
        multiplayerJoinPassword,
        multiplayerHostFromMenu,
        initialWorldTimeMs,
        signalRelay,
        displayName: auth.getDisplayLabel(),
        accountId: session?.userId ?? null,
        modRepository,
      });
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
      const fadeBackdrop = loadingBackdrop;
      const gameToStart = game;
      await runGameEntryBlackTransition(mount, async () => {
        fadeBackdrop.destroy();
        loadingBackdrop = null;
        loadingUi.destroy();
        mount.classList.remove("stratum-game-loading");
        gameToStart.start();
      });

      await game.waitForStop();

      await game.destroy();
    } catch (err: unknown) {
      console.error(err);
      loadingBackdrop?.destroy();
      loadingBackdrop = null;
      loadingUi.setError(loadingErrorMessage(err));
      if (game !== null) {
        await game.destroy();
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1400);
      });
      loadingUi.destroy();
      mount.classList.remove("stratum-game-loading");
    }
  }
}


void main();
