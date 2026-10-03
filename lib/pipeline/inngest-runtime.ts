import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import sharp from "sharp";
import { pdf } from "pdf-to-img";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalizeSourceUrl } from "@/lib/ingest/url";

const MAX_REMOTE_BYTES = Number(process.env.MAX_REMOTE_BYTES || 250 * 1024 * 1024);
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES || 8 * 1024 * 1024);
const MAX_HTML_IMAGES = Number(process.env.MAX_HTML_IMAGES || 500);
const MAX_HTML_TOTAL_BYTES = Number(process.env.MAX_HTML_TOTAL_BYTES || 500 * 1024 * 1024);

export type DetectedSourceMetadata = {
  title: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  sourceLanguage: string | null;
  extractor: string | null;
  detectionMethod: "html" | "url" | "none";
};
export type RenderBubble = {
  polygon: unknown;
  bbox: unknown;
  translated_text: string | null;
  style_json: Record<string, unknown> | null;
};

export function sha256(data: Uint8Array | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}
const private4 = (ip: string) => {
  const [a,b] = ip.split(".").map(Number);
  return a===10 || a===127 || (a===169&&b===254) || a===0 || (a===172&&b>=16&&b<=31) || (a===192&&b===168);
};
const private6 = (ip: string) => {
  const v=ip.toLowerCase();
  return v==="::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
};

export async function assertSafeUrl(raw: string) {
  const url = new URL(canonicalizeSourceUrl(raw)), host=url.hostname;
  if (host==="localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("URL local não é permitida.");
  if ((net.isIP(host)===4&&private4(host)) || (net.isIP(host)===6&&private6(host))) throw new Error("IP privado não é permitido.");
  const [v4,v6]=await Promise.all([dns.resolve4(host).catch(()=>[] as string[]),dns.resolve6(host).catch(()=>[] as string[])]);
  for(const ip of [...v4,...v6]) if((net.isIP(ip)===4&&private4(ip))||(net.isIP(ip)===6&&private6(ip))) throw new Error("O host resolve para uma rede privada e foi bloqueado.");
  return url.toString();
}

async function fetchSafe(raw: string, html=false) {
  let current=await assertSafeUrl(raw);
  for(let hop=0;hop<5;hop++){
    const response=await fetch(current,{redirect:"manual",headers:{"user-agent":"Mozilla/5.0 (compatible; Tradumanga/2.0)"},signal:AbortSignal.timeout(html?60000:90000)});
    if(response.status>=300&&response.status<400){
      const location=response.headers.get("location"); if(!location) throw new Error("Redirecionamento sem destino.");
      current=await assertSafeUrl(new URL(location,current).toString()); continue;
    }
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const limit=html?MAX_HTML_BYTES:MAX_REMOTE_BYTES, len=Number(response.headers.get("content-length")||0);
    if(len>limit) throw new Error("Fonte remota excede o limite de tamanho.");
    const buffer=Buffer.from(await response.arrayBuffer()); if(buffer.byteLength>limit) throw new Error("Fonte remota excede o limite de tamanho.");
    return {buffer,url:current,contentType:(response.headers.get("content-type")||"").split(";")[0].toLowerCase()};
  }
  throw new Error("Redirecionamentos demais.");
}
const clean=(v: unknown)=>typeof v==="string"?v.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()||null:null;
const decode=(v:string)=>v.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">");
function meta(html:string,key:string){
  const k=key.replace(/[.*+?^()|[\\]\\\\]/g,"\\\\$&");
  const a=new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']+)["'][^>]*>`,"i");
  const b=new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${k}["'][^>]*>`,"i");
  return clean(html.match(a)?.[1]||html.match(b)?.[1]||"");
}
function chapterNo(...values:unknown[]){
  const p=[/(?:chapter|cap(?:í|i)tulo|cap|ch|episode|ep)[\s._:#-]*(\d+(?:[.,]\d+)?)/i,/[/_-](\d+(?:[.,]\d+)?)(?:\D*)$/i];
  for(const v of values){ if(typeof v==="number"&&Number.isFinite(v)) return v; if(typeof v!=="string") continue;
    for(const r of p){const m=v.match(r);if(m){const n=Number(m[1].replace(",","."));if(Number.isFinite(n)&&n>=0&&n<100000)return n;}}
  } return null;
}
const strip=(v:string|null)=>v?v.replace(/\s*[-|–—:]?\s*(?:chapter|cap(?:í|i)tulo|cap|ch|episode|ep)\s*[#.: -]*\d+(?:[.,]\d+)?(?:\s*[-|–—:]\s*.*)?$/i,"").trim()||null:null;
function language(v:unknown){
  if(typeof v!=="string")return null; const x=v.toLowerCase().trim();
  const m:Record<string,string>={japanese:"ja",japonês:"ja",ja:"ja",korean:"ko",coreano:"ko",ko:"ko",chinese:"zh",chinês:"zh",zh:"zh",english:"en",inglês:"en",en:"en",spanish:"es",espanhol:"es",es:"es",portuguese:"pt-BR",português:"pt-BR","pt-br":"pt-BR",pt:"pt-BR"};
  return m[x]??(x.match(/^[a-z]{2}(?:-[a-z]{2})?$/i)?x:null);
}

export async function detectSourceMetadata(url:string):Promise<DetectedSourceMetadata>{
  const safe=await assertSafeUrl(url);
  try{
    const {buffer,url:finalUrl}=await fetchSafe(safe,true),html=buffer.toString("utf8");
    const raw=meta(html,"og:title")??clean(html.match(new RegExp("<title[^>]*>([\\s\\S]*?)<\\/title>","i"))?.[1])??meta(html,"og:site_name");
    const title=strip(raw)??raw;
    return {title,chapterNumber:chapterNo(finalUrl,raw),chapterTitle:raw&&title&&raw!==title?raw:null,sourceLanguage:language(meta(html,"og:locale")),extractor:new URL(finalUrl).hostname,detectionMethod:"html"};
  }catch{
    const last=decodeURIComponent(safe.split("/").filter(Boolean).pop()??"").replace(/[-_]+/g," ").trim();
    return {title:strip(last),chapterNumber:chapterNo(safe,last),chapterTitle:null,sourceLanguage:null,extractor:null,detectionMethod:last?"url":"none"};
  }
}

function imageUrls(html:string,base:string){
  const out:string[]=[],seen=new Set<string>();
  const add=(raw:string)=>{
    try{
      const u=new URL(decode(raw),base).toString();
      if(!seen.has(u)&&/^https?:$/i.test(new URL(u).protocol)){seen.add(u);out.push(u);}
    }catch{}
  };
  const imgTagRe=new RegExp("<img\\b[^>]*>","gi");
  const attrRe=/(?:data-src|data-original|data-lazy-src|data-url|src|data-srcset)=["']([^"']+)["']/gi;
  for(const tag of html.match(imgTagRe)??[]){
    for(const m of tag.matchAll(attrRe)){
      add(m[1].split(",")[0].trim().split(/\s+/)[0]);
    }
    if(out.length>=MAX_HTML_IMAGES)break;
  }
  const directImageRe=/https?:\/\/[^"'\s<>]+\.(?:jpe?g|png|webp)(?:\?[^"'\s<>]*)?/gi;
  for(const m of html.matchAll(directImageRe)){
    add(m[0]);
    if(out.length>=MAX_HTML_IMAGES)break;
  }
  return out.slice(0,MAX_HTML_IMAGES);
}
const actorPrefix=(s:{owner_id:string|null;anonymous_session_id:string|null})=>s.owner_id??s.anonymous_session_id??(()=>{throw new Error("Obra sem proprietário ou sessão anônima.")})();
async function uploadPage(admin:any,series:any,chapter:any,buffer:Buffer,pageNumber:number){
  const meta=await sharp(buffer,{failOn:"warning"}).metadata();if(!meta.width||!meta.height)throw new Error(`Página ${pageNumber} inválida.`);
  const prefix=actorPrefix(series),hash=sha256(buffer),storagePath=`${prefix}/${series.id}/${chapter.chapter_number}/pages/${String(pageNumber).padStart(4,"0")}.png`;
  const {error:up}=await admin.storage.from("manga-pages").upload(storagePath,buffer,{contentType:"image/png",upsert:true});if(up)throw up;
  const {error}=await admin.from("pages").upsert({chapter_id:chapter.id,page_number:pageNumber,original_path:storagePath,translated_path:null,width:meta.width,height:meta.height,original_sha256:hash,authorized_mask_path:null,render_version:null,status:"queued",error_message:null},{onConflict:"chapter_id,page_number"});
  if(error)throw error;
}

export async function ingestChapter(chapterId:string){
  const admin=createAdminClient();
  const {data:chapter,error:ce}=await admin.from("chapters").select("id,series_id,chapter_number,source_type,source_url,source_path").eq("id",chapterId).single();if(ce||!chapter)throw ce||new Error("Capítulo não encontrado.");
  const {data:series,error:se}=await admin.from("manga_series").select("id,owner_id,anonymous_session_id,title").eq("id",chapter.series_id).single();if(se||!series)throw se||new Error("Obra não encontrada.");
  if(chapter.source_type==="images"){
    const {data:pages,error}=await admin.from("pages").select("id,page_number,original_path,original_sha256").eq("chapter_id",chapter.id).order("page_number");if(error)throw error;
    if(!pages?.length)throw new Error("Capítulo sem imagens.");
    for(const page of pages){const {data,error:e}=await admin.storage.from("manga-pages").download(page.original_path);if(e||!data)throw e||new Error("Falha ao baixar página.");const b=Buffer.from(await data.arrayBuffer()),m=await sharp(b).metadata();if(!m.width||!m.height)throw new Error("Página inválida.");const {error:u}=await admin.from("pages").update({original_sha256:sha256(b),width:m.width,height:m.height,status:"queued",error_message:null}).eq("id",page.id);if(u)throw u;}
  }else if(chapter.source_type==="url"){
    if(!chapter.source_url)throw new Error("Capítulo URL sem source_url.");
    const detected=await detectSourceMetadata(chapter.source_url);
    if(detected.title){const {error}=await admin.from("manga_series").update({title:detected.title,status:"processing"}).eq("id",series.id);if(error)throw error;}
    const patch:Record<string,unknown>={source_canonical_url:await assertSafeUrl(chapter.source_url),source_metadata:detected};
    if(detected.chapterNumber!==null)patch.chapter_number=detected.chapterNumber;if(detected.chapterTitle)patch.title=detected.chapterTitle;
    const {error}=await admin.from("chapters").update(patch).eq("id",chapter.id);if(error)throw error;
    const {buffer,url}=await fetchSafe(chapter.source_url,true),urls=imageUrls(buffer.toString("utf8"),url);if(!urls.length)throw new Error("Nenhuma imagem foi encontrada na URL. A fonte exige JavaScript ou um extrator específico.");
    let total=0,count=0;for(const u of urls){const r=await fetchSafe(u);if(!r.contentType.startsWith("image/"))continue;const m=await sharp(r.buffer).metadata();if(!m.width||!m.height||m.width<200||m.height<200||m.width*m.height<150000)continue;total+=r.buffer.byteLength;if(total>MAX_HTML_TOTAL_BYTES)break;await uploadPage(admin,series,{...chapter,chapter_number:detected.chapterNumber??chapter.chapter_number},await sharp(r.buffer).png().toBuffer(),++count);}
    if(!count)throw new Error("Nenhuma imagem de página válida foi baixada.");
  }else if(chapter.source_type==="pdf"){
    if(!chapter.source_path)throw new Error("PDF sem source_path.");
    const {data,error}=await admin.storage.from("manga-pages").download(chapter.source_path);if(error||!data)throw error||new Error("Falha ao baixar o PDF.");
    const source=Buffer.from(await data.arrayBuffer()),dir=await mkdtemp(path.join(os.tmpdir(),"tradumanga-pdf-"));try{const file=path.join(dir,"source.pdf");await writeFile(file,source);const doc=await pdf(file,{scale:2});let n=0;for await(const image of doc){await uploadPage(admin,series,chapter,Buffer.from(image),++n);}if(!n)throw new Error("PDF sem páginas renderizáveis.");await admin.from("chapters").update({source_sha256:sha256(source)}).eq("id",chapter.id);}finally{await rm(dir,{recursive:true,force:true});}
  }else throw new Error(`Tipo de fonte não suportado: ${chapter.source_type}`);
  const {data:pages,error}=await admin.from("pages").select("id,original_sha256").eq("chapter_id",chapter.id).order("page_number");if(error)throw error;
  const aggregate=sha256(Buffer.from((pages??[]).map(p=>p.original_sha256??"").join("|")));
  await admin.from("chapters").update({source_sha256:aggregate,status:"processing",error_message:null,pipeline_version:"v3-inngest",progress_json:{download:100,analysis:0,context:0,translation:0,render:0,qa:0,overall:15}}).eq("id",chapter.id);
  return {pageIds:(pages??[]).map(p=>p.id)};
}

function point(p:any,w:number,h:number){const x=Number(p?.x??0),y=Number(p?.y??0);return{x:Math.max(0,Math.min(w-1,x<=1?x*w:x)),y:Math.max(0,Math.min(h-1,y<=1?y*h:y))};}
function geometry(b:RenderBubble,w:number,h:number){
  const poly=Array.isArray(b.polygon)?b.polygon.map(p=>point(p,w,h)):[],bb=b.bbox&&typeof b.bbox==="object"?b.bbox as any:{};
  if(poly.length>=3){const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),x=Math.max(0,Math.floor(Math.min(...xs))),y=Math.max(0,Math.floor(Math.min(...ys))),r=Math.min(w-1,Math.ceil(Math.max(...xs))),bt=Math.min(h-1,Math.ceil(Math.max(...ys)));return{x,y,width:Math.max(1,r-x+1),height:Math.max(1,bt-y+1),poly};}
  const x0=Number(bb.x??0),y0=Number(bb.y??0),bw=Number(bb.width??0),bh=Number(bb.height??0),x=Math.max(0,Math.floor(x0<=1?x0*w:x0)),y=Math.max(0,Math.floor(y0<=1?y0*h:y0)),r=Math.min(w-1,Math.ceil(x+(bw<=1?bw*w:bw))),bt=Math.min(h-1,Math.ceil(y+(bh<=1?bh*h:bh)));return{x,y,width:Math.max(1,r-x+1),height:Math.max(1,bt-y+1),poly:[{x,y},{x:r,y},{x:r,y:bt},{x,y:bt}]};
}
function maskSvg(w:number,h:number,poly:{x:number;y:number}[],ox:number,oy:number){const d=poly.map((p,i)=>`${i?"L":"M"}${(p.x-ox).toFixed(1)},${(p.y-oy).toFixed(1)}`).join(" ")+" Z";return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="white"/></svg>`);}
export async function renderTranslatedPage(original:Buffer,bubbles:RenderBubble[]){
  const meta=await sharp(original).metadata(),w=meta.width??0,h=meta.height??0;if(!w||!h)throw new Error("Imagem original inválida.");
  const overlays:sharp.OverlayOptions[]=[],maskLayers:sharp.OverlayOptions[]=[];
  for(const b of bubbles){const text=b.translated_text?.trim();if(!text)continue;const g=geometry(b,w,h),mask=maskSvg(g.width,g.height,g.poly,g.x,g.y);
    const patch=await sharp(original).extract({left:g.x,top:g.y,width:g.width,height:g.height}).median(5).png().toBuffer();
    overlays.push({input:await sharp(patch).composite([{input:mask,blend:"dest-in"}]).png().toBuffer(),left:g.x,top:g.y});
    const style=b.style_json??{},vertical=String(style.orientation??"horizontal").toLowerCase()==="vertical";
    const textLayer=await sharp({text:{text:vertical?[...text.replace(/\s+/g,"")].join("\n"):text,font:String(style.font??"sans"),width:Math.max(1,g.width-12),height:Math.max(1,g.height-12),align:String(style.align??"center"),rgba:true,wrap:"word-char",spacing:4}}).png().toBuffer();
    overlays.push({input:await sharp(textLayer).composite([{input:mask,blend:"dest-in"}]).png().toBuffer(),left:g.x+6,top:g.y+6});maskLayers.push({input:mask,left:g.x,top:g.y});
  }
  const translated=await sharp(original).composite(overlays).png().toBuffer();
  const mask=await sharp({create:{width:w,height:h,channels:4,background:{r:255,g:255,b:255,alpha:0}}}).composite(maskLayers).greyscale().png().toBuffer();
  const qa=await verifyPixelIntegrity(original,translated,mask);return{translated,mask,qa};
}
export async function verifyPixelIntegrity(original:Buffer,translated:Buffer,mask:Buffer){
  const[a,b,m]=await Promise.all([sharp(original).removeAlpha().raw().toBuffer({resolveWithObject:true}),sharp(translated).removeAlpha().raw().toBuffer({resolveWithObject:true}),sharp(mask).greyscale().raw().toBuffer({resolveWithObject:true})]);
  if(a.info.width!==b.info.width||a.info.height!==b.info.height||m.info.width!==a.info.width||m.info.height!==a.info.height)throw new Error("QA: dimensões incompatíveis.");
  let outside=0,inside=0;for(let i=0,p=0;i<a.data.length;i+=a.info.channels,p++){const changed=a.data[i]!==b.data[i]||a.data[i+1]!==b.data[i+1]||a.data[i+2]!==b.data[i+2];if(changed&&m.data[p]>0)inside++;if(changed&&m.data[p]===0)outside++;}
  if(outside)throw new Error(`QA: ${outside} pixels foram alterados fora da máscara autorizada.`);
  return{passed:true,changedInsideMask:inside,changedOutsideMask:outside,width:a.info.width,height:a.info.height};
}
export const progress=async(admin:any,chapterId:string)=>{
  const [{data:pages,error:pe},{data:chapter,error:ce}]=await Promise.all([admin.from("pages").select("status").eq("chapter_id",chapterId),admin.from("chapters").select("context_updated_at").eq("id",chapterId).single()]);if(pe)throw pe;if(ce)throw ce;
  const list=pages??[],total=Math.max(1,list.length),count=(s:string[])=>list.filter((p:any)=>s.includes(p.status)).length;
  const analysis=Math.round(count(["analyzed","translating","translated","rendering","ready"])/total*100),context=chapter?.context_updated_at?100:0,translation=Math.round(count(["translated","rendering","ready"])/total*100),render=Math.round(count(["rendering","ready"])/total*100),qa=Math.round(count(["ready"])/total*100);
  const overall=Math.round(15+analysis*.2+context*.15+translation*.2+render*.2+qa*.1);await admin.from("chapters").update({progress_json:{download:100,analysis,context,translation,render,qa,overall,contextReady:context}}).eq("id",chapterId);
};
export { actorPrefix };
