// Supabase Edge Function: crash-report
// Receives client crash payloads and forwards compact summaries to Discord.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type CrashReportPayload = {
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
  };
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const webhook = Deno.env.get("DISCORD_WEBHOOK_URL_CRASH")?.trim() ?? "";
  if (webhook === "") {
    return json({ ok: false, error: "Missing DISCORD_WEBHOOK_URL_CRASH secret" }, 500);
  }

  let payload: CrashReportPayload;
  try {
    payload = (await req.json()) as CrashReportPayload;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const source = trunc(asString(payload.source) || "unknown", 60);
  const message = trunc(asString(payload.message) || "Unknown crash", 1400);
  const stack = trunc(asString(payload.stack), 3500);
  const name = trunc(asString(payload.name) || "Error", 120);
  const url = trunc(asString(payload.url), 220);
  const timestampIso = trunc(asString(payload.timestampIso), 80);
  const userAgent = trunc(asString(payload.userAgent), 220);
  const role = trunc(asString(payload.context?.networkRole), 40);
  const worldName = trunc(asString(payload.context?.worldName ?? ""), 120);
  const worldUuid = trunc(asString(payload.context?.worldUuid ?? ""), 120);
  const lastCommand = trunc(asString(payload.context?.lastCommand ?? ""), 160);
  const lastUiError = trunc(asString(payload.context?.lastUiError ?? ""), 220);
  const buildId = trunc(asString(payload.build?.buildId ?? ""), 64);
  const appVersion = trunc(asString(payload.build?.appVersion ?? ""), 32);
  const mode = trunc(asString(payload.build?.mode ?? ""), 32);

  const discordBody = {
    username: "Stratum Crash Reporter",
    embeds: [
      {
        title: `Crash: ${name}`,
        description: trunc(message, 1800),
        color: 0xd14b4b,
        fields: [
          { name: "Source", value: source || "unknown", inline: true },
          { name: "Time", value: timestampIso || "unknown", inline: true },
          { name: "Role", value: role || "unknown", inline: true },
          { name: "World", value: worldName || "unknown", inline: true },
          { name: "World UUID", value: worldUuid || "n/a", inline: true },
          { name: "Last command", value: lastCommand || "n/a", inline: false },
          { name: "Last UI error", value: lastUiError || "n/a", inline: false },
          { name: "URL", value: url || "n/a", inline: false },
          { name: "Build", value: `${appVersion} | ${buildId} | ${mode}`, inline: false },
          { name: "UA", value: userAgent || "n/a", inline: false },
        ],
      },
    ],
  };
  if (stack.trim() !== "") {
    discordBody.embeds[0]!.fields.push({
      name: "Stack",
      value: `\`\`\`\n${stack}\n\`\`\``,
      inline: false,
    });
  }

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
