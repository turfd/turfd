import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

type DiscordTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
};

type DiscordGuildMember = {
  roles?: string[];
};

type DonatorTier = "none" | "iron" | "gold" | "stratite";

function addQueryParam(urlRaw: string, key: string, value: string): string {
  try {
    const url = new URL(urlRaw);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return urlRaw;
  }
}

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url },
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

async function discordJson<T>(
  url: string,
  accessToken: string,
): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}`);
  }
  return (await res.json()) as T;
}

serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  const discordClientId = Deno.env.get("DISCORD_CLIENT_ID")?.trim() ?? "";
  const discordClientSecret = Deno.env.get("DISCORD_CLIENT_SECRET")?.trim() ?? "";
  const discordRedirectUri = Deno.env.get("DISCORD_REDIRECT_URI")?.trim() ?? "";
  const guildId = Deno.env.get("DISCORD_GUILD_ID")?.trim() ?? "";
  const ironRoleId = Deno.env.get("DISCORD_DONATOR_ROLE_IRON_ID")?.trim() ?? "";
  const goldRoleId = Deno.env.get("DISCORD_DONATOR_ROLE_GOLD_ID")?.trim() ?? "";
  const stratiteRoleId = Deno.env.get("DISCORD_DONATOR_ROLE_STRATITE_ID")?.trim() ?? "";
  const fallbackUrl = Deno.env.get("DISCORD_OAUTH_DEFAULT_RETURN_URL")?.trim() ?? "";
  if (
    supabaseUrl === "" ||
    serviceRole === "" ||
    discordClientId === "" ||
    discordClientSecret === "" ||
    discordRedirectUri === "" ||
    guildId === ""
  ) {
    return new Response("Missing required secrets.", { status: 500 });
  }

  const url = new URL(req.url);
  const state = url.searchParams.get("state")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (state === "" || code === "") {
    const destination = addQueryParam(fallbackUrl, "discord_link", "failed_missing_params");
    return redirect(destination);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const { data: stateRow, error: stateErr } = await admin
    .from("discord_oauth_states")
    .select("state, user_id, return_url, expires_at, consumed_at")
    .eq("state", state)
    .maybeSingle();
  if (stateErr !== null || stateRow === null) {
    const destination = addQueryParam(fallbackUrl, "discord_link", "failed_state");
    return redirect(destination);
  }
  const returnUrl = stateRow.return_url || fallbackUrl;
  if (stateRow.consumed_at !== null) {
    return redirect(addQueryParam(returnUrl, "discord_link", "failed_state_used"));
  }
  if (Date.parse(stateRow.expires_at) < Date.now()) {
    return redirect(addQueryParam(returnUrl, "discord_link", "failed_state_expired"));
  }

  try {
    const tokenBody = new URLSearchParams({
      client_id: discordClientId,
      client_secret: discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: discordRedirectUri,
    });
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed with ${tokenRes.status}`);
    }
    const tokenData = (await tokenRes.json()) as DiscordTokenResponse;
    const user = await discordJson<DiscordUser>(
      "https://discord.com/api/users/@me",
      tokenData.access_token,
    );
    const member = await discordJson<DiscordGuildMember>(
      `https://discord.com/api/users/@me/guilds/${guildId}/member`,
      tokenData.access_token,
    );
    const roles = Array.isArray(member.roles) ? member.roles : [];
    const tier = resolveTier(roles, ironRoleId, goldRoleId, stratiteRoleId);
    const isDonator = tier !== "none";
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
    const username =
      typeof user.discriminator === "string"
        ? `${user.username}#${user.discriminator}`
        : user.username;

    await admin.from("discord_links").upsert({
      user_id: stateRow.user_id,
      discord_user_id: user.id,
      discord_username: username,
      discord_access_token: tokenData.access_token,
      discord_refresh_token: tokenData.refresh_token,
      token_expires_at: expiresAt,
      is_donator: isDonator,
      donator_tier: tier,
      last_role_check_at: new Date().toISOString(),
      last_role_check_error: null,
      updated_at: new Date().toISOString(),
    });
    await admin
      .from("discord_oauth_states")
      .update({ consumed_at: new Date().toISOString() })
      .eq("state", state);

    const success = addQueryParam(addQueryParam(returnUrl, "discord_link", "success"), "tier", tier);
    return redirect(success);
  } catch (err) {
    console.warn("[discord-oauth-callback]", err);
    await admin
      .from("discord_oauth_states")
      .update({ consumed_at: new Date().toISOString() })
      .eq("state", state);
    return redirect(addQueryParam(returnUrl, "discord_link", "failed_runtime"));
  }
});
