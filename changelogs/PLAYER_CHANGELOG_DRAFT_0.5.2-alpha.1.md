# Release notes draft (player-facing)

Use this with the release tool flow: **Step 1 = Summary**, **Step 2 = Full changelog**.

---

## Step 1 - Summary

This update improves creative flow and in-game readability: new creative inventory categories, better flight controls, and a cleaner "What's New" experience. We also added `/time set` command support, expanded the F3 debug HUD, and tuned rendering/world visuals for smoother play.

---

## Step 2 - Full changelog

# Stratum - Creative flow, debug tools, and polish

> Hello everyone!  
> This patch is about making day-to-day play and testing feel better: cleaner menus, easier creative inventory browsing, better flight controls, and more useful diagnostics when you want to dig into performance.

Thank you for all the feedback reports and test sessions - especially around UI readability and iteration speed.

---

## At a glance

| Area | What changed |
|------|--------------|
| **Commands** | Added `/time set` flow for solo/host worlds |
| **Creative mode** | Category tabs + metadata-backed organization in the creative panel |
| **Debugging** | Major F3 HUD upgrade with graphs, profiles, and targeted block detail |
| **Menus & notes** | Improved "What's New" modal readability, scrolling, and typography |
| **Rendering polish** | Sharper fractional upscale path and chunk cleanup performance improvements |

---

## Highlights

1. **`/time set` command support**
   - You can now set world time with named presets and percentages.
   - Examples: `/time set day`, `/time set night`, `/time set 25`.
   - Host broadcasts world-time changes to connected clients.

2. **Creative inventory feels faster to navigate**
   - Added **category tabs** (plus "All") in the creative panel.
   - Core block/item JSON now includes `stratum:creative_category` metadata, used by runtime parsing and filtering.
   - Search now combines cleanly with category filtering.

3. **Creative flight controls updated**
   - Flying now uses a clearer control split:
     - **Shift** = faster flight
     - **Ctrl** (and `S`) = descend
   - Movement behavior is more predictable while building or testing in sandbox.

4. **F3 debug HUD overhaul**
   - New multi-panel layout inspired by classic debug overlays.
   - Added snapshot details for position/chunks/entities/audio/memory/system.
   - Added targeted block diagnostics (including chest/furnace/sign tile details).
   - New hotkeys:
     - `F3+1` profiler-focused graphs
     - `F3+2` perf graphs
     - `F3+3` network graphs
     - `F3+F6` profile cycling

---

## UI and menu polish

- "What's New" summary + full modal got a readability pass:
  - larger and better-contained scroll areas
  - clearer scrollbar styling and overflow hints
  - improved link, quote, code, and table styling
- Release markdown typography now normalizes unsupported Unicode punctuation to ASCII to avoid bitmap font fallback issues.
- Added a quick **"Open documentation wiki"** button in Workshop publishing.
- Pause menu now points players toward `/time set ...` command usage instead of the old time slider.

---

## Rendering and world polish

- Improved backbuffer-resolution behavior at large viewports while keeping pixel-art output sharp.
- Sky canvas now enforces pixelated rendering.
- Chunk mesh teardown now batches destruction in a microtask to reduce heavy-frame spikes when chunks unload.
- Tuned world generation lake distribution and night parallax brightness/tint behavior for more consistent scene readability.
- Minor firefly lighting offset tweaks for better bloom placement.

---

## Release system quality-of-life

- Release notes loader now scans recent commits and **skips non-release commits** until it finds a valid tagged `[Summary]` + `[Changes]` entry.
- This keeps player-facing notes stable even when internal commits happen between releases.

---

## Thanks

Whether you are building in Creative, profiling with F3, or just dropping into a world after work - thank you for playing Stratum.

If anything still feels off, reports with **OS + browser + GPU** help us fix issues faster.
