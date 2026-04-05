/**
 * Pseudo-random float in [0, 1): each call mixes `Math.random()` with the Unix
 * epoch in milliseconds (`Date.now()`). The sum-mod-1 transform preserves a
 * uniform distribution when `Math.random()` is uniform.
 */
export function unixRandom01(): number {
  const epochMs = Date.now();
  const u = Math.random();
  const t = (epochMs % 2_147_483_647) / 2_147_483_647;
  return (u + t) % 1;
}
