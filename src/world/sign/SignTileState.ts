export type SignTileState = {
  text: string;
};

export function signCellKey(wx: number, wy: number): string {
  return `${wx},${wy}`;
}

export function createDefaultSignTileState(): SignTileState {
  return { text: "" };
}

export function normalizeSignTileStateForGeneratedPlacement(raw: unknown): SignTileState {
  if (raw === null || typeof raw !== "object") {
    return createDefaultSignTileState();
  }
  const text = (raw as { text?: unknown }).text;
  if (typeof text !== "string") {
    return createDefaultSignTileState();
  }
  return { text: text.slice(0, 640) };
}
