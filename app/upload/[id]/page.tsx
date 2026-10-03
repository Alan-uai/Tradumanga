"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { saveAnonymousWork } from "@/lib/anonymous/localState";

export default function Upload() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [chapter, setChapter] = useState("1");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit() {
    if (!files.length) return;
    setBusy(true); setMsg("");

    const chapterResponse = await fetch("/api/chapters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesId: id, chapterNumber: Number(chapter) }),
    });
    const chapterPayload = await chapterResponse.json().catch(() => null);
    if (!chapterResponse.ok) { setMsg(chapterPayload?.error ?? "Não foi possível criar o capítulo."); setBusy(false); return; }

    const chapterId = chapterPayload.chapter.id;
    const supabase = createClient();

    for (let i=0;i<files.length;i++) {
      const file=files[i];
      const prepare=await fetch(`/api/chapters/${chapterId}/pages/upload-url`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({pageNumber:i+1,filename:file.name,contentType:file.type}),
      });
      const payload=await prepare.json().catch(()=>null);
      if(!prepare.ok){setMsg(payload?.error??"Falha ao preparar página.");setBusy(false);return;}

      const { error } = await supabase.storage.from("manga-pages")
        .uploadToSignedUrl(payload.path,payload.token,file,{contentType:file.type});
      if(error){setMsg(error.message);setBusy(false);return;}
    }

    await saveAnonymousWork({
      seriesId:id,isBookmarked:false,isFavorite:false,translationCompleted:false,
      lastChapterId:chapterId,lastPageNumber:1,updatedAt:new Date().toISOString(),
    });

    const enqueue=await fetch(`/api/chapters/${chapterId}/enqueue`,{method:"POST"});
    const enqueuePayload=await enqueue.json().catch(()=>null);
    if(!enqueue.ok){setMsg(enqueuePayload?.error??"Não foi possível iniciar o processamento.");setBusy(false);return;}

    router.push("/reader/"+id);
  }

  return (
    <main className="auth">
      <div className="card">
        <small>IMPORTAR CAPÍTULO</small>
        <h1>Adicionar páginas</h1>
        <p>Selecione as imagens na ordem em que aparecem no capítulo.</p>
        <label>Capítulo<input type="number" min="0" step="0.1" value={chapter} onChange={e=>setChapter(e.target.value)}/></label>
        <label>Imagens<input type="file" accept="image/*" multiple onChange={e=>setFiles(Array.from(e.target.files??[]))}/></label>
        <p>{files.length} página(s) selecionada(s).</p>
        <button className="button primary" disabled={busy||!files.length} onClick={submit}>{busy?"Enviando…":"Importar capítulo"}</button>
        {msg&&<p className="err">{msg}</p>}
      </div>
    </main>
  );
}
