# Authoring Stratum changelogs (for humans & AI assistants)

Stratum reads player-facing notes from **the latest commit** at build time (`git log -1 --format=%B`). The commit **body** must contain tagged sections:

1. **`[Summary]`** — short text for the main menu “What’s New” card.  
2. **`[Changes]`** — full Markdown for the “Read more” modal.

You can ship notes in two ways:

1. **Web (dev server only)** — With `npm run dev`, open **`http://localhost:5173/stratum/update`** (or `/update`, which redirects). The UI previews the same commit layout and can run **`npm version` + `git add -A` + `git commit`** using **your** local Git user/email. It is **not** included in production builds and only answers on **localhost**. Optional hardening: set **`STRATUM_UPDATE_TOOL_TOKEN`** in **`.env.local`** (see `update-tool.env.example`), restart dev, then paste the same value in the **only-if-shown** field on the update page so POSTs carry **`X-Stratum-Update-Token`**. Skip this if you work alone on localhost—the UI hides the field when the env var is unset. Nothing is **pushed** from the tool; push stays in your terminal.

2. **Terminal** — `scripts/release-commit.sh` or **`release-commit.command`** asks for the summary first, then the full changelog, and **inserts `[Summary]` / `[Changes]`** for you (`scripts/readReleaseNotesFromGit.ts`). The commit **subject** is only the new **version string** (e.g. `0.6.0-alpha.3`).

This file is **committed** so every clone has the standard. Optionally create a **gitignored** root file `changelog-cursor-authoring.md` for project-specific tone overlays (see `.gitignore`).

---

## Tone: “console patch notes” (4J-style inspiration)

- **Warm opening** — greet players; sound pleased to ship the work, not corporate.
- **Plain language first** — what players *feel* (smoother, faster, fewer crashes), then optional technical detail in a clearly labelled section.
- **Structured skim** — headings, tables, dividers, numbered “highlights” so a quick scroll tells the story.
- **Gratitude** — short thank-you; invite feedback with concrete fields (platform, browser, GPU) when relevant.
- **Playful but professional** — light humour is fine; avoid snark at players or competitors.

Avoid: fake version numbers in reference docs meant as templates; inside real `[Changes]`, do not promise features that are not in the build.

---

## Markdown standard (must match in-game renderer)

The modal uses **GitHub-flavoured Markdown** (`marked` + `dompurify`). Use any of the following freely in `[Changes]`:

| Feature | Syntax |
|--------|--------|
| Headings | `#` `##` `###` |
| Emphasis | `**bold**` `*italic*` `~~strike~~` |
| Lists | `-` / `*` bullets, `1.` numbered, nested indent |
| Links | `[label](https://…)` — opens in a new tab |
| Quotes | `>` blockquote |
| Code | `` `inline` `` and ` ```lang ` fenced blocks |
| Tables | `| col |` GFM tables |
| Rules | `---` on its own line |
| Tasks | `- [ ]` / `- [x]` (display-only checkboxes) |

**Do not** rely on raw HTML in changelogs — it is stripped for safety.

---

## Discord, GitHub, and in-game (one source)

- **Source of truth** is still the git commit **`[Summary]`** / **`[Changes]`** body. The production build embeds that text in the client; CI can POST the same text to Discord using the shared embed builder (`scripts/discordChangelogEmbeds.ts`).
- **Write for a common baseline**: headings (`#` / `##` / `###`), `**bold**`, lists, `>` quotes, `` `inline` ``, fenced code, and links `[text](https://…)` work well in-game (GFM) and in Discord embed descriptions. GFM **horizontal rules** (`---` on its own line) become a real rule in the in-game modal; for Discord-only delivery they are turned into a **short line of ASCII hyphens** so separators stay visible where Discord has no `<hr>`.
- **Tables** render in-game; Discord may render them inconsistently—prefer bullet lists for must-read facts if you post to Discord.
- **Dev preview**: with `npm run dev`, **`http://localhost:5173/stratum/update`** shows an **in-game GFM** column and a **Discord-style** column; both **refresh as you type** (debounced). The Discord column uses the same **embed builder** as the webhook but **always includes live markdown** descriptions so edits are visible. **Banner / footer** images still come from **`scripts/discordChangelogImageUrls.ts`**. The **`mainEmbedImageUrl`** graphic is **not** shown in the tool (it is static); CI / `postDiscordChangelog.ts` still post **image-only** embeds when that URL is set. Optional `.env.local`: `DISCORD_CHANGELOG_EMBED_COLOR` (decimal RGB) for the preview stripe.
- **CI / Supabase naming**: store the webhook as **`DISCORD_WEBHOOK_URL_CHANGELOG`** (GitHub Actions repository secret and/or Supabase secret). Enable posting by setting GitHub repository variable **`DISCORD_CHANGELOG_POST`** to `true` after the secret is set. Optional **`DISCORD_CHANGELOG_DEDUPE_BUSTER`** repository variable (any string) bumps the dedupe key if you need to force a repost for the same notes.

---

## Reference specimen

See [`REFERENCE_WEBGPU_PERFORMANCE_UPDATE.md`](REFERENCE_WEBGPU_PERFORMANCE_UPDATE.md) in this folder: copy its structure and richness when drafting real ship notes (replace content, keep the *shape*).

---

## `[Summary]` vs `[Changes]`

- **`[Summary]`** — 1–3 short sentences, **plain text** in the UI (no Markdown rendering on the home card). Write like a tweet or storefront blurb.
- **`[Changes]`** — full Markdown as above; this is the canonical “patch notes” view.
