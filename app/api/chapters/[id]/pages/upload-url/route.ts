import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertChapterAccess } from "@/lib/anonymous/access";

function safeName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return normalized || "page";
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await assertChapterAccess(id);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const body = await req.json();
    const pageNumber = Number(body?.pageNumber);
    const filename = typeof body?.filename === "string" ? body.filename : "page";
    const contentType = typeof body?.contentType === "string" ? body.contentType : "image/jpeg";

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return NextResponse.json({ error: "pageNumber inválido." }, { status: 400 });
    }
    if (!contentType.startsWith("image/")) {
      return NextResponse.json({ error: "Somente imagens são aceitas." }, { status: 400 });
    }

    const prefix = access.actor.userId ?? access.actor.anonymousSessionId!;
    const path = `${prefix}/${access.series.id}/${access.chapter.chapter_number}/${String(pageNumber).padStart(4, "0")}-${safeName(filename)}`;
    const admin = createAdminClient();

    const { data: page, error: pageError } = await admin.from("pages").upsert({
      chapter_id: id, page_number: pageNumber, original_path: path, status: "queued",
    }, { onConflict: "chapter_id,page_number" }).select("id,page_number,original_path,status").single();
    if (pageError) return NextResponse.json({ error: pageError.message }, { status: 500 });

    const { data: signed, error: signedError } = await admin.storage
      .from("manga-pages").createSignedUploadUrl(path, { upsert: true });
    if (signedError) return NextResponse.json({ error: signedError.message }, { status: 500 });

    return NextResponse.json({ page, path, token: signed.token });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao preparar upload." }, { status: 500 });
  }
}
