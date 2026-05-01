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

### Useful scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server with HMR |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Preview production build |
| `npm run perf:preview` | Build then preview (profiling workflows) |
| `npm run knip` | Find unused exports / dead files (`knip.json`) |

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
| `scripts/release-commit.sh` | Scripted release workflow for maintainers |

---

## Contributing

1. Fork and branch from the default branch.  
2. Run `npm run build` before opening a PR (typecheck + bundle).  
3. Match existing style: named exports only, branded IDs where used, constants in `src/core/constants.ts`, no `any`/blind casts for new code.

Issues and reproduction steps are welcome; include **OS, browser version, and GPU** when reporting rendering or perf problems.
