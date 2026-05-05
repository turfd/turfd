/**
 * Procedural side-view dungeon generator (stratum-structure-v1).
 * Palette + feel inspired by structures/dungeon.structure.json — not a copy of its layout.
 *
 * World convention: `wy` increases **upward**. Structure `y` matches `wy` offset, so **smaller y**
 * is lower in the world (support / floor is at `y - 1`), **larger y** is higher (headroom at `y + 1`).
 *
 *   npx tsx scripts/genDungeonProcedural.ts
 *   npx tsx scripts/genDungeonProcedural.ts 424242
 *
 * Second arg: integer seed (optional).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseStructureJson } from "../src/world/structure/structureSchema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(
  ROOT,
  "public/assets/mods/behavior_packs/stratum-core/structures/dungeon_gen.structure.json",
);

const W = 81;
const H = 33;
const MARGIN = 1; // unbroken stone ring at edges (x/y 0 and W-1 / H-1)

type Cell = {
  fg: string;
  fgMeta: number;
  bg: string;
  bgMeta: number;
};

const AIR = "stratum:air";
const STONE = "stratum:stone";
const BRICK = "stratum:stone_bricks";
const CHISEL = "stratum:chiseled_stone_bricks";
const COBBLE = "stratum:cobblestone";
const DIRT = "stratum:dirt";
const COAL = "stratum:coal_ore";
const LADDER = "stratum:ladder";
const TORCH = "stratum:torch";
const CHEST = "stratum:chest";
const BARREL = "stratum:barrel";
const SPAWNER = "stratum:spawner";

const CHEST_SLOTS = 18;

const LOOT_CHEST_T1 = "stratum:chest_t1";
const LOOT_CHEST_T2 = "stratum:chest_t2";
const LOOT_BARREL_T1 = "stratum:barrel_t1";
const LOOT_BARREL_T2 = "stratum:barrel_t2";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function irand(r: () => number, a: number, b: number): number {
  return a + Math.floor(r() * (b - a + 1));
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}

function carveRect(
  g: Cell[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: () => number,
): void {
  const xa = Math.max(MARGIN, Math.min(x0, x1));
  const xb = Math.min(W - MARGIN - 1, Math.max(x0, x1));
  const ya = Math.max(MARGIN, Math.min(y0, y1));
  const yb = Math.min(H - MARGIN - 1, Math.max(y0, y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      g[y]![x]!.fg = AIR;
      g[y]![x]!.fgMeta = 0;
      const u = r();
      if (u < 0.42) {
        g[y]![x]!.bg = BRICK;
      } else if (u < 0.68) {
        g[y]![x]!.bg = COBBLE;
      } else if (u < 0.82) {
        g[y]![x]!.bg = STONE;
      } else if (u < 0.96) {
        g[y]![x]!.bg = CHISEL;
      } else {
        g[y]![x]!.bg = DIRT;
      }
      g[y]![x]!.bgMeta = 0;
    }
  }
}

/**
 * Axis-aligned L corridor (no diagonal stepping): horizontal band at constant y, then vertical shaft.
 * Structure y matches world wy: smaller y = lower in world = floor / ground.
 */
function carveCorridorAxisAligned(
  g: Cell[][],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: () => number,
): void {
  const airRows = 3;
  const halfW = 2;
  // Horizontal run at the lower-wy room's center y (smaller index = deeper), so floors stay flat.
  const yH = Math.min(ay, by);
  const xLo = Math.min(ax, bx);
  const xHi = Math.max(ax, bx);
  carveRect(g, xLo - halfW, yH, xHi + halfW, yH + airRows - 1, r);
  const yV0 = Math.min(yH, by);
  const yV1 = Math.max(yH, by);
  const xV = bx;
  if (yV0 < yV1) {
    carveRect(g, xV - 1, yV0, xV + 1, yV1, r);
  }
  void r;
}

type Pt = { x: number; y: number };

type RoomBox = { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number };

function roomArea(room: RoomBox): number {
  return (room.x1 - room.x0 + 1) * (room.y1 - room.y0 + 1);
}

function inRoomInterior(p: Pt, room: RoomBox, pad: number): boolean {
  return (
    p.x >= room.x0 + pad &&
    p.x <= room.x1 - pad &&
    p.y >= room.y0 + pad &&
    p.y <= room.y1 - pad
  );
}

function pointInAnyRoomInterior(p: Pt, rooms: readonly RoomBox[], pad: number): boolean {
  return rooms.some((rm) => inRoomInterior(p, rm, pad));
}

function floorCandidatesInRoom(g: Cell[][], room: RoomBox): Pt[] {
  const out: Pt[] = [];
  // Include room.y0: lowest carved row is where air meets exterior floor (wy increases upward).
  for (let y = room.y0; y <= room.y1 - 1; y++) {
    for (let x = room.x0 + 1; x <= room.x1 - 1; x++) {
      if (canPlaceChestOrSpawner(g, x, y)) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function pickWellSpread(
  g: Cell[][],
  cands: Pt[],
  need: number,
  minDist: number,
  r: () => number,
): Pt[] {
  const sh = [...cands].sort(() => r() - 0.5);
  const chosen: Pt[] = [];
  for (const p of sh) {
    if (chosen.length >= need) {
      break;
    }
    if (!canPlaceChestOrSpawner(g, p.x, p.y)) {
      continue;
    }
    if (chosen.every((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) >= minDist)) {
      chosen.push(p);
    }
  }
  return chosen;
}

function mstEdges(pts: Pt[], r: () => number): Array<[number, number]> {
  const n = pts.length;
  if (n <= 1) {
    return [];
  }
  const edges: Array<{ i: number; j: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = pts[i]!;
      const b = pts[j]!;
      const w = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + r() * 0.01;
      edges.push({ i, j, w });
    }
  }
  edges.sort((a, b) => a.w - b.w);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const out: Array<[number, number]> = [];
  for (const e of edges) {
    const pi = find(e.i);
    const pj = find(e.j);
    if (pi !== pj) {
      parent[pi] = pj;
      out.push([e.i, e.j]);
    }
  }
  return out;
}

function addFloorsAndWalls(g: Cell[][]): void {
  // wy increases upward: support for air at (x,y) is the cell at LOWER wy = (x, y - 1).
  for (let y = MARGIN; y < H - MARGIN; y++) {
    for (let x = MARGIN; x < W - MARGIN; x++) {
      const c = g[y]![x]!;
      if (c.fg !== AIR) {
        continue;
      }
      const support = g[y - 1]?.[x];
      if (support !== undefined && support.fg === STONE) {
        support.fg = BRICK;
        support.fgMeta = 0;
      }
    }
  }
  for (let y = MARGIN; y < H - MARGIN; y++) {
    for (let x = MARGIN; x < W - MARGIN; x++) {
      const c = g[y]![x]!;
      if (c.fg !== STONE) {
        continue;
      }
      const neigh = [
        g[y - 1]?.[x]?.fg,
        g[y + 1]?.[x]?.fg,
        g[y]?.[x - 1]?.fg,
        g[y]?.[x + 1]?.fg,
      ];
      if (neigh.some((v) => v === AIR)) {
        c.fg = BRICK;
        c.fgMeta = 0;
      }
    }
  }
}

function sprinkleWallOre(g: Cell[][], r: () => number): void {
  for (let y = MARGIN; y < H - MARGIN; y++) {
    for (let x = MARGIN; x < W - MARGIN; x++) {
      const c = g[y]![x]!;
      if (c.fg !== BRICK && c.fg !== STONE) {
        continue;
      }
      if (r() < 0.035) {
        c.fg = COAL;
        c.fgMeta = 0;
      }
    }
  }
}

function solidWallForTorch(c: Cell): boolean {
  return c.fg !== AIR && c.fg !== TORCH && c.fg !== LADDER;
}

function placeTorches(g: Cell[][], r: () => number): void {
  for (let y = MARGIN + 1; y < H - MARGIN - 1; y++) {
    for (let x = MARGIN + 1; x < W - MARGIN - 1; x++) {
      const c = g[y]![x]!;
      if (c.fg !== AIR) {
        continue;
      }
      const left = g[y]![x - 1]!;
      const right = g[y]![x + 1]!;
      const towardSky = g[y + 1]![x]!;
      const wallL = solidWallForTorch(left);
      const wallR = solidWallForTorch(right);
      if (towardSky.fg !== AIR) {
        continue;
      }
      // Wall-mounted only (exactly one solid side), avoids free-floating torches in open halls.
      if ((wallL !== wallR) && r() < 0.1) {
        c.fg = TORCH;
        c.fgMeta = 0;
      }
    }
  }
}

function carveLadderShaft(g: Cell[][], cx: number, y0: number, y1: number, r: () => number): void {
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  carveRect(g, cx - 1, ya, cx + 1, yb, r);
  for (let y = ya; y <= yb; y++) {
    const m = g[y]![cx]!;
    if (m.fg === AIR) {
      m.fg = LADDER;
      m.fgMeta = 0;
    }
  }
}

function collectAirCells(g: Cell[][]): Pt[] {
  const pts: Pt[] = [];
  for (let y = MARGIN; y < H - MARGIN; y++) {
    for (let x = MARGIN; x < W - MARGIN; x++) {
      if (g[y]![x]!.fg === AIR) {
        pts.push({ x, y });
      }
    }
  }
  return pts;
}

function canPlaceChestOrSpawner(g: Cell[][], x: number, y: number): boolean {
  const c = g[y]?.[x];
  if (c === undefined || c.fg !== AIR) {
    return false;
  }
  const floor = g[y - 1]?.[x];
  if (floor === undefined || floor.fg === AIR || floor.fg === TORCH || floor.fg === LADDER) {
    return false;
  }
  const head = g[y + 1]?.[x];
  if (head === undefined || head.fg !== AIR) {
    return false;
  }
  return true;
}

function nullItems(): null[] {
  return Array.from({ length: CHEST_SLOTS }, () => null);
}

function buildStructure(seed: number): object {
  const r = mulberry32(seed >>> 0);
  const g: Cell[][] = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => ({
      fg: STONE,
      fgMeta: 0,
      bg: STONE,
      bgMeta: 0,
    })),
  );

  const rooms: RoomBox[] = [];
  const nRooms = irand(r, 6, 9);
  for (let i = 0; i < nRooms; i++) {
    const rw = i === 0 ? irand(r, 22, 32) : irand(r, 10, 18);
    const rh = i === 0 ? irand(r, 8, 13) : irand(r, 5, 9);
    const x0 = irand(r, MARGIN + 3, W - MARGIN - rw - 4);
    // Bias one chamber toward the top so the shell is not only a solid cap (side-view habitability).
    const yLo = i === 0 ? MARGIN + 2 : MARGIN + 4;
    const yHi = i === 0 ? MARGIN + 11 : H - MARGIN - rh - 4;
    const y0 = irand(r, yLo, Math.max(yLo, yHi));
    const x1 = x0 + rw - 1;
    const y1 = y0 + rh - 1;
    carveRect(g, x0, y0, x1, y1, r);
    rooms.push({ x0, y0, x1, y1, cx: (x0 + x1) >> 1, cy: (y0 + y1) >> 1 });
  }

  const centers = rooms.map((q) => ({ x: q.cx, y: q.cy }));
  for (const [ia, ib] of mstEdges(centers, r)) {
    const a = centers[ia]!;
    const b = centers[ib]!;
    carveCorridorAxisAligned(g, a.x, a.y, b.x, b.y, r);
  }

  const shaftX = irand(r, 18, 28);
  carveLadderShaft(g, shaftX, irand(r, 6, 10), irand(r, H - 12, H - 5), r);
  const shaftX2 = irand(r, 52, 68);
  if (Math.abs(shaftX2 - shaftX) > 8) {
    carveLadderShaft(g, shaftX2, irand(r, 5, 9), irand(r, H - 14, H - 6), r);
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
        const c = g[y]![x]!;
        c.fg = STONE;
        c.bg = STONE;
        c.fgMeta = 0;
        c.bgMeta = 0;
      }
    }
  }

  addFloorsAndWalls(g);
  sprinkleWallOre(g, r);

  const entities: object[] = [];
  const used = new Set<string>();

  const airPts = collectAirCells(g);
  const shuffled = [...airPts].sort(() => r() - 0.5);

  const tryPlace = (x: number, y: number, e: object): boolean => {
    const k = `${x},${y}`;
    if (used.has(k) || !canPlaceChestOrSpawner(g, x, y)) {
      return false;
    }
    used.add(k);
    entities.push(e);
    return true;
  };

  const byArea = [...rooms].sort((a, b) => roomArea(b) - roomArea(a));
  const arena = byArea[0]!;
  if (roomArea(arena) >= 48) {
    const arenaFloor = floorCandidatesInRoom(g, arena);
    let trio = pickWellSpread(g, arenaFloor, 3, 7, r);
    if (trio.length < 3) {
      trio = pickWellSpread(g, arenaFloor, 3, 4, r);
    }
    if (trio.length < 3) {
      trio = pickWellSpread(g, arenaFloor, 3, 3, r);
    }
    for (const p of trio) {
      const mob = pick(r, [["zombie"], ["zombie"], ["zombie"], ["slime"]] as const);
      tryPlace(p.x, p.y, {
        type: "spawner",
        x: p.x,
        y: p.y,
        state: {
          delay: 350,
          maxCount: 6,
          playerRange: 12,
          spawnRange: 5,
          spawnPotentials: mob,
          nextSpawnAtWorldTimeMs: 0,
        },
      });
    }
  }
  const lootRot = [LOOT_CHEST_T1, LOOT_CHEST_T2, LOOT_BARREL_T1, LOOT_BARREL_T2] as const;
  let lootI = 0;
  for (const p of shuffled) {
    if (entities.filter((o) => (o as { type: string }).type === "container").length >= 16) {
      break;
    }
    if (!canPlaceChestOrSpawner(g, p.x, p.y)) {
      continue;
    }
    const inRoom = pointInAnyRoomInterior(p, rooms, 1);
    if (r() > (inRoom ? 0.24 : 0.06)) {
      continue;
    }
    const loot = lootRot[lootI++ % lootRot.length]!;
    const isBarrel = loot.includes("barrel");
    tryPlace(p.x, p.y, {
      type: "container",
      x: p.x,
      y: p.y,
      identifier: isBarrel ? BARREL : CHEST,
      lootTable: loot,
      items: nullItems(),
    });
  }

  for (const e of entities) {
    const t = (e as { type: string }).type;
    if (t === "container") {
      const c = e as { x: number; y: number; identifier: string };
      const cell = g[c.y]![c.x]!;
      cell.fg = c.identifier;
      cell.fgMeta = 0;
    } else if (t === "spawner") {
      const c = e as { x: number; y: number };
      const cell = g[c.y]![c.x]!;
      cell.fg = SPAWNER;
      cell.fgMeta = 0;
    }
  }

  placeTorches(g, r);

  const blocks: object[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = g[y]![x]!;
      blocks.push({
        x,
        y,
        foreground: { identifier: c.fg, metadata: c.fgMeta },
        background: { identifier: c.bg, metadata: c.bgMeta },
      });
    }
  }

  return {
    format: "stratum-structure-v1",
    exportedAt: new Date().toISOString(),
    world: {
      uuid: "00000000-0000-4000-8000-000000000001",
      name: `Procedural dungeon (seed ${seed})`,
      seed,
      gameMode: "sandbox",
    },
    selection: {
      start: { wx: 0, wy: 0 },
      end: { wx: W - 1, wy: H - 1 },
      bounds: { minWx: 0, minWy: 0, maxWx: W - 1, maxWy: H - 1 },
      size: { width: W, height: H },
    },
    blocks,
    tileEntities: { entities },
  };
}

const seedArg = process.argv[2];
const seed = seedArg !== undefined ? Number.parseInt(seedArg, 10) : 900001;
if (!Number.isFinite(seed)) {
  console.error("Invalid seed");
  process.exit(1);
}

const payload = buildStructure(seed);
parseStructureJson(payload);
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log("Wrote", OUT, "seed", seed);
