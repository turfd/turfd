/**
 * Persistent anonymous identity for users without a Supabase session:
 * a stable local UUID and an Xbox-style gamertag (letters only, ≤12 chars).
 */

const STORAGE_UUID_KEY = "stratum_local_guest_uuid";
const STORAGE_NAME_KEY = "stratum_local_guest_display_name";

/** Curated fragments; combined in PascalCase, ASCII letters only, total length ≤ 12. */
const GAMERTAG_PREFIXES = [
  "oak",
  "sun",
  "sea",
  "sky",
  "fox",
  "jay",
  "elm",
  "ash",
  "ivy",
  "orb",
  "gem",
  "arc",
  "zen",
  "neo",
  "lux",
  "sol",
  "luna",
  "vera",
  "nova",
  "echo",
  "apex",
  "rift",
  "vale",
  "mist",
  "dawn",
  "dusk",
  "ember",
  "frost",
  "gale",
  "haven",
] as const;

const GAMERTAG_SUFFIXES = [
  "pine",
  "peak",
  "wave",
  "wind",
  "stone",
  "brook",
  "ridge",
  "cove",
  "glen",
  "moor",
  "marsh",
  "field",
  "haven",
  "crest",
  "shard",
  "flare",
  "pulse",
  "spark",
  "trail",
  "beacon",
  "pillar",
  "harbor",
  "meadow",
  "grove",
  "falcon",
  "raven",
  "badger",
  "spruce",
  "willow",
  "maple",
] as const;

export type LocalGuestIdentity = {
  uuid: string;
  displayName: string;
};

function randomUint32(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

function pick<T extends readonly string[]>(arr: T): T[number] {
  return arr[randomUint32() % arr.length]!;
}

function toPascalCase(word: string): string {
  if (word.length === 0) {
    return "";
  }
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Two-word PascalCase gamertag, letters only, length 4–12 inclusive.
 */
function generateRandomGamertag(): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const a = pick(GAMERTAG_PREFIXES);
    const b = pick(GAMERTAG_SUFFIXES);
    const tag = `${toPascalCase(a)}${toPascalCase(b)}`;
    if (/^[A-Za-z]+$/.test(tag) && tag.length >= 4 && tag.length <= 12) {
      return tag;
    }
  }
  const a = toPascalCase(pick(GAMERTAG_PREFIXES));
  const b = toPascalCase(pick(GAMERTAG_SUFFIXES));
  let tag = `${a}${b}`;
  if (tag.length > 12) {
    tag = tag.slice(0, 12);
  }
  return /^[A-Za-z]+$/.test(tag) && tag.length >= 4 ? tag : "StratumGuest";
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Returns the persisted guest UUID and gamertag, creating them on first use.
 */
export function getOrCreateLocalGuestIdentity(): LocalGuestIdentity {
  let uuid = readStorage(STORAGE_UUID_KEY);
  if (uuid === null || uuid.trim() === "") {
    uuid = crypto.randomUUID();
    writeStorage(STORAGE_UUID_KEY, uuid);
  }

  let displayName = readStorage(STORAGE_NAME_KEY);
  if (displayName === null || displayName.trim() === "") {
    displayName = generateRandomGamertag();
    writeStorage(STORAGE_NAME_KEY, displayName);
  }

  return { uuid: uuid.trim(), displayName: displayName.trim() };
}
