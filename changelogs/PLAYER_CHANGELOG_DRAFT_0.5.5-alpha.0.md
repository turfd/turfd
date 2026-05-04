Lighting fixes at doors and chunk edges, desert sand less streaky, multiplayer doors match the type you placed, shift–quick-move flicker fix, creative item names on the slot, Debug/profiler tab dev-only, sheep mask cleanup.

- Fixed block and sky light refreshing in too small a ring at world boundaries
- Fixed wrong or stuck light near doors and chunk edges until a big area had updated
- Opening or closing a door forces a proper light refresh around it
- Tuned desert noise — fewer razor-thin sand strips, wider patches
- Multiplayer doors use the wood type you placed on the top half, not a hard-coded default
- Can’t place doors on the background layer (same as other two-tall blocks); older clients still get a safe fallback
- Fixed shift–quick-move double-flash on the destination slot
- Creative slots show item name in tooltip and for accessibility, not just the icon
- Debug / profiler sub-tab only shows in dev builds
- Sheep mask texture cleaned up
