# Changelog authoring

Stratum bakes player-facing notes from the latest commit body at build time (`git log -1 --format=%B`). Two tagged blocks:

**`[Summary]`** — one to three sentences, no markdown. Main menu "What's New" card. Keep it short.

**`[Changes]`** — full patch notes for the in-game modal. Real GFM markdown.

---

## How notes land

**Browser (dev only):** `npm run dev` → `http://localhost:5173/stratum/update`. Previews commit shape, can run version bump + `git add -A` + `git commit` as your local identity. Never ships. Optional token: `STRATUM_UPDATE_TOOL_TOKEN` in `.env.local` — adds `X-Stratum-Update-Token` check on POSTs. Skip it if you're solo. Nothing in the UI pushes; you push when ready.

**Terminal:** `scripts/release-commit.sh` or `release-commit.command`. Commit subject is the version string only (e.g. `0.6.0-alpha.3`).

---

## Voice

Flat list. No headers inside the notes unless it's a genuinely large update with distinct sections. No blockquote "beats." No narrative framing around individual fixes.

Each line is one thing that changed. Write it like you're telling a friend what you fixed — present tense, active, short. If a line has a little personality in it that's fine, but don't perform it.

**Target:** Minecraft Beta 1.8 changelog style. Every line starts with `+` or `-` or `*` and just says the thing.

Added desert biome width tuning — fewer razor-thin sand strips
Doors now use the correct wood type on the top half in multiplayer


Fixed light seams at chunk edges near doors
Fixed shift-quick-move double-flash on the destination slot


That's it. No "Lighting you can trust." No `## Doors` subheader. No `> In multiplayer, the top half of a door could...`

**Bad habits to kill:**
- Wrapping a single bug fix in a paragraph that explains why it mattered
- Section headers for three-line updates
- "should feel better now" / "you can trust" / "for everyone" — filler
- Bullets that could apply to any game

---

## `[Summary]` vs `[Changes]`

**`[Summary]`** — tweet length, no markdown. If you need formatting here you're in the wrong field.

**`[Changes]`** — the flat list. Headings are allowed for genuinely large feature drops (like Update Aquatic). Otherwise just the list.

---

## Markdown (in-game renderer)

GFM via `marked` + `dompurify`. Headings, bold, lists, blockquotes, inline code, fenced code, tables, and `---` rules all work. Raw HTML is stripped.

---

## Discord / GitHub / in-game

Same commit, three surfaces. The flat list reads well everywhere. Tables are flaky in Discord — avoid for must-read lines.

CI webhook: `DISCORD_WEBHOOK_URL_CHANGELOG`. Toggle posting with `DISCORD_CHANGELOG_POST = true`.

---

## If you're an LLM

Use `+` / `-` / `*` lines. One thing per line. No section headers unless the update is large enough to genuinely need them. No blockquote narrative. No "X you can trust" phrasing. Don't pad a three-fix patch into a story. Check what actually shipped before writing anything.