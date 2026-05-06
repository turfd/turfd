import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

type StartBody = {
  returnUrl?: string;
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

function sanitizeReturnUrl(value: string | undefined): string {
  const fallback = Deno.env.get("DISCORD_OAUTH_DEFAULT_RETURN_URL")?.trim() ?? "";
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return fallback;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  const discordClientId = Deno.env.get("DISCORD_CLIENT_ID")?.trim() ?? "";
  const discordRedirectUri = Deno.env.get("DISCORD_REDIRECT_URI")?.trim() ?? "";
  if (
    supabaseUrl === "" ||
    supabaseAnonKey === "" ||
    serviceRole === "" ||
    discordClientId === "" ||
    discordRedirectUri === ""
  ) {
    return json({ ok: false, error: "Missing required secrets." }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "Missing bearer token." }, 401);
  }
  const jwt = authHeader.slice("Bearer ".length).trim();
  if (jwt === "") {
    return json({ ok: false, error: "Missing bearer token." }, 401);
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  const userId = userData.user?.id;
  if (userErr !== null || userId === undefined) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  let body: StartBody = {};
  try {
    body = (await req.json()) as StartBody;
  } catch {
    // Optional body only.
  }
  const returnUrl = sanitizeReturnUrl(body.returnUrl);
  if (returnUrl === "") {
    return json({ ok: false, error: "Missing return URL." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const state = crypto.randomUUID();
  const expiresAtIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error: insertErr } = await admin.from("discord_oauth_states").insert({
    state,
    user_id: userId,
    return_url: returnUrl,
    expires_at: expiresAtIso,
  });
  if (insertErr !== null) {
    return json({ ok: false, error: "Failed to create OAuth state." }, 500);
  }

  const params = new URLSearchParams({
    client_id: discordClientId,
    response_type: "code",
    redirect_uri: discordRedirectUri,
    scope: "identify guilds.members.read",
    prompt: "consent",
    state,
  });
  return json({
    ok: true,
    authorizeUrl: `https://discord.com/oauth2/authorize?${params.toString()}`,
  });
});
