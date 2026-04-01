/**
 * Stratum — application entry.
 */
import { createAuthProvider } from "./auth/createAuthProvider";
import { Game } from "./core/Game";
import { createSupabaseSignalRelay } from "./network/SupabaseSignalAdapter";
import type { PlayerSavedState } from "./core/Game";
import { IndexedDBStore } from "./persistence/IndexedDBStore";
import { MainMenu } from "./ui/screens/MainMenu";
import { WorldLoadingScreen } from "./ui/screens/WorldLoadingScreen";
import "./styles/global.css";

/** Minimum time the loading overlay stays up (ms), so the bar and tips feel intentional. */
function randomLoadingHoldMs(): number {
  return 3000 + Math.floor(Math.random() * 1000);
}

function loadingErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") {
    return err.message;
  }
  return "An unknown error occurred while preparing the world.";
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
  const auth = createAuthProvider();
  const signalRelay = createSupabaseSignalRelay(auth);

  while (true) {
    mount.classList.remove("stratum-game-loading");
    mount.replaceChildren();

    const result = await MainMenu.show(mount, store, auth);
    const loadingUi = new WorldLoadingScreen(mount);
    mount.classList.add("stratum-game-loading");
    loadingUi.update({
      stage: "Preparing session",
      detail: "Loading world metadata...",
    });

    let worldUuid: string;
    let seed: number;
    let worldName: string;
    let playerSavedState: PlayerSavedState | undefined;
    let multiplayerJoinRoomCode: string | undefined;
    let initialWorldTimeMs: number | undefined;
    let game: Game | null = null;
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
        };
        initialWorldTimeMs = meta.worldTimeMs ?? 0;
        localStorage.setItem("stratum_worldUuid", worldUuid);
      } else {
        worldUuid = crypto.randomUUID();
        seed = 0;
        worldName = "Multiplayer World";
        multiplayerJoinRoomCode = result.roomCode;
      }

      const session = auth.getSession();
      game = new Game({
        mount,
        seed,
        worldUuid,
        store,
        worldName,
        multiplayerJoinRoomCode,
        initialWorldTimeMs,
        signalRelay,
        displayName: auth.getDisplayLabel(),
        accountId: session?.userId ?? null,
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
      loadingUi.destroy();
      mount.classList.remove("stratum-game-loading");
      game.start();

      await game.waitForStop();

      await game.destroy();
    } catch (err: unknown) {
      console.error(err);
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
