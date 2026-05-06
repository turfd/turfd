// Supabase Edge Function: crash-report
// Receives client crash payloads and forwards compact summaries to Discord.
// Discord embed combined character limit (title + description + all field names/values): 6000.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type CrashReportPayload = {
  crashId?: string;
  sessionId?: string;
  severity?: "crash" | "error";
  source?: string;
  message?: string;
  stack?: string;
  name?: string;
  url?: string;
  userAgent?: string;
  timestampIso?: string;
  build?: {
    appVersion?: string;
    buildId?: string;
    wireProtocol?: number;
    minWireProtocol?: number;
    mode?: string;
    production?: boolean;
  };
  diagnostics?: {
    viewportCss?: string;
    screenCss?: string;
    devicePixelRatio?: number;
    hardwareConcurrency?: number | null;
    deviceMemoryGb?: number | null;
    maxTouchPoints?: number;
    languages?: string;
    timeZone?: string;
    onLine?: boolean;
    webglVendor?: string;
    webglRenderer?: string;
    storageUsedMb?: number | null;
    storageQuotaMb?: number | null;
  };
  mods?: readonly { modId?: string; version?: string; name?: string }[];
  sim?: {
    tickIndex?: number | null;
    worldTimeMs?: number | null;
    playerBlockX?: number | null;
    playerBlockY?: number | null;
    roomFingerprint?: string | null;
  };
  context?: {
    worldName?: string | null;
    worldUuid?: string | null;
    networkRole?: string;
    lastCommand?: string | null;
    lastUiError?: string | null;
    lastRenderAtMs?: number | null;
    freezeThresholdMs?: number;
    visibilityState?: string;
    recentEvents?: string[];
  };
};

type DiscordField = { name: string; value: string; inline?: boolean };

const DISCORD_EMBED_TOTAL_MAX = 5800;
const DISCORD_FIELD_VALUE_MAX = 1024;
/** Leave headroom under Discord's 25-field cap (exactly 25 often returns 400 embeds[0]). */
const DISCORD_MAX_EMBED_FIELDS = 24;
const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 4096;
const MAX_STACK_FIELD_PARTS = 3;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function trunc(v: string, max: number): string {
  if (v.length <= max) {
    return v;
  }
  return `${v.slice(0, max)}…`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function resolveSeverity(payload: CrashReportPayload): "crash" | "error" {
  const s = asString(payload.severity).toLowerCase();
  if (s === "crash" || s === "error") {
    return s;
  }
  const src = asString(payload.source).toLowerCase();
  if (src === "freeze" || src === "manual_test") {
    return "crash";
  }
  return "error";
}

function embedCharTotal(title: string, description: string, fields: DiscordField[]): number {
  let n = title.length + description.length;
  for (const f of fields) {
    n += f.name.length + f.value.length;
  }
  return n;
}

/** Shrink longest field values / description until under Discord embed cap. */
function pickFieldToShrink(fs: DiscordField[]): { index: number; len: number } {
  let bestNonStack = -1;
  let lenNon = -1;
  let bestStack = -1;
  let lenSt = -1;
  for (let i = 0; i < fs.length; i++) {
    const len = fs[i]!.value.length;
    if (fs[i]!.name.startsWith("Stack")) {
      if (len > lenSt) {
        lenSt = len;
        bestStack = i;
      }
    } else if (len > lenNon) {
      lenNon = len;
      bestNonStack = i;
    }
  }
  if (bestNonStack >= 0 && lenNon > 120) {
    return { index: bestNonStack, len: lenNon };
  }
  if (bestStack >= 0 && lenSt > 120) {
    return { index: bestStack, len: lenSt };
  }
  if (bestNonStack >= 0) {
    return { index: bestNonStack, len: lenNon };
  }
  return { index: bestStack, len: lenSt };
}

function shrinkEmbedToBudget(
  title: string,
  description: string,
  fields: DiscordField[],
  maxTotal: number,
): { title: string; description: string; fields: DiscordField[] } {
  let t = title;
  let d = description;
  let fs = fields.map((f) => ({ ...f }));
  let guard = 0;
  while (embedCharTotal(t, d, fs) > maxTotal && guard++ < 48) {
    const { index: bestI, len: bestLen } = pickFieldToShrink(fs);
    if (bestI >= 0 && bestLen > 120) {
      const cut = Math.max(80, Math.floor(bestLen * 0.65));
      fs[bestI]!.value = trunc(fs[bestI]!.value.replace(/…$/u, ""), cut);
      continue;
    }
    if (d.length > 120) {
      d = trunc(d.replace(/…$/u, ""), Math.max(80, Math.floor(d.length * 0.65)));
      continue;
    }
    if (t.length > 40) {
      t = trunc(t, Math.max(30, Math.floor(t.length * 0.65)));
      continue;
    }
    break;
  }
  return { title: t, description: d, fields: fs };
}

function sanitizeDiscordField(f: DiscordField): DiscordField {
  const nameRaw = f.name.trim();
  const name = nameRaw.length > 0 ? trunc(nameRaw, 256) : "Field";
  let value = f.value;
  if (value.trim().length === 0) {
    value = "—";
  }
  value = trunc(value, DISCORD_FIELD_VALUE_MAX);
  return { name, value, inline: f.inline };
}

function clampEmbedFields(
  fields: DiscordField[],
  max: number,
): { fields: DiscordField[]; omitted: number } {
  if (fields.length <= max) {
    return { fields, omitted: 0 };
  }
function splitStackFields(stack: string): DiscordField[] {
  const s = stack.trim();
  if (s === "") {
    return [];
  }
  const fenceOverhead = 10;
  const maxInner = DISCORD_FIELD_VALUE_MAX - fenceOverhead;
  const out: DiscordField[] = [];
  let i = 0;
  let part = 1;
  while (i < s.length && out.length < MAX_STACK_FIELD_PARTS) {
    const chunk = s.slice(i, i + maxInner);
    out.push({
      name: part === 1 ? "Stack" : `Stack (${part})`,
      value: `\`\`\`\n${chunk}\n\`\`\``,
      inline: false,
    });
    i += maxInner;
    part++;
  }
  return out;
}

function formatMods(mods: CrashReportPayload["mods"]): string {
  if (!Array.isArray(mods) || mods.length === 0) {
    return "none";
  }
  const lines = mods.slice(0, 24).map((m) => {
    const id = trunc(asString(m.modId) || "?", 48);
    const ver = trunc(asString(m.version) || "?", 24);
    const nm = trunc(asString(m.name) || id, 48);
    return `${nm} · ${id}@${ver}`;
  });
  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let payload: CrashReportPayload;
  try {
    payload = (await req.json()) as CrashReportPayload;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const severity = resolveSeverity(payload);
  const crashWebhook = Deno.env.get("DISCORD_WEBHOOK_URL_CRASH")?.trim() ?? "";
  const errorWebhook = Deno.env.get("DISCORD_WEBHOOK_URL_ERROR")?.trim() ?? "";
  /** Prefer the URL for this severity; fall back to the other so one secret is enough. */
  const webhook =
    severity === "crash"
      ? crashWebhook || errorWebhook
      : errorWebhook || crashWebhook;
  if (webhook === "") {
    return json(
      {
        ok: false,
        error:
          "Missing Discord webhook: set DISCORD_WEBHOOK_URL_CRASH and/or DISCORD_WEBHOOK_URL_ERROR",
      },
      500,
    );
  }

  const source = trunc(asString(payload.source) || "unknown", 60);
  const crashId = trunc(asString(payload.crashId), 80);
  const sessionId = trunc(asString(payload.sessionId), 80);
  const message = trunc(asString(payload.message) || "Unknown crash", 1400);
  const stack = trunc(asString(payload.stack), 3800);
  const name = trunc(asString(payload.name) || "Error", 120);
  const url = trunc(asString(payload.url), 220);
  const timestampIso = trunc(asString(payload.timestampIso), 80);
  const userAgent = trunc(asString(payload.userAgent), 220);
  const role = trunc(asString(payload.context?.networkRole), 40);
  const worldName = trunc(asString(payload.context?.worldName ?? ""), 120);
  const worldUuid = trunc(asString(payload.context?.worldUuid ?? ""), 120);
  const lastCommand = trunc(asString(payload.context?.lastCommand ?? ""), 160);
  const lastUiError = trunc(asString(payload.context?.lastUiError ?? ""), 220);
  const visibility = trunc(asString(payload.context?.visibilityState ?? ""), 20);
  const freezeThreshold = Number.isFinite(payload.context?.freezeThresholdMs)
    ? `${Math.max(0, Number(payload.context?.freezeThresholdMs))}ms`
    : "";
  const lastRenderAge = Number.isFinite(payload.context?.lastRenderAtMs)
    ? `${Math.max(0, Date.now() - Number(payload.context?.lastRenderAtMs))}ms ago`
    : "";
  const recentEventsRaw = Array.isArray(payload.context?.recentEvents)
    ? payload.context!.recentEvents
        .map((v) => asString(v).trim())
        .filter((v) => v.length > 0)
        .slice(-8)
    : [];
  const recentEvents = trunc(
    recentEventsRaw.length > 0 ? recentEventsRaw.join("\n") : "n/a",
    900,
  );
  const buildId = trunc(asString(payload.build?.buildId ?? ""), 64);
  const appVersion = trunc(asString(payload.build?.appVersion ?? ""), 32);
  const mode = trunc(asString(payload.build?.mode ?? ""), 32);
  const wire = Number.isFinite(payload.build?.wireProtocol)
    ? String(payload.build!.wireProtocol)
    : "";
  const wireMin = Number.isFinite(payload.build?.minWireProtocol)
    ? String(payload.build!.minWireProtocol)
    : "";
  const prod =
    typeof payload.build?.production === "boolean"
      ? payload.build!.production
        ? "prod"
        : "dev"
      : "";

  const dx = payload.diagnostics;
  const viewport = trunc(asString(dx?.viewportCss), 24);
  const screenCss = trunc(asString(dx?.screenCss), 24);
  const dpr = typeof dx?.devicePixelRatio === "number" && Number.isFinite(dx.devicePixelRatio)
    ? String(dx.devicePixelRatio)
    : "?";
  const cores =
    dx?.hardwareConcurrency !== null &&
    dx?.hardwareConcurrency !== undefined &&
    Number.isFinite(dx.hardwareConcurrency)
      ? String(dx.hardwareConcurrency)
      : "?";
  const memGb =
    dx?.deviceMemoryGb !== null &&
    dx?.deviceMemoryGb !== undefined &&
    Number.isFinite(dx.deviceMemoryGb)
      ? String(dx.deviceMemoryGb)
      : "?";
  const touch =
    typeof dx?.maxTouchPoints === "number" && Number.isFinite(dx.maxTouchPoints)
      ? String(dx.maxTouchPoints)
      : "?";
  const langs = trunc(asString(dx?.languages), 120);
  const tz = trunc(asString(dx?.timeZone), 64);
  const online = typeof dx?.onLine === "boolean" ? (dx.onLine ? "yes" : "no") : "?";
  const glVendor = trunc(asString(dx?.webglVendor), 200);
  const glRenderer = trunc(asString(dx?.webglRenderer), 500);
  const stUsed =
    dx?.storageUsedMb !== null &&
    dx?.storageUsedMb !== undefined &&
    Number.isFinite(dx.storageUsedMb)
      ? `${dx.storageUsedMb}`
      : "?";
  const stQuota =
    dx?.storageQuotaMb !== null &&
    dx?.storageQuotaMb !== undefined &&
    Number.isFinite(dx.storageQuotaMb)
      ? `${dx.storageQuotaMb}`
      : "?";

  const sim = payload.sim;
  const tick =
    sim?.tickIndex !== null &&
    sim?.tickIndex !== undefined &&
    Number.isFinite(sim.tickIndex)
      ? String(sim.tickIndex)
      : "n/a";
  const wtime =
    sim?.worldTimeMs !== null &&
    sim?.worldTimeMs !== undefined &&
    Number.isFinite(sim.worldTimeMs)
      ? String(sim.worldTimeMs)
      : "n/a";
  const pbx =
    sim?.playerBlockX !== null &&
    sim?.playerBlockX !== undefined &&
    Number.isFinite(sim.playerBlockX)
      ? String(sim.playerBlockX)
      : "n/a";
  const pby =
    sim?.playerBlockY !== null &&
    sim?.playerBlockY !== undefined &&
    Number.isFinite(sim.playerBlockY)
      ? String(sim.playerBlockY)
      : "n/a";
  const roomFp = trunc(asString(sim?.roomFingerprint ?? ""), 16);
  const modsText = trunc(formatMods(payload.mods), 900);

  const isCrash = severity === "crash";
  let title = `${isCrash ? "Crash" : "Error"}: ${name}`;
  let description = trunc(message, 1600);
  const buildLine = trunc(
    `${appVersion} | ${buildId} | ${mode}${prod ? ` | ${prod}` : ""}${
      wire !== "" && wireMin !== "" ? ` | wire ${wireMin}–${wire}` : wire !== "" ? ` | wire ${wire}` : ""
    }`,
    500,
  );

  const fields: DiscordField[] = [
    { name: "Severity", value: severity, inline: true },
    {
      name: "Session / report",
      value: trunc(
        `${isCrash ? "Crash" : "Report"} ID: ${crashId || "unknown"}\nSession: ${sessionId || "unknown"}`,
        DISCORD_FIELD_VALUE_MAX,
      ),
      inline: false,
    },
    { name: "Source", value: source || "unknown", inline: true },
    { name: "Time", value: timestampIso || "unknown", inline: true },
    { name: "Role", value: role || "unknown", inline: true },
    {
      name: "World",
      value: trunc(
        `${worldName || "unknown"}\nUUID: ${worldUuid || "n/a"}`,
        DISCORD_FIELD_VALUE_MAX,
      ),
      inline: false,
    },
    { name: "Last command", value: lastCommand || "n/a", inline: false },
    { name: "Last UI error", value: lastUiError || "n/a", inline: false },
    {
      name: "Render / visibility",
      value: trunc(
        `${lastRenderAge || "n/a"} | threshold ${freezeThreshold || "n/a"} | ${visibility || "unknown"}`,
        DISCORD_FIELD_VALUE_MAX,
      ),
      inline: false,
    },
    { name: "Recent events", value: trunc(recentEvents, DISCORD_FIELD_VALUE_MAX), inline: false },
    { name: "URL", value: url || "n/a", inline: false },
    { name: "Build", value: buildLine, inline: false },
    { name: "UA", value: trunc(userAgent || "n/a", DISCORD_FIELD_VALUE_MAX), inline: false },
    {
      name: "Viewport / locale",
      value: trunc(
        `css ${viewport || "?"} | screen ${screenCss || "?"} | dpr ${dpr}\n${langs || "?"} | ${tz || "?"} | online ${online}`,
        DISCORD_FIELD_VALUE_MAX,
      ),
      inline: false,
    },
    {
      name: "Hardware",
      value: trunc(`cores ${cores} | deviceMemoryGb ${memGb} | maxTouch ${touch}`, DISCORD_FIELD_VALUE_MAX),
      inline: false,
    },
    {
      name: "WebGL",
      value: trunc(`${glVendor}\n${glRenderer}`, DISCORD_FIELD_VALUE_MAX),
      inline: false,
    },
    {
      name: "Storage (MB)",
      value: trunc(`used ${stUsed} | quota ${stQuota}`, DISCORD_FIELD_VALUE_MAX),
      inline: false,
    },
    {
      name: "Simulation",
      value: trunc(
        `tick ${tick} | worldTimeMs ${wtime}\nblock ${pbx}, ${pby} | room fp ${roomFp || "n/a"}`,
        DISCORD_FIELD_VALUE_MAX,
      ),
      inline: false,
    },
    { name: "Mods", value: trunc(modsText, DISCORD_FIELD_VALUE_MAX), inline: false },
    ...splitStackFields(stack),
  ];

  const shrunk = shrinkEmbedToBudget(title, description, fields, DISCORD_EMBED_TOTAL_MAX);
  title = trunc(shrunk.title, DISCORD_TITLE_MAX);
  description = trunc(shrunk.description, DISCORD_DESCRIPTION_MAX);
  const normalized = shrunk.fields.map((f) =>
    sanitizeDiscordField({
      ...f,
      name: trunc(f.name, 240),
      value: trunc(f.value, DISCORD_FIELD_VALUE_MAX),
    }),
  );
  const { fields: finalFields, omitted } = clampEmbedFields(
    normalized,
    DISCORD_MAX_EMBED_FIELDS,
  );
  if (omitted > 0) {
    const note = `\n\n_(Discord: ${omitted} embed field(s) truncated — stack shown first.)_`;
    description = trunc(description + note, DISCORD_DESCRIPTION_MAX);
  }

  const discordBody = {
    username: isCrash ? "Stratum Crash Reporter" : "Stratum Error Reporter",
    embeds: [
      {
        title,
        description,
        color: isCrash ? 0xd14b4b : 0xe67e22,
        fields: finalFields,
      },
    ],
  };

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordBody),
  });
  if (!res.ok) {
    const text = await res.text();
    return json(
      { ok: false, error: `Discord webhook failed (${res.status}): ${trunc(text, 300)}` },
      502,
    );
  }
  return json({ ok: true });
});
