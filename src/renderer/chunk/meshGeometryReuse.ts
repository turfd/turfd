import { Mesh, MeshGeometry } from "pixi.js";

/**
 * Reuses existing {@link MeshGeometry} GPU buffers when vertex/index counts match the
 * rebuilt geometry (common for small edits). Otherwise swaps geometry like a fresh build.
 */
export function assignMeshGeometryPreferReuse(mesh: Mesh, next: MeshGeometry): void {
  const prev = mesh.geometry;
  if (prev instanceof MeshGeometry && next instanceof MeshGeometry) {
    if (
      prev.positions.length === next.positions.length &&
      prev.uvs.length === next.uvs.length &&
      prev.indices.length === next.indices.length
    ) {
      prev.positions.set(next.positions);
      prev.uvs.set(next.uvs);
      prev.indices.set(next.indices);
      prev.getBuffer("aPosition").update();
      prev.getBuffer("aUV").update();
      prev.getIndex().update();
      next.destroy(true);
      return;
    }
  }
  prev.destroy(true);
  mesh.geometry = next as unknown as typeof mesh.geometry;
}
