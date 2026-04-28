import type { ParsedBlockDefinition } from "../../mods/parseBlockJson";
import type { BlockDefinition } from "./BlockDefinition";

export class BlockRegistry {
  private readonly byId: BlockDefinition[] = [];
  private readonly byIdentifier = new Map<string, BlockDefinition>();
  private readonly modNamespaces = new Set<string>();

  /** Number of registered block types. */
  get size(): number {
    return this.byId.length;
  }

  /** Register/override a block by identifier; runtime id is session-local and contiguous. */
  register(parsed: ParsedBlockDefinition): void {
    if (this.byId.length === 0 && parsed.identifier !== "stratum:air") {
      throw new Error(
        `First registered block must be stratum:air (got ${parsed.identifier})`,
      );
    }
    const existing = this.byIdentifier.get(parsed.identifier);
    if (existing !== undefined) {
      const replacement: BlockDefinition = { ...parsed, id: existing.id };
      this.byId[existing.id] = replacement;
      this.byIdentifier.set(replacement.identifier, replacement);
      const ns = replacement.identifier.split(":")[0];
      if (ns) {
        this.modNamespaces.add(ns);
      }
      return;
    }
    const id = this.byId.length;
    const full: BlockDefinition = { ...parsed, id };
    this.byId.push(full);
    this.byIdentifier.set(full.identifier, full);
    const ns = full.identifier.split(":")[0];
    if (ns) {
      this.modNamespaces.add(ns);
    }
  }

  /** For world saves: index = numeric block id, value = identifier (semantic remap on load). */
  buildIdentifierPalette(): string[] {
    return this.byId.map((b) => b.identifier);
  }

  /** Unique mod namespace prefixes from registered block identifiers (e.g. `stratum`). */
  getModList(): string[] {
    return [...this.modNamespaces].sort();
  }

  isRegistered(identifier: string): boolean {
    return this.byIdentifier.has(identifier);
  }

  getById(id: number): BlockDefinition {
    const b = this.byId[id];
    if (b === undefined) {
      throw new Error(`Unknown block id: ${id}`);
    }
    return b;
  }

  /** Fast solid check for hot paths (occlusion, lighting) without full definition lookup. */
  isSolid(id: number): boolean {
    return this.byId[id]?.solid ?? false;
  }

  /** Fast collision check for physics queries without allocating {@link getById} objects. */
  collides(id: number): boolean {
    return this.byId[id]?.collides ?? false;
  }

  /** Returns true if the block is a door half (lighting is metadata-dependent for doors). */
  isDoor(id: number): boolean {
    const h = this.byId[id]?.doorHalf;
    return h === "bottom" || h === "top";
  }

  /**
   * Foreground blocks that cast orthographic contact-shadow strips on adjacent background tiles.
   * False for air, non-solid, solid transparent cells, and any block that sets
   * `castsFgContactShadow: false` in JSON.
   */
  castsFgContactShadow(id: number): boolean {
    const b = this.byId[id];
    if (b === undefined || !b.solid) {
      return false;
    }
    if (b.castsFgContactShadow !== undefined) {
      return b.castsFgContactShadow;
    }
    return !b.transparent;
  }

  /**
   * When true, the foreground cell fully covers the back-wall tile for mesh purposes: skip emitting
   * a background quad (and matching fg-on-bg shadow strips) for the same chunk cell.
   */
  foregroundOccludesBackgroundWall(id: number): boolean {
    if (id === 0) {
      return false;
    }
    const b = this.byId[id];
    if (b === undefined) {
      return false;
    }
    if (b.revealsBackgroundWall === true) {
      return false;
    }
    if (b.water) {
      return false;
    }
    if (!b.solid) {
      return false;
    }
    if (b.transparent) {
      return false;
    }
    if (b.doorHalf !== "none" || b.bedHalf !== "none" || b.tallGrass !== "none") {
      return false;
    }
    if (b.isStair === true || b.decorationLeaves === true || b.isPainting === true) {
      return false;
    }
    return true;
  }

  getByIdentifier(identifier: string): BlockDefinition {
    const b = this.byIdentifier.get(identifier);
    if (b === undefined) {
      throw new Error(`Unknown block identifier: ${identifier}`);
    }
    return b;
  }

  /**
   * Back-compat alias retained while call sites migrate away from numeric-id-ordered content.
   */
  registerInOrder(parsed: ParsedBlockDefinition): void {
    this.register(parsed);
  }
}
