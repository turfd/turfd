/**
 * Registered block type (`id` from JSON `stratum:numeric_id` via {@link BlockRegistry}).
 *
 * Fields: `id`, `identifier`, `displayName`, `material`, `textureName`, `solid`, `collides`, `transparent`,
 * `water`, `hardness`, `lightEmission`, `lightAbsorption`, `drops`, `replaceable`, `tallGrass`.
 */
import type { BlockDefinitionBase } from "../../core/blockDefinition";

export interface BlockDefinition extends BlockDefinitionBase {
  readonly id: number;
}
