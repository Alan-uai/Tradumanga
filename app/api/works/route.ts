import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActor } from "@/lib/anonymous/access";

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "Título é obrigatório." }, { status: 400 });

    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "Não foi possível iniciar a sessão anônima." }, { status: 401 });

    const admin = createAdminClient();
    const slugBase = slugify(title) || "obra";
    let slug = slugBase;
    let suffix = 2;
    while (true) {
      const { data: existing } = await admin.from("manga_series").select("id").eq("slug", slug).maybeSingle();
      if (!existing) break;
      slug = `${slugBase}-${suffix++}`;
    }

    const { data, error } = await admin.from("manga_series").insert({
      owner_id: actor.userId,
      anonymous_session_id: actor.anonymousSessionId,
      title,
      slug,
      status: "draft",
    }).select("id,title,status").single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ work: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao criar obra." }, { status: 500 });
  }
}
