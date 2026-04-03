/** Construct Supabase or null guest auth from Vite env (with optional dev secrets file fallback). */

import { localSecret } from "../config/secretsLoader";
import type { IAuthProvider } from "./IAuthProvider";
import { NullAuthProvider } from "./NullAuthProvider";
import { SupabaseAuthProvider } from "./SupabaseAuthProvider";

export function createAuthProvider(): IAuthProvider {
  const url =
    (import.meta.env.VITE_SUPABASE_URL ?? "").trim() ||
    localSecret("VITE_SUPABASE_URL");
  const key =
    (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim() ||
    localSecret("VITE_SUPABASE_ANON_KEY");
  if (url !== "" && key !== "") {
    return new SupabaseAuthProvider(url, key);
  }
  return new NullAuthProvider();
}
