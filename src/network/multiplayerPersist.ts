/**
 * Stable key for storing a guest’s last multiplayer feet position in world metadata.
 * Prefer signed-in `accountId`; else persisted local anonymous UUID; else normalized display name.
 */
export function multiplayerPersistKey(
  accountId: string | undefined | null,
  displayName: string,
  localGuestUuid?: string | null,
): string {
  const id = typeof accountId === "string" ? accountId.trim() : "";
  if (id.length > 0) {
    return `id:${id}`;
  }
  const local = typeof localGuestUuid === "string" ? localGuestUuid.trim() : "";
  if (local.length > 0) {
    return `local:${local}`;
  }
  const n = displayName.trim().toLowerCase().replace(/\s+/g, " ");
  return `name:${n.length > 0 ? n : "guest"}`;
}
