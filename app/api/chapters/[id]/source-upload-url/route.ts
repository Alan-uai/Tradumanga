import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertChapterAccess } from "@/lib/anonymous/access";

function safeName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return normalized || "source.pdf";
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await assertChapterAccess(id);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const body = await req.json();
    const filename = typeof body?.filename === "string" ? body.filename : "source.pdf";
    const contentType = typeof body?.contentType === "string" ? body.contentType : "application/pdf";
    if (contentType !== "application/pdf") {
      return NextResponse.json({ error: "Somente PDF é aceito nesta entrada." }, { status: 400 });
    }

    const prefix = access.actor.userId ?? access.actor.anonymousSessionId!;
    const path = `${prefix}/${access.series.id}/${access.chapter.chapter_number}/source-${safeName(filename)}`;
    const admin = createAdminClient();

    const { data: signed, error } = await admin.storage
      .from("manga-pages")
      .createSignedUploadUrl(path, { upsert: true });
    if (error || !signed) return NextResponse.json({ error: error?.message ?? "Falha ao criar upload." }, { status: 500 });

    const { error: updateError } = await admin.from("chapters").update({
      source_type: "pdf",
      source_path: path,
      source_mime: contentType,
      source_filename: filename,
    }).eq("id", id);
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    return NextResponse.json({ path, token: signed.token });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao preparar PDF." }, { status: 500 });
  }
}
