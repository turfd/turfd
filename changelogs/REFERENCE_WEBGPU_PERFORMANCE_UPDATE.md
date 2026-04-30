# Reference: WebGPU performance update

This document matches the **release flow** (terminal **`scripts/release-commit.sh`** or dev **`http://localhost:5173/stratum/update`**): you enter **summary first**, then **full changelog**; the tool inserts `[Summary]` / `[Changes]` and sets the commit **subject** to the version only. In the shell script, end each paste with a line that is exactly `###STRATUM_END###`.

---

## Example full commit (what Git — and the game — see)

After a release run for version `0.6.0-alpha.2`, `git log -1 --format=%B` would look like this (tags and layout are what Vite parses):

```text
0.6.0-alpha.2

[Summary]
This update focuses on WebGPU performance and steadier frame times on most platforms. We tightened the render path so busy scenes hitch less, and we kept a clean fallback when the GPU or browser cannot give us the fast path. Thank you for the reports that pointed us at the rough spots.

[Changes]
# Stratum — WebGPU performance & stability

(The rest matches the “Step 2” section in this file — headings, tables, lists, links, etc.)
```

The **first line** is the subject (version string only). Everything after the blank line is the body; the parser looks for `[Summary]` then `[Changes]`.

---

## Step 1 — Summary only (plain text; main menu card)

Use **plain sentences** here — the home “What’s New” card does not render Markdown.

Copy for practice (paste this into **step 1** of the release tool, then `###STRATUM_END###` on its own line):

```text
This update focuses on WebGPU performance and steadier frame times on most platforms. Thank you for the reports that pointed us at the rough spots.
```

---

## Step 2 — Full changelog only (`[Changes]` Markdown; “Read more” modal)

Everything **from the next line down** is what you would paste into **step 2** (then end with `###STRATUM_END###`). The tool wraps it under `[Changes]` for you — do **not** include `[Summary]` or `[Changes]` lines yourself in this paste.

# Stratum — WebGPU performance & stability

> **Hello, everyone!**  
> This update is all about **smoother play** on the machines most of you use every day. We have been listening to reports of hitching, uneven frame times, and the occasional “why is my fan doing that?” moment — and we think you are going to **feel** the difference.

We have put a lot of care into **WebGPU paths**, **how work is scheduled on the GPU**, and **how the game recovers** when the driver or browser is having a rough day. Thank you for your patience while we dug into traces and repro cases.

---

## At a glance

| Area | What changed |
|------|----------------|
| **Frame pacing** | Less stutter when lots of chunks or effects are on screen |
| **GPU fallback** | Cleaner behaviour when WebGPU is limited or unavailable |
| **Power use** | Fewer redundant passes → *cooler* laptops on long sessions |

---

## Highlights

1. **Smoother frame delivery** — pacing work is tuned so heavy scenes do not “stack” expensive work in a single frame as often.
2. **WebGPU-first, not WebGPU-only** — when the pipeline can use a fast path, it does; when it cannot, you still get a **predictable** experience instead of a mystery hitch.
3. **Composite & lighting** — several passes were reordered and tightened so the GPU spends less time waiting and more time drawing *your* world.

---

## Under the hood *(for the curious)*

We spent time in the **render graph** and **tonemap / composite** stages. A simplified picture of what the client used to feel like vs now:

```text
Before:  [scene] → [extra sync] → [composite] → … → hitch
After:   [scene] → [composite]  → steady frame budget
```

> **Note:** Exact numbers depend on your device, driver, and whether the browser exposes full WebGPU features — but the trend should be the same everywhere we tested. Curious about support? Have a look at the [WebGPU API overview on MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).

---

## Fixes & polish

- Reduced redundant **texture uploads** in a few hot paths.
- **Occlusion / lighting** data is handled more conservatively when the GPU is busy — fewer spikes when turning quickly.
- ~~An old debug path that could accidentally stay “hot” in some builds~~ **Removed** — should not affect players, but keeps builds honest.

---

## Known limitations

- [ ] First launch after a browser update may still **recompile shaders** once — that is normal.
- [x] Very old integrated GPUs may still prefer the non-WebGPU path; we continue to track reports.

---

## Thank you

Whether you are building a sky bridge, tunnelling for ore, or just vibing in the menu — **thank you** for playing Stratum. If something still feels off on *your* setup, let us know with your **OS, browser version, and GPU** so we can keep tightening things up.

**See you in the next patch.**

---

### Markdown cheat sheet (belongs in Step 2 only)

`#` / `##` / `###` headings · **bold** · *italic* · ~~strikethrough~~ · `` `inline code` `` · fenced ``` ``` blocks · `>` blockquotes · `-` / `*` lists · `1.` numbered · `---` rules · `[text](url)` links · `| tables |` · `- [ ]` / `- [x]` task lists
