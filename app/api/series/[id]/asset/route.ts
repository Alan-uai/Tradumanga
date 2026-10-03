import { NextResponse } from "next/server";
import { assertSeriesAccess } from "@/lib/anonymous/access";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await assertSeriesAccess(id);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const admin = createAdminClient();
    const { data: series, error } = await admin
      .from("manga_series")
      .select("logo_path,banner_path,cover_path")
      .eq("id", id)
      .single();

    if (error || !series) return NextResponse.json({ error: "Obra não encontrada." }, { status: 404 });

    const requested = new URL(_req.url).searchParams.get("type") === "logo" ? "logo" : "banner";
    const path = requested === "logo"
      ? series.logo_path
      : series.banner_path ?? series.cover_path ?? series.logo_path;

    if (!path) return NextResponse.json({ error: "Asset indisponível." }, { status: 404 });

    const { data, error: signedError } = await admin.storage
      .from("manga-pages")
      .createSignedUrl(path, 60 * 60);

    if (signedError || !data?.signedUrl) {
      return NextResponse.json({ error: "Asset indisponível." }, { status: 404 });
    }

    return NextResponse.redirect(data.signedUrl, {
      headers: { "Cache-Control": "private, max-age=1800" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao servir asset da obra." },
      { status: 500 }
    );
  }
}
