import type {
  ParsedStructure,
  ParsedStructureFeature,
} from "./structureSchema";

type StructureFeatureEntry = {
  identifier: string;
  structureIds: string[];
  placement: ParsedStructureFeature["stratum:feature"]["placement"];
};

export class StructureRegistry {
  private readonly _structures = new Map<string, ParsedStructure>();
  private readonly _features = new Map<string, StructureFeatureEntry>();

  registerStructure(identifier: string, structure: ParsedStructure): void {
    this._structures.set(identifier, structure);
  }

  registerFeature(feature: ParsedStructureFeature): void {
    const payload = feature["stratum:feature"];
    const structureIds =
      payload.description.structures !== undefined
        ? [...payload.description.structures]
        : payload.description.structure !== undefined
          ? [payload.description.structure]
          : [];
    if (structureIds.length === 0) {
      return;
    }
    this._features.set(payload.description.identifier, {
      identifier: payload.description.identifier,
      structureIds,
      placement: payload.placement,
    });
  }

  getStructure(identifier: string): ParsedStructure | undefined {
    return this._structures.get(identifier);
  }

  /** Sorted registered structure ids (for `/structure list` and tooling). */
  listStructureIdentifiers(): string[] {
    return [...this._structures.keys()].sort((a, b) => a.localeCompare(b));
  }

  getFeature(identifier: string): StructureFeatureEntry | undefined {
    return this._features.get(identifier);
  }

  listFeatures(): readonly StructureFeatureEntry[] {
    return [...this._features.values()];
  }
}

export type { StructureFeatureEntry };
