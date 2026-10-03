import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertChapterAccess } from "@/lib/anonymous/access";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await assertChapterAccessForPage(id);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const url = new URL(req.url);
    const variant = url.searchParams.get("variant") === "original" ? "original" : "translated";
    const path = variant === "translated" ? access.page.translated_path ?? access.page.original_path : access.page.original_path;
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from("manga-pages").createSignedUrl(path, 60 * 60);
    if (error || !data?.signedUrl) return NextResponse.json({ error: "Imagem indisponível." }, { status: 404 });

    return NextResponse.redirect(data.signedUrl, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao servir página." }, { status: 500 });
  }
}

async function assertChapterAccessForPage(pageId: string) {
  const admin = createAdminClient();
  const { data: page, error } = await admin.from("pages").select("id,chapter_id,original_path,translated_path").eq("id", pageId).maybeSingle();
  if (error || !page) return null;
  const { assertChapterAccess } = await import("@/lib/anonymous/access");
  const access = await assertChapterAccess(page.chapter_id);
  return access ? { access, page } : null;
}
