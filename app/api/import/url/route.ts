import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActor } from "@/lib/anonymous/access";
import { canonicalizeSourceUrl } from "@/lib/ingest/url";
import { inngest } from "@/lib/inngest/client";

function slugify(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}
export async function POST(req: Request) {
  try {
    const body=await req.json(), rawUrl=typeof body?.url==="string"?body.url.trim():"";
    if(!rawUrl)return NextResponse.json({error:"Informe a URL da página de leitura."},{status:400});
    let sourceUrl:string;try{sourceUrl=canonicalizeSourceUrl(rawUrl)}catch(e){return NextResponse.json({error:e instanceof Error?e.message:"URL inválida."},{status:400});}
    const actor=await getActor();if(!actor)return NextResponse.json({error:"Não foi possível iniciar a sessão anônima."},{status:401});
    const admin=createAdminClient();
    const {data:candidates,error:lookupError}=await admin.from("chapters").select("id,series_id,chapter_number,title,status,manga_series!inner(id,title,owner_id,anonymous_session_id,status)").eq("source_canonical_url",sourceUrl).limit(20);
    if(lookupError)return NextResponse.json({error:lookupError.message},{status:500});
    const existing=(candidates??[]).find((item:any)=>actor.userId?item.manga_series.owner_id===actor.userId:item.manga_series.anonymous_session_id===actor.anonymousSessionId);
    if(existing){const s=existing.manga_series as unknown as {id:string;title:string};return NextResponse.json({reused:true,seriesId:s.id,chapterId:existing.id,title:s.title,chapterNumber:existing.chapter_number,status:existing.status});}
    const fingerprint=createHash("sha256").update(sourceUrl).digest("hex").slice(0,16),baseTitle="Detectando obra…",slugBase=slugify("obra-"+fingerprint)||("obra-"+fingerprint);
    let slug=slugBase,suffix=2;while(true){const {data,error}=await admin.from("manga_series").select("id").eq("slug",slug).maybeSingle();if(error)return NextResponse.json({error:error.message},{status:500});if(!data)break;slug=slugBase+"-"+suffix++;}
    const {data:series,error:se}=await admin.from("manga_series").insert({owner_id:actor.userId,anonymous_session_id:actor.anonymousSessionId,title:baseTitle,slug,status:"processing"}).select("id,title,status").single();
    if(se||!series)return NextResponse.json({error:se?.message??"Falha ao criar obra."},{status:500});
    const {data:chapter,error:ce}=await admin.from("chapters").insert({series_id:series.id,chapter_number:0,title:null,status:"processing",source_type:"url",source_url:sourceUrl,source_canonical_url:sourceUrl,pipeline_version:"v3-inngest",progress_json:{stage:"identifying",overall:0,identification:0}}).select("id,chapter_number,status").single();
    if(ce||!chapter){await admin.from("manga_series").delete().eq("id",series.id);return NextResponse.json({error:ce?.message??"Falha ao criar capítulo."},{status:500});}
    try{const {ids}=await inngest.send({id:`chapter:${chapter.id}`,name:"tradumanga/chapter.process",data:{chapterId:chapter.id}});return NextResponse.json({reused:false,seriesId:series.id,chapterId:chapter.id,title:series.title,chapterNumber:chapter.chapter_number,eventId:ids[0]});}
    catch(e){const message=e instanceof Error?e.message:"Falha ao enviar workflow.";await admin.from("chapters").update({status:"error",error_message:message}).eq("id",chapter.id);return NextResponse.json({error:message},{status:500});}
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Falha ao iniciar importação automática."},{status:500});}
}
