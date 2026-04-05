import {
  DEFAULT_KEY_BINDINGS,
  type KeybindableAction,
} from "./bindings";

export function cloneDefaultKeyBindings(): Record<KeybindableAction, string[]> {
  const out = {} as Record<KeybindableAction, string[]>;
  for (const k of Object.keys(DEFAULT_KEY_BINDINGS) as KeybindableAction[]) {
    out[k] = [...DEFAULT_KEY_BINDINGS[k]];
  }
  return out;
}

export function mergeStoredKeyBindings(
  stored: Partial<Record<KeybindableAction, readonly string[]>> | undefined,
): Record<KeybindableAction, string[]> {
  const out = cloneDefaultKeyBindings();
  if (stored === undefined) {
    return out;
  }
  for (const a of Object.keys(stored) as KeybindableAction[]) {
    const keys = stored[a];
    if (!Array.isArray(keys) || keys.length === 0) {
      continue;
    }
    const cleaned = keys.filter(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (cleaned.length > 0) {
      out[a] = cleaned;
    }
  }
  return out;
}

export function dedupeKeyFromOtherActions(
  bindings: Record<KeybindableAction, string[]>,
  keepAction: KeybindableAction,
  code: string,
): void {
  for (const a of Object.keys(bindings) as KeybindableAction[]) {
    if (a === keepAction) {
      continue;
    }
    bindings[a] = bindings[a].filter((c) => c !== code);
  }
}

export function snapshotKeyBindings(
  bindings: Record<KeybindableAction, string[]>,
): Record<KeybindableAction, readonly string[]> {
  const out = {} as Record<KeybindableAction, readonly string[]>;
  for (const a of Object.keys(bindings) as KeybindableAction[]) {
    out[a] = Object.freeze([...bindings[a]]);
  }
  return out;
}
