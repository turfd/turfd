import { FunctionsHttpError } from "@supabase/functions-js";
import type { SupabaseClient } from "@supabase/supabase-js";

export type DonatorTier = "none" | "iron" | "gold" | "stratite";

export type DiscordEntitlementStatus = {
  linked: boolean;
  isDonator: boolean;
  tier: DonatorTier;
  checkedAt: string | null;
  username: string | null;
  stale?: boolean;
  warning?: string;
};

function mapInvokeError(err: unknown, fallback: string): string {
  if (err !== null && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim() !== "") {
      return msg;
    }
  }
  return fallback;
}

async function getInvokeAuthHeaders(
  supabase: SupabaseClient,
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  // getSession() can return a cached JWT that is already expired; Edge Functions validate
  // with auth.getUser(jwt). Prefer getUser() + refresh so the access_token is usable.
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr !== null || userData.user === null) {
    const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
    if (refErr !== null || refreshed.session === null) {
      return {
        ok: false,
        error: mapInvokeError(
          userErr ?? refErr,
          "You must be signed in to use Discord linking.",
        ),
      };
    }
  }

  const { data, error } = await supabase.auth.getSession();
  if (error !== null) {
    return { ok: false, error: mapInvokeError(error, "Failed to read auth session.") };
  }
  const accessToken = data.session?.access_token?.trim() ?? "";
  if (accessToken === "") {
    return { ok: false, error: "You must be signed in to use Discord linking." };
  }
  return { ok: true, headers: { Authorization: `Bearer ${accessToken}` } };
}

async function invokeWithUserJwt(
  supabase: SupabaseClient,
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const attempt = async (): Promise<
    | { kind: "invoke"; data: unknown; error: unknown }
    | { kind: "headers"; error: string }
  > => {
    const authHeaders = await getInvokeAuthHeaders(supabase);
    if (!authHeaders.ok) {
      return { kind: "headers", error: authHeaders.error };
    }
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: authHeaders.headers,
    });
    return { kind: "invoke", data, error };
  };

  let outcome = await attempt();
  if (outcome.kind === "headers") {
    return { ok: false, error: outcome.error };
  }
  let { data, error } = outcome;
  if (
    error instanceof FunctionsHttpError &&
    typeof error.context !== "undefined" &&
    error.context.status === 401
  ) {
    await supabase.auth.refreshSession();
    outcome = await attempt();
    if (outcome.kind === "headers") {
      return { ok: false, error: outcome.error };
    }
    data = outcome.data;
    error = outcome.error;
  }

  if (error !== null) {
    return {
      ok: false,
      error: mapInvokeError(error, "Edge function request failed."),
    };
  }
  return { ok: true, data };
}

export async function startDiscordOauth(
  supabase: SupabaseClient,
  returnUrl: string,
): Promise<{ ok: true; authorizeUrl: string } | { ok: false; error: string }> {
  const invoked = await invokeWithUserJwt(supabase, "discord-oauth-start", { returnUrl });
  if (!invoked.ok) {
    return { ok: false, error: invoked.error };
  }
  const { data } = invoked;
  const authorizeUrl =
    data !== null && typeof data === "object" && "authorizeUrl" in data
      ? (data as { authorizeUrl?: unknown }).authorizeUrl
      : undefined;
  if (typeof authorizeUrl !== "string" || authorizeUrl.trim() === "") {
    return { ok: false, error: "OAuth start endpoint returned no URL." };
  }
  return { ok: true, authorizeUrl };
}

export async function getDiscordEntitlement(
  supabase: SupabaseClient,
  forceRefresh = false,
): Promise<{ ok: true; status: DiscordEntitlementStatus } | { ok: false; error: string }> {
  const invoked = await invokeWithUserJwt(supabase, "discord-entitlement-check", {
    forceRefresh,
  });
  if (!invoked.ok) {
    return { ok: false, error: invoked.error };
  }
  const { data } = invoked;
  if (data === null || typeof data !== "object") {
    return { ok: false, error: "Entitlement endpoint returned invalid payload." };
  }
  const linked = (data as { linked?: unknown }).linked === true;
  const isDonator = (data as { isDonator?: unknown }).isDonator === true;
  const tierRaw = (data as { tier?: unknown }).tier;
  const tier: DonatorTier =
    tierRaw === "iron" || tierRaw === "gold" || tierRaw === "stratite" || tierRaw === "none"
      ? tierRaw
      : "none";
  const checkedAtRaw = (data as { checkedAt?: unknown }).checkedAt;
  const usernameRaw = (data as { username?: unknown }).username;
  const warningRaw = (data as { warning?: unknown }).warning;
  const stale = (data as { stale?: unknown }).stale === true;
  return {
    ok: true,
    status: {
      linked,
      isDonator,
      tier,
      checkedAt: typeof checkedAtRaw === "string" ? checkedAtRaw : null,
      username: typeof usernameRaw === "string" ? usernameRaw : null,
      stale,
      warning: typeof warningRaw === "string" ? warningRaw : undefined,
    },
  };
}
