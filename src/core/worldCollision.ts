/** Screen-space AABB (Pixi Y down); structurally matches {@link import("../entities/physics/AABB").AABB}. */
export type ScreenAABB = { x: number; y: number; width: number; height: number };

/** Minimal world read surface for entity physics (avoids circular world↔entities imports). */
export interface WorldCollisionReader {
  isSolid(worldBlockX: number, worldBlockY: number): boolean;
  /** Fills `out` with screen-space solid block AABBs overlapping `region`. */
  querySolidAABBs(region: ScreenAABB, out: ScreenAABB[]): void;
}
