/**
 * Detect when this tab runs an older JS bundle than the current deploy (browser / CDN cached HTML+JS).
 * Fetches root `build.json` with cache bypass and compares to the bundle's `__BUILD_ID__`.
 *
 * **Reload policy:** Mixed build IDs in multiplayer cause subtle desyncs (host logic vs old client).
 * When the banner appears, players should reload before joining or hosting. Checks run at startup,
 * when the tab becomes visible again, when the window gains focus, and when the browser goes online.
 */

import { parseJsoncResponse } from "./core/jsonc";

const BANNER_Z = 25000;
const MIN_CHECK_INTERVAL_MS = 60_000;

function buildMetaUrl(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const b = base.endsWith("/") ? base : `${base}/`;
  return `${b}build.json`;
}

type BuildJson = { buildId?: string };

let bannerEl: HTMLDivElement | null = null;
let lastCheckAt = 0;

async function fetchServerBuildId(): Promise<string | null> {
  const base = buildMetaUrl();
  const sep = base.includes("?") ? "&" : "?";
  const url = `${base}${sep}_=${Date.now()}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return null;
    }
    const data = await parseJsoncResponse<BuildJson>(res, url);
    const id = data.buildId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function mountUpdateBanner(): void {
  if (bannerEl !== null || document.getElementById("stratum-update-banner") !== null) {
    return;
  }
  const bar = document.createElement("div");
  bar.id = "stratum-update-banner";
  bar.setAttribute("role", "alert");
  bar.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    `z-index:${BANNER_Z}`,
    "box-sizing:border-box",
    "padding:10px 14px",
    "display:flex",
    "flex-wrap:wrap",
    "align-items:center",
    "justify-content:center",
    "gap:10px",
    "font-family:'BoldPixels','Courier New',monospace",
    "font-size:13px",
    "letter-spacing:0.04em",
    "color:#e8f4ff",
    "background:rgba(12,28,48,0.94)",
    "border-bottom:1px solid rgba(116,179,255,0.35)",
    "box-shadow:0 4px 18px rgba(0,0,0,0.35)",
  ].join(";");

  const msg = document.createElement("span");
  msg.textContent =
    "A newer version of Stratum is available. Reload to play on the latest build (fixes multiplayer compatibility).";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText = [
    "cursor:pointer",
    "font:inherit",
    "letter-spacing:inherit",
    "text-transform:uppercase",
    "padding:6px 14px",
    "border-radius:4px",
    "border:1px solid rgba(116,179,255,0.55)",
    "background:linear-gradient(180deg,#4a7ab8,#355a8a)",
    "color:#fff",
  ].join(";");
  reload.addEventListener("click", () => {
    window.location.reload();
  });

  const later = document.createElement("button");
  later.type = "button";
  later.textContent = "Later";
  later.style.cssText = [
    "cursor:pointer",
    "font:inherit",
    "letter-spacing:inherit",
    "text-transform:uppercase",
    "padding:6px 12px",
    "border-radius:4px",
    "border:1px solid rgba(255,255,255,0.2)",
    "background:transparent",
    "color:rgba(255,255,255,0.75)",
  ].join(";");
  later.addEventListener("click", () => {
    bar.remove();
    bannerEl = null;
  });

  bar.appendChild(msg);
  bar.appendChild(reload);
  bar.appendChild(later);
  document.body.appendChild(bar);
  bannerEl = bar;
}

async function runCheckOnce(): Promise<void> {
  if (!import.meta.env.PROD) {
    return;
  }
  const now = Date.now();
  if (now - lastCheckAt < MIN_CHECK_INTERVAL_MS) {
    return;
  }
  lastCheckAt = now;

  const localId = __BUILD_ID__;
  const remoteId = await fetchServerBuildId();
  if (remoteId === null || remoteId === localId) {
    return;
  }
  mountUpdateBanner();
}

/**
 * Non-blocking: compares bundled `__BUILD_ID__` to live `build.json`.
 * Re-runs when the tab becomes visible (player returns after hours).
 */
export function installStaleClientGuard(): void {
  if (!import.meta.env.PROD) {
    return;
  }
  void runCheckOnce();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void runCheckOnce();
    }
  });
  window.addEventListener("focus", () => {
    void runCheckOnce();
  });
  window.addEventListener("online", () => {
    void runCheckOnce();
  });
}
