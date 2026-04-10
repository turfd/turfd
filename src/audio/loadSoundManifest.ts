/**
 * Loads block SFX from `sound_manifest.json` in resource packs (paths relative to pack root).
 *
 * Each event (`step`, `jump`, `break`, `place`, optional `dig`) may be a **single path string** or a **non-empty array**
 * of paths; arrays load as `baseName_0`, `baseName_1`, … and `playSfx(baseName)` picks one at random.
 */
import { z } from "zod";
import type { AudioEngine } from "./AudioEngine";

const pathOrPaths = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

const soundSetEntrySchema = z
  .object({
    step: pathOrPaths,
    jump: pathOrPaths,
    "break": pathOrPaths,
    place: pathOrPaths,
    /** Mining / crack-stage hits (optional per material). */
    dig: pathOrPaths.optional(),
    /** Block interaction (e.g. door/chest/furnace UI); loaded as `open_<setId>`. */
    open: pathOrPaths.optional(),
    close: pathOrPaths.optional(),
  })
  .strict();

const damageEntrySchema = z
  .object({
    fall_big: pathOrPaths.optional(),
    fall_small: pathOrPaths.optional(),
    hit: pathOrPaths.optional(),
  })
  .strict();

const uiEntrySchema = z
  .object({
    /** World pickup when a dropped stack merges into the inventory (e.g. `sounds/random/pop.ogg`). */
    item_pickup: pathOrPaths.optional(),
    /**
     * Rain ambience: string or array of loops; {@link AudioEngine.startSfxRainDualAmbient} plays two at once
     * and {@link AudioEngine.refreshSfxRainDualAmbient} picks new random variants (see game refresh interval).
     */
    weather_rain_ambient: pathOrPaths.optional(),
    /**
     * Lightning / thunder one-shots: array → `weather_lightning` variant group for `playSfx("weather_lightning")`.
     */
    weather_lightning: pathOrPaths.optional(),
    /** Enter/exit water: `playSfx("water_splash")`. */
    water_splash: pathOrPaths.optional(),
    /** Swimming strokes while moving in water: `playSfx("water_swim")`. */
    water_swim: pathOrPaths.optional(),
    /** Sheep idle bleats (`playSfx("entity_sheep_idle")`). */
    entity_sheep_idle: pathOrPaths.optional(),
    /** Sheep footstep variants (`playSfx("entity_sheep_step")`). */
    entity_sheep_step: pathOrPaths.optional(),
    /** Pig idle grunts (`playSfx("entity_pig_idle")`). */
    entity_pig_idle: pathOrPaths.optional(),
    /** Pig footstep variants (`playSfx("entity_pig_step")`). */
    entity_pig_step: pathOrPaths.optional(),
    /** Pig death one-shot (`playSfx("entity_pig_death")`). */
    entity_pig_death: pathOrPaths.optional(),
  })
  .strict();

const soundManifestSchema = z
  .object({
    format_version: z.literal("1.0.0"),
    sets: z.record(z.string(), soundSetEntrySchema),
    /** Player damage / fall (optional). */
    damage: damageEntrySchema.optional(),
    /** Non-block UI / feedback (optional). */
    ui: uiEntrySchema.optional(),
  })
  .strict();

export type SoundManifestJson = z.infer<typeof soundManifestSchema>;

function joinPackUrl(packBaseUrl: string, relativePath: string): string {
  const base = packBaseUrl.endsWith("/") ? packBaseUrl : `${packBaseUrl}/`;
  const rel = relativePath.replace(/^\//, "");
  return `${base}${rel}`;
}

async function loadPathOrPaths(
  audio: AudioEngine,
  packBaseUrl: string,
  baseName: string,
  pathOrPaths: string | readonly string[],
): Promise<void> {
  if (typeof pathOrPaths === "string") {
    await audio.loadSfx(baseName, joinPackUrl(packBaseUrl, pathOrPaths));
    return;
  }
  await Promise.all(
    pathOrPaths.map((rel, i) =>
      audio.loadSfx(`${baseName}_${i}`, joinPackUrl(packBaseUrl, rel)),
    ),
  );
  audio.registerSfxVariantGroup(baseName, pathOrPaths.length);
}

/**
 * Loads every file in the manifest into `AudioEngine` buffers named
 * `step_<setId>`, `jump_<setId>`, `break_<setId>`, `place_<setId>`, `dig_<setId>` when present,
 * or with `_0`, `_1`, … suffixes when the manifest lists an array of files for that event.
 */
async function loadSoundManifestJson(
  audio: AudioEngine,
  packBaseUrl: string,
  raw: unknown,
): Promise<void> {
  const manifest = soundManifestSchema.parse(raw);
  const jobs: Promise<void>[] = [];
  for (const [setId, paths] of Object.entries(manifest.sets)) {
    jobs.push(loadPathOrPaths(audio, packBaseUrl, `step_${setId}`, paths.step));
    jobs.push(loadPathOrPaths(audio, packBaseUrl, `jump_${setId}`, paths.jump));
    jobs.push(loadPathOrPaths(audio, packBaseUrl, `break_${setId}`, paths["break"]));
    jobs.push(loadPathOrPaths(audio, packBaseUrl, `place_${setId}`, paths.place));
    if (paths.dig !== undefined) {
      jobs.push(loadPathOrPaths(audio, packBaseUrl, `dig_${setId}`, paths.dig));
    }
    if (paths.open !== undefined) {
      jobs.push(loadPathOrPaths(audio, packBaseUrl, `open_${setId}`, paths.open));
    }
    if (paths.close !== undefined) {
      jobs.push(loadPathOrPaths(audio, packBaseUrl, `close_${setId}`, paths.close));
    }
  }
  const dmg = manifest.damage;
  if (dmg !== undefined) {
    if (dmg.fall_big !== undefined) {
      jobs.push(loadPathOrPaths(audio, packBaseUrl, "dmg_fall_big", dmg.fall_big));
    }
    if (dmg.fall_small !== undefined) {
      jobs.push(loadPathOrPaths(audio, packBaseUrl, "dmg_fall_small", dmg.fall_small));
    }
    if (dmg.hit !== undefined) {
      jobs.push(loadPathOrPaths(audio, packBaseUrl, "dmg_hit", dmg.hit));
    }
  }
  const ui = manifest.ui;
  if (ui?.item_pickup !== undefined) {
    jobs.push(loadPathOrPaths(audio, packBaseUrl, "item_pickup", ui.item_pickup));
  }
  if (ui?.weather_rain_ambient !== undefined) {
    jobs.push(
      loadPathOrPaths(
        audio,
        packBaseUrl,
        "weather_rain_ambient",
        ui.weather_rain_ambient,
      ),
    );
  }
  if (ui?.weather_lightning !== undefined) {
    jobs.push(
      loadPathOrPaths(
        audio,
        packBaseUrl,
        "weather_lightning",
        ui.weather_lightning,
      ),
    );
  }
  if (ui?.water_splash !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "water_splash", ui.water_splash),
    );
  }
  if (ui?.water_swim !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "water_swim", ui.water_swim),
    );
  }
  if (ui?.entity_sheep_idle !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "entity_sheep_idle", ui.entity_sheep_idle),
    );
  }
  if (ui?.entity_sheep_step !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "entity_sheep_step", ui.entity_sheep_step),
    );
  }
  if (ui?.entity_pig_idle !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "entity_pig_idle", ui.entity_pig_idle),
    );
  }
  if (ui?.entity_pig_step !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "entity_pig_step", ui.entity_pig_step),
    );
  }
  if (ui?.entity_pig_death !== undefined) {
    jobs.push(
      loadPathOrPaths(audio, packBaseUrl, "entity_pig_death", ui.entity_pig_death),
    );
  }
  await Promise.all(jobs);
}

export async function fetchAndLoadSoundManifest(
  audio: AudioEngine,
  packBaseUrl: string,
  manifestRelativePath: string,
): Promise<void> {
  const url = joinPackUrl(packBaseUrl, manifestRelativePath);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`fetchAndLoadSoundManifest: ${url} (${res.status})`);
    return;
  }
  const raw: unknown = await res.json();
  await loadSoundManifestJson(audio, packBaseUrl, raw);
}
