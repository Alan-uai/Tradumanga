import { NextResponse } from "next/server";
import { assertChapterAccess } from "@/lib/anonymous/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

export async function POST(_req:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const {id}=await params;
    const access=await assertChapterAccess(id);
    if(!access)return NextResponse.json({error:"Acesso negado."},{status:403});
    const {ids}=await inngest.send({id:`chapter:${id}`,name:"tradumanga/chapter.process",data:{chapterId:id}});
    const admin=createAdminClient();
    const {error}=await admin.from("chapters").update({status:"processing",error_message:null,pipeline_version:"v3-inngest"}).eq("id",id);
    if(error)return NextResponse.json({error:error.message},{status:500});
    return NextResponse.json({eventId:ids[0],chapterId:id});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Falha ao iniciar processamento."},{status:500});}
}
