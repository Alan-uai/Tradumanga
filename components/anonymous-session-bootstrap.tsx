"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { getAnonymousManifest } from "@/lib/anonymous/localState";

async function manifestKey(manifest: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function AnonymousSessionBootstrap() {
  useEffect(() => {
    let cancelled = false;
    async function sync() {
      if (cancelled) return;
      await fetch("/api/anonymous/session", { method: "POST" });
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const manifest = await getAnonymousManifest();
      if (!manifest.works.length && !manifest.history.length) return;
      await fetch("/api/migrate-anonymous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ migrationKey: await manifestKey(manifest), ...manifest }),
      });
    }
    void sync();
    const supabase = createClient();
    const { data: listener } = supabase.auth.onAuthStateChange(() => { void sync(); });
    return () => { cancelled = true; listener.subscription.unsubscribe(); };
  }, []);
  return null;
}
