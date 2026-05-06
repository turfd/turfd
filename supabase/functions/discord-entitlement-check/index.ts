import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

type DonatorTier = "none" | "iron" | "gold" | "stratite";
type CheckBody = { forceRefresh?: boolean };
type DiscordGuildMember = { roles?: string[] };

type DiscordTokenRefreshResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
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

function resolveTier(
  roleIds: readonly string[],
  ironRoleId: string,
  goldRoleId: string,
  stratiteRoleId: string,
): DonatorTier {
  const has = (id: string): boolean => id !== "" && roleIds.includes(id);
  if (has(stratiteRoleId)) {
    return "stratite";
  }
  if (has(goldRoleId)) {
    return "gold";
  }
  if (has(ironRoleId)) {
    return "iron";
  }
  return "none";
}

async function fetchMemberRoles(
  accessToken: string,
  guildId: string,
): Promise<readonly string[]> {
  const memberRes = await fetch(
    `https://discord.com/api/users/@me/guilds/${guildId}/member`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!memberRes.ok) {
    throw new Error(`Discord member fetch failed (${memberRes.status})`);
  }
  const member = (await memberRes.json()) as DiscordGuildMember;
  return Array.isArray(member.roles) ? member.roles : [];
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
  const discordClientSecret = Deno.env.get("DISCORD_CLIENT_SECRET")?.trim() ?? "";
  const guildId = Deno.env.get("DISCORD_GUILD_ID")?.trim() ?? "";
  const ironRoleId = Deno.env.get("DISCORD_DONATOR_ROLE_IRON_ID")?.trim() ?? "";
  const goldRoleId = Deno.env.get("DISCORD_DONATOR_ROLE_GOLD_ID")?.trim() ?? "";
  const stratiteRoleId = Deno.env.get("DISCORD_DONATOR_ROLE_STRATITE_ID")?.trim() ?? "";
  const staleMs = Number(Deno.env.get("DISCORD_ROLE_CACHE_MAX_AGE_MS") ?? "900000");
  if (
    supabaseUrl === "" ||
    supabaseAnonKey === "" ||
    serviceRole === "" ||
    discordClientId === "" ||
    discordClientSecret === "" ||
    guildId === ""
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

  const admin = createClient(supabaseUrl, serviceRole);
  const { data: row, error: rowErr } = await admin
    .from("discord_links")
    .select(
      "user_id, discord_user_id, discord_username, discord_access_token, discord_refresh_token, token_expires_at, is_donator, donator_tier, last_role_check_at",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (rowErr !== null || row === null) {
    return json({
      ok: true,
      linked: false,
      isDonator: false,
      tier: "none",
      checkedAt: null,
    });
  }

  let body: CheckBody = {};
  try {
    body = (await req.json()) as CheckBody;
  } catch {
    // optional
  }
  const forceRefresh = body.forceRefresh === true;
  const lastCheckedMs = Date.parse(row.last_role_check_at);
  const shouldRefresh =
    forceRefresh ||
    !Number.isFinite(lastCheckedMs) ||
    Date.now() - lastCheckedMs >= Math.max(60_000, Number.isFinite(staleMs) ? staleMs : 900_000);
  if (!shouldRefresh) {
    return json({
      ok: true,
      linked: true,
      isDonator: row.is_donator === true,
      tier: row.donator_tier as DonatorTier,
      checkedAt: row.last_role_check_at,
      username: row.discord_username ?? null,
    });
  }

  try {
    let accessToken = row.discord_access_token as string;
    let refreshToken = row.discord_refresh_token as string;
    let expiresAtMs = Date.parse(row.token_expires_at as string);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + 10_000) {
      const refreshBody = new URLSearchParams({
        client_id: discordClientId,
        client_secret: discordClientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      const refreshRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: refreshBody.toString(),
      });
      if (!refreshRes.ok) {
        throw new Error(`Discord token refresh failed (${refreshRes.status})`);
      }
      const refreshed = (await refreshRes.json()) as DiscordTokenRefreshResponse;
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token;
      expiresAtMs = Date.now() + refreshed.expires_in * 1000;
    }

    const roles = await fetchMemberRoles(accessToken, guildId);
    const tier = resolveTier(roles, ironRoleId, goldRoleId, stratiteRoleId);
    const isDonator = tier !== "none";
    const checkedAtIso = new Date().toISOString();
    const { error: updateErr } = await admin
      .from("discord_links")
      .update({
        discord_access_token: accessToken,
        discord_refresh_token: refreshToken,
        token_expires_at: new Date(expiresAtMs).toISOString(),
        is_donator: isDonator,
        donator_tier: tier,
        last_role_check_at: checkedAtIso,
        last_role_check_error: null,
        updated_at: checkedAtIso,
      })
      .eq("user_id", userId);
    if (updateErr !== null) {
      return json({ ok: false, error: "Failed to persist entitlement check." }, 500);
    }
    return json({
      ok: true,
      linked: true,
      isDonator,
      tier,
      checkedAt: checkedAtIso,
      username: row.discord_username ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const checkedAtIso = new Date().toISOString();
    await admin
      .from("discord_links")
      .update({
        last_role_check_at: checkedAtIso,
        last_role_check_error: msg,
        updated_at: checkedAtIso,
      })
      .eq("user_id", userId);
    return json({
      ok: true,
      linked: true,
      isDonator: row.is_donator === true,
      tier: row.donator_tier as DonatorTier,
      checkedAt: row.last_role_check_at,
      username: row.discord_username ?? null,
      stale: true,
      warning: msg,
    });
  }
});
