/**
 * POST minimal error + crash payloads to Supabase `crash-report` (same as the game client).
 *
 * Requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (e.g. from `.env.local`).
 * Run: `npm run test:crash-webhook`
 *
 * Ensure Edge Function secrets `DISCORD_WEBHOOK_URL_*` are set (or fallback is configured).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadEnvLocal(): void {
  const p = path.join(repoRoot, ".env.local");
  if (!existsSync(p)) {
    return;
  }
  const text = readFileSync(p, "utf-8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function envStr(k: string): string | undefined {
  const v = process.env[k];
  if (v === undefined || v.trim().length === 0) {
    return undefined;
  }
  return v.trim();
}

function testPayload(kind: "error" | "crash"): Record<string, unknown> {
  const ts = new Date().toISOString();
  const base = {
    crashId: `test_${kind}_${Date.now().toString(36)}`,
    sessionId: "test_session_webhook",
    severity: kind,
    source: kind === "crash" ? "manual_test" : "error",
    name: kind === "crash" ? "ManualCrashTest" : "ManualErrorTest",
    message: kind === "crash" ? "This is a crash" : "This is an error",
    stack: `at testCrashReportWebhook (scripts/testCrashReportWebhook.ts)\n(kind: ${kind})`,
    url: "http://localhost/stratum/ (test:crash-webhook)",
    userAgent: "testCrashReportWebhook/1.0 node",
    timestampIso: ts,
    build: {
      appVersion: "test",
      buildId: "test-webhook",
      wireProtocol: 1,
      minWireProtocol: 1,
      mode: "development",
      production: false,
    },
    diagnostics: {
      viewportCss: "800x600",
      screenCss: "1920x1080",
      devicePixelRatio: 1,
      hardwareConcurrency: 8,
      deviceMemoryGb: null,
      maxTouchPoints: 0,
      languages: "en-US",
      timeZone: "UTC",
      onLine: true,
      webglVendor: "test",
      webglRenderer: "test",
      storageUsedMb: null,
      storageQuotaMb: null,
    },
    mods: [] as const,
    sim: {
      tickIndex: null,
      worldTimeMs: null,
      playerBlockX: null,
      playerBlockY: null,
      roomFingerprint: null,
    },
    context: {
      worldName: null,
      worldUuid: null,
      networkRole: "unknown",
      lastCommand: null,
      lastUiError: null,
      lastRenderAtMs: Date.now(),
      freezeThresholdMs: 10_000,
      visibilityState: "visible",
      recentEvents: [`${ts} test:crash-webhook ${kind}`],
    },
  };
  return base;
}

async function post(label: string, body: Record<string, unknown>): Promise<void> {
  const urlB = envStr("VITE_SUPABASE_URL");
  const anon = envStr("VITE_SUPABASE_ANON_KEY");
  if (urlB === undefined || anon === undefined) {
    console.error(
      "Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY (add .env.local or export them).",
    );
    process.exit(1);
  }
  const url = `${urlB.replace(/\/$/, "")}/functions/v1/crash-report`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anon}`,
      apikey: anon,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = text;
  }
  console.log(`\n${label}`);
  console.log(`  POST ${url}`);
  console.log(`  ${res.status} ${res.statusText}`);
  console.log(`  `, parsed);
}

async function main(): Promise<void> {
  loadEnvLocal();
  await post("ERROR (message: This is an error)", testPayload("error"));
  await post("CRASH (message: This is a crash)", testPayload("crash"));
  console.log("\nDone. Check your Discord channel(s).");
}

void main();
