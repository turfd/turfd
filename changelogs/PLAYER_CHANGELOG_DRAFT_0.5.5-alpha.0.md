# Release notes draft (player-facing)

Use this with the release flow: **Step 1 = Summary**, **Step 2 = Full changelog**.

Headings, `**bold**`, lists, `> quotes`, and plain-text divider lines work in-game (GFM) and read cleanly when the same text is posted to Discord. Prefer bullets over tables in **At a glance** so Discord embeds stay legible everywhere.

────────────────────────────

## Step 1 - Summary

Lighting fixes at world edges and near doors, desert sand less streaky, multiplayer doors match the type you placed, shift-move inventory less flickery, creative slot names on the slot, Debug settings tab hidden in normal web builds, sheep mask tweak.

────────────────────────────

## Step 2 - Full changelog

# Stratum — Lighting, doors, and desert polish

────────────────────────────

## At a glance

- **Lighting** — Wrong or stuck light along some world edges and near doors; should match the scene better now.
- **World gen** — Deserts in bigger patches; fewer razor-thin lines of sand.
- **Doors** — Multiplayer uses the door type you placed (not always the same default). Doors blocked on the background layer like other tall blocks. Older clients joining still get a sensible fallback.
- **Inventory** — Shift–quick move: less double-flash on the slot the stack flies to.
- **Creative** — Item name on the slot (tooltip + accessibility label), not just the icon.
- **Settings** — Profiler tab only shows up on dev builds.
- **Mobs** — Sheep mask texture tweaked.

────────────────────────────

## Full changelog

**Lighting**

- Block and sky light refresh a wider ring around a change at world boundaries, not only the tile right on the line.
- Opening or closing a door forces a proper light refresh around it.
- Fixed light along some edges looking wrong until a bigger area had updated (doors and solid blocks next to a boundary).

**World gen**

- Desert noise stretched a bit; wider “counts as desert” band; ignores desert signals that were too narrow — fewer hairline sand strips.

**Doors**

- Host placement uses your actual door type for the top half instead of a single hard-coded wood.
- Background layer: cannot place doors (same idea as other two-tall stuff).

**Inventory**

- Shift stack fly: hide what’s under the flying icon so it doesn’t draw twice; same when the browser can’t animate.

**Creative**

- Tooltip / label on the slot, not stuck on the icon only.

**Settings**

- Debug / profiler sub-tab hidden in normal web builds (dev build only).

**Art**

- Sheep mask texture small edit.

────────────────────────────

## Thanks

Thanks for playing. If something’s still wrong: OS, browser, GPU, and roughly where you were (e.g. “door right at the edge of the screen”) helps.
