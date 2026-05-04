Lighting fixes at doors and chunk edges, desert sand less streaky, multiplayer doors match the type you placed, shift–quick-move flicker fix, creative item names on the slot, Debug/profiler tab dev-only, sheep mask cleanup.

# Stratum — Lighting, doors, and desert polish

## At a glance

- **Lighting** — Fixed stuck/wrong light near doors and chunk edges.
- **World gen** — Deserts in bigger patches; fewer razor-thin lines of sand.
- **Doors** — Multiplayer uses the door type you placed (not always the same default). Doors blocked on the background layer like other tall blocks. Older clients joining still get a sensible fallback.
- **Inventory** — Shift–quick move: destination slot no longer double-flashes.
- **Creative** — Item name on the slot (tooltip + accessibility label), not just the icon.
- **Settings** — Profiler tab only shows up on dev builds.
- **Mobs** — Sheep mask texture cleaned up.

## Full changelog

**Lighting**

- Block and sky light refresh a wider ring around a change at world boundaries, not only the tile right on the line.
- Opening or closing a door forces a proper light refresh around it.
- Fixed light along some edges looking wrong until a bigger area had updated (doors and solid blocks next to a chunk boundary).

**World gen**

- Desert noise adjusted so thin patches of desert no longer appear.

**Doors**

- Host placement uses your actual door type for the top half instead of a single hard-coded wood.
- Background layer: cannot place doors (same idea as other two-block tall stuff).

**Inventory**

- Fixed flickering during shift–quick-move animation.

**Creative**

- Tooltip / label on the slot, not stuck on the icon only.

**Settings**

- Debug / profiler sub-tab hidden in normal web builds (dev build only).

**Art**

- Sheep mask texture cleaned up.
