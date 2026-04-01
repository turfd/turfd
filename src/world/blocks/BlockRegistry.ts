/**
 * Sequential numeric block ids (air = 0). Lookups throw if missing.
 */
import type { BlockDefinitionBase } from "../../core/blockDefinition";
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
   * Register a block; returns assigned id. First call must be `turfd:air` (id 0).
   */
  register(def: BlockDefinitionBase): number {
    const id = this.byId.length;
    if (id === 0 && def.identifier !== "turfd:air") {
      throw new Error(
        `First registered block must be turfd:air (got ${def.identifier})`,
      );
    }
    if (this.byIdentifier.has(def.identifier)) {
      throw new Error(`Duplicate block identifier: ${def.identifier}`);
    }
    const full: BlockDefinition = { ...def, id };
    this.byId.push(full);
    this.byIdentifier.set(def.identifier, full);
    const ns = def.identifier.split(":")[0];
    if (ns) {
      this.modNamespaces.add(ns);
    }
    return id;
  }

  /** Unique mod namespace prefixes from registered block identifiers (e.g. `turfd`). */
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

  getByIdentifier(identifier: string): BlockDefinition {
    const b = this.byIdentifier.get(identifier);
    if (b === undefined) {
      throw new Error(`Unknown block identifier: ${identifier}`);
    }
    return b;
  }
}
