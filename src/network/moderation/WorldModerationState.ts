/**
 * Per-world ban/mute/op lists: normalized display name + optional Supabase user id.
 */

export type ModerationEntry = {
  /** Normalized display name at time of moderation action. */
  name: string;
  /** `auth.users` id / profiles.id; null for guests. */
  accountId: string | null;
};

export type WorldModerationPersisted = {
  bans: ModerationEntry[];
  mutes: ModerationEntry[];
  ops: ModerationEntry[];
};

export function normalizeModerationName(s: string): string {
  return s.trim().toLowerCase();
}

export function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s.trim(),
  );
}

function entryMatchesUnbanArg(e: ModerationEntry, argNorm: string, argRaw: string): boolean {
  if (normalizeModerationName(e.name) === argNorm) {
    return true;
  }
  if (looksLikeUuid(argRaw) && e.accountId !== null && e.accountId === argRaw.trim()) {
    return true;
  }
  return false;
}

function dedupeEntries(list: ModerationEntry[]): ModerationEntry[] {
  const seen = new Set<string>();
  const out: ModerationEntry[] = [];
  for (const e of list) {
    const key = `${normalizeModerationName(e.name)}\0${e.accountId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  return out;
}

export class WorldModerationState {
  bans: ModerationEntry[] = [];
  mutes: ModerationEntry[] = [];
  ops: ModerationEntry[] = [];

  toPersisted(): WorldModerationPersisted {
    return {
      bans: dedupeEntries([...this.bans]),
      mutes: dedupeEntries([...this.mutes]),
      ops: dedupeEntries([...this.ops]),
    };
  }

  loadFromPersisted(raw: WorldModerationPersisted | undefined): void {
    if (raw === undefined) {
      this.bans = [];
      this.mutes = [];
      this.ops = [];
      return;
    }
    this.bans = dedupeEntries(raw.bans ?? []);
    this.mutes = dedupeEntries(raw.mutes ?? []);
    this.ops = dedupeEntries(raw.ops ?? []);
  }

  isBanned(displayName: string, accountId: string): boolean {
    const nn = normalizeModerationName(displayName);
    const aid = accountId.trim();
    for (const r of this.bans) {
      if (normalizeModerationName(r.name) === nn) {
        return true;
      }
      if (aid !== "" && r.accountId !== null && r.accountId === aid) {
        return true;
      }
    }
    return false;
  }

  isMuted(displayName: string, accountId: string): boolean {
    const nn = normalizeModerationName(displayName);
    const aid = accountId.trim();
    for (const r of this.mutes) {
      if (normalizeModerationName(r.name) === nn) {
        return true;
      }
      if (aid !== "" && r.accountId !== null && r.accountId === aid) {
        return true;
      }
    }
    return false;
  }

  isOp(displayName: string, accountId: string): boolean {
    const nn = normalizeModerationName(displayName);
    const aid = accountId.trim();
    for (const r of this.ops) {
      if (normalizeModerationName(r.name) === nn) {
        return true;
      }
      if (aid !== "" && r.accountId !== null && r.accountId === aid) {
        return true;
      }
    }
    return false;
  }

  addBan(e: ModerationEntry): void {
    this.bans.push({
      name: normalizeModerationName(e.name),
      accountId: e.accountId?.trim() !== "" ? e.accountId!.trim() : null,
    });
    this.bans = dedupeEntries(this.bans);
  }

  removeBanMatches(arg: string): void {
    const argNorm = normalizeModerationName(arg);
    const argRaw = arg.trim();
    this.bans = this.bans.filter((e) => !entryMatchesUnbanArg(e, argNorm, argRaw));
  }

  addMute(e: ModerationEntry): void {
    this.mutes.push({
      name: normalizeModerationName(e.name),
      accountId: e.accountId?.trim() !== "" ? e.accountId!.trim() : null,
    });
    this.mutes = dedupeEntries(this.mutes);
  }

  removeMuteMatches(arg: string): void {
    const argNorm = normalizeModerationName(arg);
    const argRaw = arg.trim();
    this.mutes = this.mutes.filter((e) => !entryMatchesUnbanArg(e, argNorm, argRaw));
  }

  addOp(e: ModerationEntry): void {
    this.ops.push({
      name: normalizeModerationName(e.name),
      accountId: e.accountId?.trim() !== "" ? e.accountId!.trim() : null,
    });
    this.ops = dedupeEntries(this.ops);
  }

  removeOpMatches(arg: string): void {
    const argNorm = normalizeModerationName(arg);
    const argRaw = arg.trim();
    this.ops = this.ops.filter((e) => !entryMatchesUnbanArg(e, argNorm, argRaw));
  }
}

/** Migrate legacy flat name-only arrays from older saves. */
export function migrateModerationMetadata(raw: unknown): WorldModerationPersisted {
  const empty: WorldModerationPersisted = { bans: [], mutes: [], ops: [] };
  if (raw === null || typeof raw !== "object") {
    return empty;
  }
  const o = raw as Record<string, unknown>;

  const asEntries = (
    arr: unknown,
    key: "bannedNames" | "mutedNames" | "opNames",
  ): ModerationEntry[] => {
    if (!Array.isArray(arr)) {
      return [];
    }
    if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && "name" in arr[0]) {
      return (arr as ModerationEntry[]).map((e) => ({
        name: normalizeModerationName(String(e.name)),
        accountId:
          typeof e.accountId === "string" && e.accountId.trim() !== ""
            ? e.accountId.trim()
            : null,
      }));
    }
    if (key === "bannedNames" && arr.every((x) => typeof x === "string")) {
      return (arr as string[]).map((n) => ({
        name: normalizeModerationName(n),
        accountId: null,
      }));
    }
    if (key === "mutedNames" && arr.every((x) => typeof x === "string")) {
      return (arr as string[]).map((n) => ({
        name: normalizeModerationName(n),
        accountId: null,
      }));
    }
    if (key === "opNames" && arr.every((x) => typeof x === "string")) {
      return (arr as string[]).map((n) => ({
        name: normalizeModerationName(n),
        accountId: null,
      }));
    }
    return [];
  };

  if ("bans" in o || "mutes" in o || "ops" in o) {
    return {
      bans: asEntries(o.bans, "bannedNames"),
      mutes: asEntries(o.mutes, "mutedNames"),
      ops: asEntries(o.ops, "opNames"),
    };
  }

  return {
    bans: asEntries(o.bannedNames, "bannedNames"),
    mutes: asEntries(o.mutedNames, "mutedNames"),
    ops: asEntries(o.opNames, "opNames"),
  };
}
