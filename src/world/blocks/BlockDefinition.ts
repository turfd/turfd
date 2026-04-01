/**
 * Registered block type (numeric id assigned by {@link BlockRegistry}).
 *
 * Fields: `id`, `identifier`, `displayName`, `material`, `textureName`, `solid`, `transparent`,
 * `water`, `hardness`, `lightEmission`, `lightAbsorption`, `drops`, `replaceable`, `tallGrass`.
 */
import type { BlockDefinitionBase } from "../../core/blockDefinition";

export interface BlockDefinition extends BlockDefinitionBase {
  readonly id: number;
}
