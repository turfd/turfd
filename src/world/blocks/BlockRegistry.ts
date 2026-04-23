/**
 * Numeric block ids are **content-defined** (`stratum:numeric_id`), dense from 0 (air).
 */
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

  /**
   * Register the next block in dense order. `parsed.numericId` must equal current `size`
   * (so the first block is air with id 0).
   */
  registerInOrder(parsed: ParsedBlockDefinition): void {
    const id = this.byId.length;
    const { numericId, ...base } = parsed;
    if (numericId !== id) {
      throw new Error(
        `Block '${parsed.identifier}': stratum:numeric_id is ${numericId}, expected ${id} (ids must be dense from 0).`,
      );
    }
    if (id === 0 && parsed.identifier !== "stratum:air") {
      throw new Error(
        `First registered block must be stratum:air (got ${parsed.identifier})`,
      );
    }
    if (this.byIdentifier.has(parsed.identifier)) {
      throw new Error(`Duplicate block identifier: ${parsed.identifier}`);
    }
    const full: BlockDefinition = { ...base, id };
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

  getByIdentifier(identifier: string): BlockDefinition {
    const b = this.byIdentifier.get(identifier);
    if (b === undefined) {
      throw new Error(`Unknown block identifier: ${identifier}`);
    }
    return b;
  }
}
