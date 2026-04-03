/**
 * Optional local overrides for Vite env vars (dev only).
 * Copy `public/secrets.local.example.json` to `public/secrets.local.json` (gitignored).
 */

let loaded: Record<string, string> | undefined;

function normalizeEntries(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

/** Fetch and parse `secrets.local.json` once. Safe to call multiple times. */
export async function loadLocalSecretsFile(): Promise<void> {
  if (loaded !== undefined) {
    return;
  }
  loaded = {};
  if (!import.meta.env.DEV) {
    return;
  }
  try {
    const res = await fetch(
      `${import.meta.env.BASE_URL}secrets.local.json`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return;
    }
    loaded = normalizeEntries(await res.json());
  } catch {
    // Missing file or invalid JSON — rely on env only.
  }
}

/** Value from `secrets.local.json` after {@link loadLocalSecretsFile}; empty if unset. */
export function localSecret(key: string): string {
  const v = loaded?.[key];
  return typeof v === "string" ? v.trim() : "";
}
