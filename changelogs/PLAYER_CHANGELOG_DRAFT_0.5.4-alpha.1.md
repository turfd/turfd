# Release notes draft (player-facing)

Use this with the release flow: **Step 1 = Summary**, **Step 2 = Full changelog**.

---

## Step 1 - Summary

This minor patch focuses on smoothness and consistency, especially around door-heavy areas and chunk updates. We reduced per-frame overhead in several hot paths, tightened chunk rebuild budgeting, and polished the "What's New" modal scroll behavior.

---

## Step 2 - Full changelog

# Stratum - Minor performance and UI polish patch

> Hello everyone!  
> This is a smaller tuning patch focused on frame pacing and cleanup in high-frequency systems.

Most of the work here is under-the-hood, but the goal is simple: less hitching, less unnecessary work per frame, and steadier behavior when worlds get busy.

---

## At a glance

| Area | What changed |
|------|--------------|
| **Chunk updates** | Added a soft per-frame mesh rebuild time budget |
| **Doors / collisions** | Reduced per-tick allocations in door proximity + collider sampling |
| **Debug HUD cost** | F3 stats now use O(1)/cheap counters instead of per-frame iterator walks |
| **Menu polish** | "What's New" scroll hint now uses end-of-content visibility tracking |

---

## Highlights

1. **Chunk mesh rebuilds now respect a frame-time budget**
   - Added a soft `CHUNK_SYNC_BUDGET_MS` cap so dirty chunk rebuilds spread more evenly across frames.
   - The renderer still guarantees at least one rebuild when work is queued, so updates keep progressing.
   - This helps prevent bursty spikes when many nearby chunks become dirty at once.

2. **Door proximity processing is leaner**
   - Door player samples now reuse pooled buffers instead of allocating fresh arrays/AABBs every tick.
   - Door render signatures were packed into integers (instead of per-tick string construction).
   - Door proximity SFX state now mutates in place, reducing GC churn in active areas.

3. **Lower overhead while F3 debug HUD is open**
   - Mob and loaded-chunk counts now come from direct count helpers (`getCount()` / `getLoadedChunkCount()`), avoiding iterator allocation each frame.
   - This keeps instrumentation more representative and less intrusive during profiling.

4. **Small changelog modal behavior fix**
   - The "Scroll" hint in full release notes now hides/shows based on an end-of-content sentinel with `IntersectionObserver`, improving consistency at different viewport sizes.

---

## Technical notes

- The chunk sync budget is tuned to allow meaningful progress each frame while avoiding single-frame rebuild bursts.
- Door proximity update paths now include early-outs and no-allocation steady-state logic where possible.
- Added lightweight loaded-chunk counting in chunk management to support cheaper debug reporting.

---

## Thanks

Thank you for the performance reports and repro cases - especially around dense builds and frequent door interaction areas.

If you still notice spikes, sharing **OS + browser + GPU + rough world scenario** (for example "many doors near spawn") helps us tune faster
