import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertChapterAccess } from "@/lib/anonymous/access";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await assertChapterAccess(id);
    if (!access) return NextResponse.json({ error: "Acesso negado." }, { status: 403 });

    const admin = createAdminClient();
    const { data: job, error } = await admin.rpc("enqueue_translation_job", {
      p_job_type: "process_chapter",
      p_chapter_id: id,
      p_input_json: {
        requested_by: access.actor.userId,
        anonymous_session_id: access.actor.anonymousSessionId,
        pipeline_version: "v1",
      },
      p_force: false,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const { error: statusError } = await admin.from("chapters").update({ status: "processing" }).eq("id", id);
    if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });

    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao enfileirar capítulo." }, { status: 500 });
  }
}
