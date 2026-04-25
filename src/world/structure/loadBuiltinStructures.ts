import {
  parseStructureFeatureJson,
  parseStructureJson,
  type ParsedStructure,
  type ParsedStructureFeature,
} from "./structureSchema";
import { structureIdFromPath } from "./structureIdFromPath";

export async function loadBuiltinStructures(): Promise<Map<string, ParsedStructure>> {
  const out = new Map<string, ParsedStructure>();
  const files = import.meta.glob("../../data/structures/*.json", {
    eager: true,
    import: "default",
  }) as Record<string, unknown>;
  for (const [path, raw] of Object.entries(files)) {
    const parsed = parseStructureJson(raw);
    const id = structureIdFromPath(path);
    out.set(id, parsed);
  }
  return out;
}

export async function loadBuiltinStructureFeatures(): Promise<ParsedStructureFeature[]> {
  const out: ParsedStructureFeature[] = [];
  const files = import.meta.glob("../../data/features/*.json", {
    eager: true,
    import: "default",
  }) as Record<string, unknown>;
  for (const raw of Object.values(files)) {
    out.push(parseStructureFeatureJson(raw));
  }
  return out;
}
