import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

const COOKIE_NAME = "tm_anon_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function getOrCreateAnonymousSession() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME)?.value;
  const admin = createAdminClient();

  if (existing) {
    const { data } = await admin.from("anonymous_sessions").select("id")
      .eq("token_hash", hashToken(existing))
      .gt("expires_at", new Date().toISOString()).maybeSingle();
    if (data) {
      await admin.from("anonymous_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
      return { id: data.id, token: existing };
    }
  }

  const token = randomBytes(32).toString("base64url");
  const { data, error } = await admin.from("anonymous_sessions").insert({ token_hash: hashToken(token) }).select("id").single();
  if (error || !data) throw error ?? new Error("Não foi possível criar a sessão anônima.");

  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
    path: "/", maxAge: COOKIE_MAX_AGE,
  });
  return { id: data.id, token };
}

export async function getAnonymousSessionId() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  const { data } = await createAdminClient().from("anonymous_sessions").select("id")
    .eq("token_hash", hashToken(token)).gt("expires_at", new Date().toISOString()).maybeSingle();
  return data?.id ?? null;
}
