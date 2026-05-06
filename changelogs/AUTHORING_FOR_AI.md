# Changelog authoring

Stratum bakes player-facing notes from the latest commit body at build time (`git log -1 --format=%B`). Two tagged blocks:

**`[Summary]`** — one to three short sentences, plain text only (no markdown). This is the main menu "What's New" blurb.

**`[Changes]`** — full patch notes for the in-game modal. Real GFM markdown.

---

## How notes land

**Browser (dev only):** `npm run dev` → `http://localhost:5173/stratum/update` (plugin lives under `tools/release/`). Previews commit shape, can run version bump + `git add -A` + `git commit` as your local identity. Never ships. Optional token: `STRATUM_UPDATE_TOOL_TOKEN` in `.env.local` — adds `X-Stratum-Update-Token` on POSTs. Skip if you're solo. Nothing in the UI pushes; you push when ready.

**Terminal:** `scripts/release-commit.sh` or `release-commit.command`. Commit subject is the version string only (e.g. `0.6.0-alpha.3`).

---

## Voice

Flat list. No headers inside the notes unless it's a genuinely large update with distinct sections. No blockquote "beats." No narrative framing around individual fixes.

Each line is one thing that changed. Present tense, active voice, short. A little personality is fine; don't perform it.

**Plain language:** Say what changed in terms of behavior, look, or feel. You can name a concrete technique when it is the clearest way to say what shipped (e.g. lighting no longer uses ray tracing)—don't hide real behavior behind vague "feels better" lines. Avoid filler. If you must name a menu, "Video settings" or "Workshop" is enough.

**House style (prefer this shape):** Human-edited notes often read like patch notes, not marketing. Use the bullets in [`CHANGELOG_UNCOMMITTED.md`](CHANGELOG_UNCOMMITTED.md) as a live reference. Patterns:

- **Fixes:** `Fixed a bug where …` / `Fixed a bug which …` with a plain subject (renderer, chunks, mob spawners, host CPU).
- **Tuning:** `Adjusted …` for resolution, bloom, particle counts, performance knobs—not only "more" or "less" with no object.
- **Two beats one line:** Use a semicolon to pair the headline change with a second fact (`Stratite now; tools, drops, and worldgen match`).
- **Deferred UI:** When something is removed but planned later, add a short tail (`more on this later`).
- **Texture/content:** Short noun-phrase closers are fine (`Zombie texture adjustment`).

**Target:** Minecraft Beta 1.8 changelog spirit. Each change line starts with `-` (fix/change), `+` (addition), or `*` (tweak); one symbol, one space, then the line. Example:

+ Added desert biome width tuning — fewer razor-thin sand strips
- Doors now use the correct wood type on the top half in multiplayer
- Fixed light seams at chunk edges near doors
- Fixed shift-quick-move double-flash on the destination slot

That's it. No "Lighting you can trust." No `## Doors` subheader. No `> In multiplayer, the top half of a door could...`

**Bad habits to kill:**

- Wrapping a single bug fix in a paragraph about why it mattered
- Section headers for three-line updates
- "Should feel better now" / "you can trust" / "for everyone" — filler
- Lines so generic they could describe any game
- Vague performance claims with no subject ("runs better") when a specific fix or adjustment shipped

---

## `[Summary]` vs `[Changes]`

**`[Summary]`** — tweet length, no markdown. If you need formatting, put it in `[Changes]`.

**`[Changes]`** — the flat list. Headings only for genuinely large feature drops (think Update Aquatic scale). Otherwise just the list.

---

## Markdown (in-game renderer)

GFM via `marked` + `dompurify`. Headings, bold, lists, blockquotes, inline code, fenced code, tables, and `---` rules work. Raw HTML is stripped.

---

## Discord / GitHub / in-game

Same commit, three surfaces. The flat list reads well everywhere. Tables are flaky in Discord — avoid for must-read lines.

CI webhook: `DISCORD_WEBHOOK_URL_CHANGELOG`. Toggle posting with `DISCORD_CHANGELOG_POST = true`.

---

## If you're an LLM

Use `-` / `+` / `*` at the start of each change line (one item per line). No section headers unless the update truly needs them. No blockquote narrative. No "X you can trust." Don't inflate a tiny patch into a story. **Only describe what's in the commit** (and assets that ship with it)—not local-only or untracked experiments unless the human says they're releasing them. Match **House style** above (bug-fix wording, `Adjusted …`, semicolon pairs, deferred-feature tails when relevant).
