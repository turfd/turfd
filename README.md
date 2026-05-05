# Stratum

**Stratum** is a sandbox side-scrolling game you play in the browser: dig, build, craft, explore procedural worlds, and play alone or with friends over peer-to-peer multiplayer.

---

## For players

### What you can do

- **Survive and build** — break and place blocks, craft tools and stations, manage inventory.
- **Light and atmosphere** — day/night, weather, torches and lighting that reacts to the world.
- **Multiplayer** — host or join a room (sign-in hosts new games; friends join with a room code when available).
- **Mods** — install behavior/resource packs from the workshop when Supabase is configured.
- **Saves** — worlds live in your browser (IndexedDB); you can export and share save files.

### Browser support

Stratum targets **modern desktop and mobile browsers**. It uses **WebGPU** when the browser exposes it for smoother rendering and falls back to **WebGL** when WebGPU is unavailable or fails to initialize. For the best experience, use an up-to-date **Chrome**, **Edge**, or **Safari**.

### Hosted build

Deployments use the Vite `base` path `/stratum/`. If your copy is deployed to GitHub Pages, open:

`https://<your-username>.github.io/stratum/stratum/`  
(adjust host and repo name if your fork differs.)

### Privacy and accounts

Online features (profiles, workshop, room relay) need **Supabase** credentials bundled at build time. Without them the game runs in **offline** mode with workshop and hosted relay disabled. See **Environment variables** below.

---

## For developers

### Prerequisites

- **Node.js** 20+ recommended (matches current `@types/node` and tooling).
- **npm** (or another client that respects `package-lock.json` if present).

### Clone and run locally

```bash
git clone https://github.com/<org>/<repo>.git
cd stratum
npm install
npm run dev
```

The dev server listens on **port 5173** with `strictPort: true`. Open:

`http://localhost:5173/stratum/`  
(path must include `stratum` because `vite.config.ts` sets `base: '/stratum/'`.)

### Build and preview production output

```bash
npm run build    # Typecheck (tsc --noEmit) + Vite bundle
npm run preview  # Serve the production build locally
```

### Environment variables

Create **`.env.local`** in the project root (gitignored):

```env
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

Optional dev-only token for bundled update tooling (see `vite.config.ts`):

```env
STRATUM_UPDATE_TOOL_TOKEN=...
```

Discord changelog **images** are defined only in **[`scripts/discordChangelogImageUrls.ts`](scripts/discordChangelogImageUrls.ts)** (HTTPS URLs in git). The webhook sends a **banner** embed (`headerImageUrl`), then a **bottom** embed with the large image (`mainEmbedImageUrl`) and the same **`[Summary]` / `[Changes]`** text Discord can render (`title` + `description` on that embed, under the image). Set **`omitTextOnMainImageEmbed`** there only if the bottom card must be image-only. Optional **`footerImageUrl`** adds another image embed after the bottom card. Clear **`mainEmbedImageUrl`** to use text-only body embeds (plus banner/footer images if set). The **`/stratum/update`** dev preview omits the bottom image URL so the Discord column stays live-text; optional `DISCORD_CHANGELOG_EMBED_COLOR` in `.env.local` (decimal RGB, e.g. `3447003`).

### Discord changelog on GitHub Actions

After each successful **`main`** build, the **Deploy to GitHub Pages** workflow can POST the same `[Summary]` / `[Changes]` text embedded in the app to Discord.

1. Add repository **secret** `DISCORD_WEBHOOK_URL_CHANGELOG` (your Discord webhook URL).  
2. Enable posting: repository **variable** *or* **secret** `DISCORD_CHANGELOG_POST` set to exactly `true` (only after the webhook secret exists). Prefer **Variables** — it is not sensitive.  
3. Optional **secret** `DISCORD_CHANGELOG_EMBED_COLOR` (decimal RGB, e.g. `3447003`). Banner / footer / main-embed images are set in **[`scripts/discordChangelogImageUrls.ts`](scripts/discordChangelogImageUrls.ts)** only.  
4. Optional **variable** *or* **secret** `DISCORD_CHANGELOG_DEDUPE_BUSTER` — change its value to invalidate the dedupe cache and allow a repost for the same notes.

Posting is **deduped** with `actions/cache` so identical version + notes do not spam on every rebuild. Failures to Discord do not fail the Pages deploy (`continue-on-error`).

**If the site deploys but Discord stays empty:** expand **Discord changelog — is posting enabled?** If posting is disabled, **`DISCORD_CHANGELOG_POST`** is missing or not exactly `true` on the **Variables** or **Secrets** tab (GitHub does not read a secret when the workflow only referenced `vars`). If posting is enabled, open **Post Discord changelog** (webhook errors). **Discord changelog skipped (dedupe)** means the digest matched a prior run — bump **`DISCORD_CHANGELOG_DEDUPE_BUSTER`** (variable or secret). Add **`DISCORD_WEBHOOK_URL_CHANGELOG`** if needed. The job uses a **full git fetch** for release-note discovery.

Optional: show **Settings → Debug** (in-game profiler). Read at **build** time:

```env
DEV_MODE=TRUE
```

### Useful scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Preview production build |
| `npm run perf:preview` | Build then preview (profiling workflows) |
| `npm run knip` | Find unused exports / dead files (`knip.json`) |
| `npm run changelog:discord` | POST current git release notes to Discord (`DISCORD_WEBHOOK_URL_CHANGELOG` required) |
| `npm run changelog:discord:dedupe-key` | Print the CI dedupe hash for the current repo state |

### Project layout (short)

Application code lives under **`src/`**: `core/` (loop, constants, types), `world/` (chunks, generation, lighting, water), `entities/` (player, mobs, projectiles), `renderer/` (Pixi pipeline, lighting composite), `network/` (PeerJS binary protocol), `ui/` (DOM + overlays), `mods/` & `persistence/` (packs and saves).

For contributors and AI-assisted work, **`docs/agents.md`** is the detailed architecture reference (dependency rules, renderer WebGPU/WebGL parity, protocol overview).

---

## Technologies and stack

| Area | Choices |
|------|---------|
| **Language** | TypeScript (strict) |
| **Build** | Vite 6 |
| **Runtime graphics** | **PixiJS v8** — WebGPU-first init, WebGL fallback; custom shaders as paired **WGSL + GLSL** where needed |
| **Workers** | ES module workers for off-main-thread world generation (Vite `import.meta.url` worker URLs) |
| **Networking** | **PeerJS** (WebRTC P2P) + optional **Supabase** for signaling / workshop / profiles |
| **Persistence** | **IndexedDB** via **`idb`**; gzip via **`fflate`** for exports |
| **Validation** | **Zod** for mod JSON schemas |
| **Math / noise** | **`simplex-noise`** |
| **Security / Markdown** | **DOMPurify**, **Marked** (UI-facing content) |
| **Icons** | **Font Awesome** (bundled subset) |

Key runtime libraries: `@supabase/supabase-js`, `peerjs`, `pixi.js`, `zod`, `idb`, `fflate`, `jsonc-parser`.

---

## Documentation

| Doc | Audience |
|-----|----------|
| `docs/agents.md` | Architects and contributors — systems, conventions, renderer notes |
| `changelogs/` | Release note drafts and reference copy for versioning |
| `tools/release/` | Dev-only release UI (`/stratum/update` when `npm run dev` runs with a `.git` checkout) |
| `scripts/release-commit.sh` | Scripted release workflow for maintainers |

---

## Contributing

1. Fork and branch from the default branch.  
2. Run `npm run build` before opening a PR (typecheck + bundle).  
3. Match existing style: named exports only, branded IDs where used, constants in `src/core/constants.ts`, no `any`/blind casts for new code.

Issues and reproduction steps are welcome; include **OS, browser version, and GPU** when reporting rendering or perf problems.
