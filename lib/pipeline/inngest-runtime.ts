import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import sharp, { type OverlayOptions, type TextAlign } from "sharp";
import { pdf } from "pdf-to-img";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalizeSourceUrl } from "@/lib/ingest/url";
import { editPageWithNanoBanana2 } from "@/lib/pipeline/gemini";

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
  source_text: string | null;
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

async function fetchSafe(raw: string, html=false, extraHeaders:Record<string,string>={}) {
  let current=await assertSafeUrl(raw);
  for(let hop=0;hop<5;hop++){
    const response=await fetch(current,{redirect:"manual",headers:{
      "user-agent":"Mozilla/5.0 (compatible; Tradumanga/3.0)",
      "accept":html?"text/html,application/xhtml+xml;q=0.9,*/*;q=0.8":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      ...extraHeaders,
    },signal:AbortSignal.timeout(html?60000:90000)});
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

type ImageCandidate = {
  url: string;
  order: number;
  context: string;
  selectorHint: boolean;
  scoreHint: number;
};

type InspectedImage = ImageCandidate & {
  width: number;
  height: number;
  bytes: number;
  format: string | null;
  score: number;
};

const IMAGE_ATTR_RE=/(?:src|data-src|data-original|data-lazy-src|data-full-url|data-image-url|data-url|srcset|data-srcset)=["']([^"']+)["']/gi;
const STRONG_READER_RE=/(?:wp-manga-chapter-img|reading-content|page-break|chapter-images|chaptercontent|readerarea|read-content|manga-reader|chapter-img|chapter-image|embedded-chapter-images)/i;
const BAD_RE=/(?:logo|banner|header|footer|avatar|thumbnail|thumb|cover|icon|favicon|social|related|recommended|author|profile|advert|sidebar|menu|loading|placeholder)/i;

function splitSrcset(value:string){
  return value.split(",").map(v=>v.trim().split(/\s+/)[0]).filter(Boolean);
}

function tagContext(tag:string){
  const cls=tag.match(/(?:class|id)=["']([^"']+)["']/i)?.[1]??"";
  const alt=tag.match(/alt=["']([^"']+)["']/i)?.[1]??"";
  return `${cls} ${alt}`;
}

function addImageCandidate(out:ImageCandidate[],seen:Set<string>,raw:string,base:string,context:string,orderRef:{value:number}){
  try{
    const decoded=decode(raw.trim());
    if(!decoded||/^data:/i.test(decoded))return;
    const u=new URL(decoded,base);
    if(!/^https?:$/i.test(u.protocol))return;
    u.hash="";
    const url=u.toString();
    if(seen.has(url))return;
    seen.add(url);
    const strong=STRONG_READER_RE.test(context),bad=BAD_RE.test(context);
    out.push({url,order:orderRef.value++,context,selectorHint:strong,scoreHint:(strong?140:0)-(bad?180:0)});
  }catch{}
}

/**
 * Madara first: the chapter images are normally inside .reading-content and
 * carry .wp-manga-chapter-img. This is intentionally higher priority than
 * generic <img> discovery so site chrome can never win merely by appearing
 * earlier in the HTML.
 */
function embeddedChapterImageUrls(html:string){
  const out:string[]=[];
  const assignmentRe=/(?:(?:var|let|const)\s+)?(?:chapter_preloaded_images|chapter_images|chapterImages|chapter_images_data|chapterImagesData)\s*=\s*/gi;
  for(const match of html.matchAll(assignmentRe)){
    const start=(match.index??0)+match[0].length;
    const open=html.indexOf("[",start);
    if(open<0)continue;
    let depth=0,quote="",escaped=false,end=-1;
    for(let i=open;i<html.length;i++){
      const ch=html[i];
      if(quote){
        if(escaped){escaped=false;continue;}
        if(ch==="\\"){escaped=true;continue;}
        if(ch===quote)quote="";
        continue;
      }
      if(ch==='"'||ch==="'"){quote=ch;continue;}
      if(ch==="[")depth++;
      else if(ch==="]"){
        depth--;
        if(depth===0){end=i;break;}
      }
    }
    if(end<0)continue;
    const block=html.slice(open,end+1).replace(/\\\//g,"/");
    const urlRe=/(["'])((?:https?:)?\/\/[^"'\s<>]+)\1/gi;
    for(const m of block.matchAll(urlRe)){
      const value=m[2].startsWith("//")?"https:"+m[2]:m[2];
      if(!out.includes(value))out.push(value);
    }
  }
  return out;
}

function imageUrls(html:string,base:string){
  const out:ImageCandidate[]=[],seen=new Set<string>(),orderRef={value:0};

  const pushTags=(tags:string[],forceReader:boolean)=>{
    for(const tag of tags){
      const context=tagContext(tag);
      const reader=forceReader||STRONG_READER_RE.test(context);
      const attrs=[...tag.matchAll(IMAGE_ATTR_RE)];
      for(const m of attrs){
        const values=m[0].toLowerCase().startsWith("srcset")||m[0].toLowerCase().startsWith("data-srcset")
          ?splitSrcset(m[1]):[m[1]];
        for(const value of values)addImageCandidate(out,seen,value,base,reader?`reader ${context}`:context,orderRef);
      }
      if(out.length>=MAX_HTML_IMAGES)return;
    }
  };

  const allTags=html.match(/<img\b[^>]*>/gi)??[];
  const readerTags=allTags.filter(tag=>{
    const ctx=tagContext(tag);
    return /wp-manga-chapter-img/i.test(ctx)||/reading-content/i.test(ctx)||/page-break/i.test(ctx)||/readerarea/i.test(ctx);
  });
  pushTags(readerTags,true);

  // Some Madara child themes keep only one page in the initial paged reader.
  // The list view exposes the complete chapter image set as static HTML.
  if(out.length<2){
    const listTags=allTags.filter(tag=>/wp-manga-chapter-img/i.test(tagContext(tag)));
    pushTags(listTags,true);
  }

  // Generic reader containers used by non-standard Madara themes.
  if(out.length<2){
    const containerRe=/<(?:div|section|main)[^>]+(?:reading-content|read-content|readerarea|chapter-content|chapter-images|chaptercontent)[^>]*>[\s\S]*?<\/(?:div|section|main)>/gi;
    for(const block of html.match(containerRe)??[]){
      pushTags(block.match(/<img\b[^>]*>/gi)??[],true);
      if(out.length>=MAX_HTML_IMAGES)break;
    }
  }

  // Only after all reader-specific selectors are exhausted do we inspect
  // generic images. These remain candidates, but receive no reader bonus.
  if(out.length<2)pushTags(allTags,false);

  // Madara child themes frequently keep the complete chapter in a JS array
  // while the paged HTML contains only the first/last visible page.
  // Prefer these embedded chapter arrays over generic image discovery.
  for(const embedded of embeddedChapterImageUrls(html)){
    addImageCandidate(out,seen,embedded,base,"reader embedded-chapter-images",orderRef);
    if(out.length>=MAX_HTML_IMAGES)break;
  }

  // URLs embedded in JS are a common Madara lazy/paged-reader fallback.
  const directImageRe=/https?:\/\/[^"'\s<>\\]+\.(?:jpe?g|png|webp|gif|bmp|avif)(?:\?[^"'\s<>\\]*)?/gi;
  for(const m of html.matchAll(directImageRe)){
    addImageCandidate(out,seen,m[0],base,"direct-reader-js",orderRef);
    if(out.length>=MAX_HTML_IMAGES)break;
  }

  // Some themes JSON-escape the slashes inside chapter_images:
  // https:\/\/cdn.example/page_0002.webp
  const escapedImageRe=/https?:\\\/\\\/[^"'\s<>\\]+\.(?:jpe?g|png|webp|gif|bmp|avif)(?:\\?[^"'\s<>\\]*)?/gi;
  for(const m of html.matchAll(escapedImageRe)){
    const value=m[0].replace(/\\\//g,"/");
    addImageCandidate(out,seen,value,base,"reader escaped-js",orderRef);
    if(out.length>=MAX_HTML_IMAGES)break;
  }

  return out.slice(0,MAX_HTML_IMAGES);
}

function imageFamily(url:string){
  try{
    const u=new URL(url),parts=u.pathname.split("/").filter(Boolean);
    return parts.length>1?`${u.host}/${parts.slice(0,-1).join("/")}/`:u.host;
  }catch{return url;}
}

function isCompositeCandidate(item:InspectedImage){
  const ratio=item.height/Math.max(1,item.width);
  return ratio>=6 && item.height>=6000 && item.width>=500;
}

async function splitCompositeChapterImage(buffer:Buffer){
  const meta=await sharp(buffer,{failOn:"warning"}).metadata();
  const width=meta.width??0,height=meta.height??0;
  if(!width||!height||height/Math.max(1,width)<6)return null;

  // Madara may deliver an entire chapter as one vertically stitched bitmap.
  // We inspect a small grayscale proxy only to locate page gutters; the
  // original pixels are extracted at full resolution afterwards.
  const proxyWidth=Math.min(240,width);
  const proxy=await sharp(buffer,{failOn:"warning"})
    .resize({width:proxyWidth,withoutEnlargement:true})
    .greyscale()
    .raw()
    .toBuffer({resolveWithObject:true});
  const rows=proxy.info.height;
  const stride=proxy.info.channels;
  const candidates:number[]=[];
  let runStart=-1;

  const flushRun=(end:number)=>{
    if(runStart<0)return;
    const length=end-runStart;
    if(length>=4){
      const y=Math.round((runStart+end-1)/2);
      candidates.push(Math.round(y*height/rows));
    }
    runStart=-1;
  };

  for(let y=0;y<rows;y++){
    let sum=0,sumSq=0,light=0,dark=0,count=0;
    for(let x=0;x<proxy.info.width;x++){
      const value=proxy.data[(y*proxy.info.width+x)*stride];
      sum+=value; sumSq+=value*value; count++;
      if(value>=245)light++;
      if(value<=12)dark++;
    }
    const mean=sum/Math.max(1,count);
    const variance=Math.max(0,sumSq/Math.max(1,count)-mean*mean);
    const std=Math.sqrt(variance);
    const uniform=std<=18 && Math.max(light,dark)/Math.max(1,count)>=0.94;
    if(uniform){
      if(runStart<0)runStart=y;
    }else{
      flushRun(y);
    }
  }
  flushRun(rows);

  // A real page is normally at least ~0.55x the image width. Reject
  // accidental cuts inside panels and merge cuts that are too close.
  const minSegment=Math.round(width*0.55);
  const maxSegment=Math.round(width*4.5);
  const merged:number[]=[];
  for(const cut of candidates){
    if(cut<=minSegment||cut>=height-minSegment)continue;
    if(!merged.length||cut-merged[merged.length-1]>=Math.round(width*0.08)){
      merged.push(cut);
    }
  }

  // If gutters were not detectable, do not blindly chop a genuine long
  // webtoon page. The importer will keep its original safety failure.
  if(!merged.length)return null;

  const boundaries=[0,...merged,height];
  const segments:Buffer[]=[];
  for(let i=0;i<boundaries.length-1;i++){
    const top=boundaries[i],bottom=boundaries[i+1],segmentHeight=bottom-top;
    if(segmentHeight<minSegment||segmentHeight>maxSegment)return null;
    const segment=await sharp(buffer,{failOn:"warning"})
      .extract({left:0,top,width,height:segmentHeight})
      .png()
      .toBuffer();
    segments.push(segment);
  }

  return segments.length>=2?segments:null;
}

async function inspectImageCandidates(candidates:ImageCandidate[],referer:string){
  const results:InspectedImage[]=[];
  let cursor=0;
  const worker=async()=>{
    while(true){
      const index=cursor++;
      if(index>=candidates.length)return;
      const candidate=candidates[index];
      try{
        const r=await fetchSafe(candidate.url,false,{referer});
        if(!r.contentType.startsWith("image/"))continue;
        const m=await sharp(r.buffer,{failOn:"warning"}).metadata();
        const width=m.width??0,height=m.height??0;
        if(width<300||height<300)continue;
        const ratio=height/Math.max(1,width);
        const score=candidate.scoreHint
          +(candidate.selectorHint?80:0)
          +(ratio>=2.5?90:ratio>=1.8?55:ratio>=1.25?10:-70)
          +(width>=600?20:0)
          +(height>=1200?20:0)
          +(r.buffer.byteLength>=50000?5:0);
        results.push({...candidate,width,height,bytes:r.buffer.byteLength,format:m.format??null,score});
      }catch{}
    }
  };
  await Promise.all(Array.from({length:Math.min(8,candidates.length)},worker));
  return results.sort((a,b)=>a.order-b.order);
}

function selectChapterImages(items:InspectedImage[]){
  if(!items.length)return {selected:[] as InspectedImage[],version:"v4",reason:"no-valid-images"};

  const strong=items.filter(x=>x.selectorHint);
  // If the site explicitly identifies chapter images, trust that structure.
  // Dimension filtering only removes obvious non-page placeholders.
  let selected=strong.filter(x=>x.height/x.width>=1.15);
  if(selected.length>=2){
    return {selected:selected.sort((a,b)=>a.order-b.order),version:"v4",reason:"reader-selector",family:imageFamily(selected[0].url)};
  }

  // Fallback: find the dominant visual family of long images.
  const long=items.filter(x=>x.height/x.width>=1.8&&x.score>=0);
  const groups=new Map<string,InspectedImage[]>();
  for(const x of long){
    const key=imageFamily(x.url);
    const list=groups.get(key)??[];list.push(x);groups.set(key,list);
  }
  const ranked=[...groups.values()].sort((a,b)=>b.length-a.length);
  selected=ranked[0]??[];
  if(selected.length<2){
    const best=items.filter(x=>x.height/x.width>=1.8&&x.score>=0).sort((a,b)=>b.score-a.score);
    selected=best.length?best:[];
  }
  return {selected:selected.sort((a,b)=>a.order-b.order),version:"v4",reason:"dominant-long-family",family:selected[0]?imageFamily(selected[0].url):null};
}

const actorPrefix=(s:{owner_id:string|null;anonymous_session_id:string|null})=>s.owner_id??s.anonymous_session_id??(()=>{throw new Error("Obra sem proprietário ou sessão anônima.")})();
type SeriesAsset = { url:string; width:number; height:number; score:number; format:string|null };

function seriesAssetCandidates(html:string,base:string){
  const out:{url:string;score:number;kind:"logo"|"banner"}[]=[]; const seen=new Set<string>();
  const add=(raw:string,score:number,kind:"logo"|"banner")=>{
    try{
      const decoded=decode(raw.trim()); if(!decoded||/^data:/i.test(decoded))return;
      const u=new URL(decoded,base); if(!/^https?:$/i.test(u.protocol))return;
      u.hash=""; const url=u.toString(); if(seen.has(url+"|"+kind))return; seen.add(url+"|"+kind);
      out.push({url,score,kind});
    }catch{}
  };
  const metaImage=meta(html,"og:image")||meta(html,"twitter:image")||meta(html,"image_src");
  if(metaImage)add(metaImage,180,"banner");
  const tags=html.match(/<img\b[^>]*>/gi)??[];
  for(const tag of tags.slice(0,160)){
    const context=tagContext(tag);
    if(BAD_RE.test(context)&&!/(?:manga|manhwa|series|comic|work|title)/i.test(context))continue;
    const attrs=[...tag.matchAll(IMAGE_ATTR_RE)];
    for(const m of attrs){
      const values=/srcset|data-srcset/i.test(m[0])?splitSrcset(m[1]):[m[1]];
      for(const raw of values){
        const logo=/(?:manga|manhwa|series|comic|work)[-_ ]?(?:logo|brand)|(?:^|[\s_-])(?:logo|brand|emblem)(?:[\s_-]|$)/i.test(context);
        const banner=/(?:cover|poster|banner|hero|featured|summary[_-]?image|manga[_-]?image)/i.test(context);
        if(logo)add(raw,190+(/(?:manga|manhwa|series|comic|work)/i.test(context)?60:0),"logo");
        else if(banner)add(raw,155,"banner");
      }
    }
  }
  return out.slice(0,80);
}

async function detectSeriesAssets(html:string,base:string){
  const candidates=seriesAssetCandidates(html,base), inspected:SeriesAsset[]=[];
  let cursor=0;
  const worker=async()=>{
    while(true){
      const i=cursor++,candidate=candidates[i]; if(!candidate)return;
      try{
        const r=await fetchSafe(candidate.url,false,{referer:base});
        if(!r.contentType.startsWith("image/"))continue;
        const m=await sharp(r.buffer,{failOn:"warning"}).metadata(),width=m.width??0,height=m.height??0;
        if(width<180||height<80)continue;
        const ratio=width/Math.max(1,height);
        let score=candidate.score;
        if(candidate.kind==="banner")score+=ratio>=1.35?90:ratio>=1.05?30:-60;
        if(candidate.kind==="logo")score+=ratio<=5&&ratio>=0.35?70:-50;
        if(width>=500)score+=15;
        if(height>=180)score+=10;
        inspected.push({url:candidate.url,width,height,score,format:m.format??null});
      }catch{}
    }
  };
  await Promise.all(Array.from({length:Math.min(6,candidates.length)},worker));
  const pick=(kind:"logo"|"banner")=>{
    const ranked=candidates.filter(c=>c.kind===kind).map(c=>inspected.find(x=>x.url===c.url));
    return ranked.filter(Boolean).sort((a,b)=>(b!.score-a!.score))[0]??null;
  };
  return {logo:pick("logo"),banner:pick("banner"),candidateCount:candidates.length};
}

async function uploadSeriesAsset(admin:any,series:any,asset:SeriesAsset,referer:string,kind:"banner"|"logo"){
  const r=await fetchSafe(asset.url,false,{referer});
  const png=await sharp(r.buffer).png().toBuffer();
  const prefix=actorPrefix(series);
  const storagePath=prefix+"/"+series.id+"/assets/"+kind+".png";
  const {error}=await admin.storage.from("manga-pages").upload(storagePath,png,{contentType:"image/png",upsert:true});
  if(error)throw error;
  return storagePath;
}

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
    let {buffer,url}=await fetchSafe(chapter.source_url,true);
    const seriesAssets=await detectSeriesAssets(buffer.toString("utf8"),url);
    const assetPatch:Record<string,unknown>={};
    if(seriesAssets.banner)assetPatch.banner_path=await uploadSeriesAsset(admin,series,seriesAssets.banner,url,"banner");
    if(seriesAssets.logo)assetPatch.logo_path=await uploadSeriesAsset(admin,series,seriesAssets.logo,url,"logo");
    if(seriesAssets.banner)assetPatch.cover_path=assetPatch.banner_path;
    else if(seriesAssets.logo)assetPatch.cover_path=assetPatch.logo_path;
    if(Object.keys(assetPatch).length){
      const {error}=await admin.from("manga_series").update(assetPatch).eq("id",series.id);
      if(error)throw error;
    }
    let candidates=imageUrls(buffer.toString("utf8"),url);

    // Madara's paged reader can expose only the first/last page in the
    // initial HTML. The ?style=list variant is the authoritative static
    // representation for the complete chapter and must be checked even when
    // the paged HTML already yielded 2+ candidates.
    try{
      const sourceUrl=new URL(chapter.source_url);
      if(sourceUrl.searchParams.get("style")!=="list"){
        const listUrl=new URL(sourceUrl);
        listUrl.searchParams.set("style","list");
        const listResponse=await fetchSafe(listUrl.toString(),true);
        const listCandidates=imageUrls(listResponse.buffer.toString("utf8"),listResponse.url);
        // The list view is authoritative for Madara. Even if the initial
        // paged HTML yielded first/last images, replace it whenever the list
        // view exposes more pages. Embedded JS arrays are included by
        // imageUrls(), so this also covers child themes that lazy-load pages.
        if(listCandidates.length>candidates.length){
          buffer=listResponse.buffer;
          url=listResponse.url;
          candidates=listCandidates;
        }
      }
    }catch(error){
      console.warn(JSON.stringify({
        event:"madara_list_variant_failed",
        error:error instanceof Error?error.message:String(error),
      }));
    }

    if(!candidates.length)throw new Error("Nenhuma imagem candidata foi encontrada na URL. A fonte exige JavaScript ou um extrator específico.");
    const inspected=await inspectImageCandidates(candidates,url);
    const selection=selectChapterImages(inspected);
    if(!selection.selected.length)throw new Error("Nenhuma imagem de página do capítulo foi identificada.");

    // Some Madara installations store the complete chapter as one very tall
    // bitmap. It is still a valid chapter source, but Nano Banana 2 cannot
    // reliably edit an arbitrary 1:12+ canvas in one request. Split it at
    // detected page gutters, translate each segment independently, and keep
    // the segments as ordered chapter pages. No pixels are discarded.
    let compositeSegments:Buffer[]|null=null;
    if(selection.selected.length===1 && isCompositeCandidate(selection.selected[0])){
      const only=selection.selected[0];
      const composite=await fetchSafe(only.url,false,{referer:url});
      if(!composite.contentType.startsWith("image/"))
        throw new Error(`A imagem composta selecionada não retornou imagem: ${only.url}`);
      compositeSegments=await splitCompositeChapterImage(composite.buffer);
      if(!compositeSegments?.length){
        throw new Error(`A fonte entregou uma imagem composta (${only.width}x${only.height}), mas não foi possível identificar com segurança as divisões entre páginas.`);
      }
      console.info(JSON.stringify({
        event:"madara_composite_split",
        width:only.width,
        height:only.height,
        segment_count:compositeSegments.length,
      }));
    }else if(selection.selected.length===1){
      const only=selection.selected[0];
      throw new Error(`A detecção encontrou somente uma imagem ambígua (${only.width}x${only.height}); importação abortada para evitar logo/banner/capa.`);
    }

    const previousPages=await admin.from("pages").select("id,original_path").eq("chapter_id",chapter.id);
    if(previousPages.error)throw previousPages.error;

    // Reimport is destructive only to this chapter's previous pages. It never
    // touches another chapter or another work.
    if((previousPages.data??[]).length){
      const ids=(previousPages.data??[]).map((p:any)=>p.id);
      const paths=(previousPages.data??[]).map((p:any)=>p.original_path).filter(Boolean);
      const {error:e1}=await admin.from("speech_bubbles").delete().in("page_id",ids);if(e1)throw e1;
      const {error:e2}=await admin.from("page_analyses").delete().in("page_id",ids);if(e2)throw e2;
      const {error:e3}=await admin.from("translation_jobs").delete().in("page_id",ids);if(e3)throw e3;
      if(paths.length){const {error:e4}=await admin.storage.from("manga-pages").remove(paths);if(e4)throw e4;}
      const {error:e5}=await admin.from("pages").delete().in("id",ids);if(e5)throw e5;
    }

    let total=0,count=0;
    if(compositeSegments?.length){
      for(const segment of compositeSegments){
        total+=segment.byteLength;
        if(total>MAX_HTML_TOTAL_BYTES)throw new Error("O conjunto de páginas excede o limite de tamanho configurado.");
        await uploadPage(admin,series,{...chapter,chapter_number:detected.chapterNumber??chapter.chapter_number},segment,++count);
      }
    }else{
      for(const item of selection.selected){
        const r=await fetchSafe(item.url,false,{referer:url});
        if(!r.contentType.startsWith("image/"))throw new Error(`A página selecionada não retornou imagem: ${item.url}`);
        total+=r.buffer.byteLength;
        if(total>MAX_HTML_TOTAL_BYTES)throw new Error("O conjunto de páginas excede o limite de tamanho configurado.");
        await uploadPage(admin,series,{...chapter,chapter_number:detected.chapterNumber??chapter.chapter_number},await sharp(r.buffer).png().toBuffer(),++count);
      }
    }
    const importedPageCount=compositeSegments?.length??selection.selected.length;
    if(count!==importedPageCount)throw new Error(`A detecção selecionou ${importedPageCount} páginas, mas somente ${count} foram baixadas.`);

    await admin.from("chapters").update({
      source_metadata:{
        ...(detected as any),
        image_detection:{
          version:selection.version,
          reason:selection.reason,
          candidate_count:candidates.length,
          inspected_count:inspected.length,
          selected_page_count:compositeSegments?.length??selection.selected.length,\n          composite_split:compositeSegments?true:false,
          selected_family:selection.family??null,
          series_assets:{logo:seriesAssets.logo?.url??null,banner:seriesAssets.banner?.url??null,candidate_count:seriesAssets.candidateCount},
          source_variant:url===chapter.source_url?"canonical":"style=list",
        },
      },
    }).eq("id",chapter.id);
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
async function fitLayer(buf:Buffer,w:number,h:number){
  const m=await sharp(buf).metadata(),iw=m.width??0,ih=m.height??0;
  if(!iw||!ih)throw new Error("Camada de imagem inválida.");
  const resized=await sharp(buf).ensureAlpha()
    .resize({width:Math.max(1,w),height:Math.max(1,h),fit:"fill"})
    .png().toBuffer();
  const exact=await sharp(resized).metadata();
  if(exact.width!==w||exact.height!==h)throw new Error("Camada de texto com dimensões incompatíveis.");
  return{buf:resized,w,h};
}
async function safeMaskBuffer(mask:Buffer,w:number,h:number){
  const normalized=await sharp(mask).ensureAlpha()
    .resize({width:Math.max(1,w),height:Math.max(1,h),fit:"fill"})
    .png().toBuffer();
  const m=await sharp(normalized).metadata();
  if(m.width!==w||m.height!==h)throw new Error("Máscara com dimensões incompatíveis.");
  return normalized;
}
async function renderTextLayer(input:{text:string;vertical:boolean;align:TextAlign;font?:string;width:number;height:number}){
  const lines=input.text.split(/\n+/).filter(Boolean);
  const maxLine=Math.max(1,...lines.map(line=>line.length));
  const fontSize=Math.max(10,Math.min(28,Math.floor(Math.min(input.height/Math.max(1,lines.length)*0.78,input.width/Math.max(1,Math.min(maxLine,18))*1.55))));
  const build=(font?:string)=>sharp({text:{text:input.vertical?[...input.text.replace(/\s+/g,"")].join("\n"):input.text,font:font||("sans "+fontSize),width:input.width,height:input.height,align:input.align,rgba:true,wrap:"word-char",spacing:2}}).png().toBuffer();
  try{return await build(input.font||"sans");}catch(error){
    console.warn(JSON.stringify({event:"render_font_fallback",font:input.font,error:error instanceof Error?error.message:String(error)}));
    try{return await build();}catch(fallbackError){
      console.warn(JSON.stringify({event:"render_text_failed",error:fallbackError instanceof Error?fallbackError.message:String(fallbackError)}));
      return null;
    }
  }
}
export async function renderTranslatedPage(original:Buffer,bubbles:RenderBubble[]){
  const meta=await sharp(original).metadata(),w=meta.width??0,h=meta.height??0;
  if(!w||!h)throw new Error("Imagem original inválida.");

  const edits=[] as Array<{
    bubble_index:number;
    source_text:string|null;
    translated_text:string;
    bbox:{x:number;y:number;width:number;height:number};
    polygon:unknown;
  }>;
  const maskLayers:OverlayOptions[]=[];

  for(const b of bubbles){
    const text=b.translated_text?.trim(),source=b.source_text?.trim();
    if(!text)continue;
    if(source&&source.localeCompare(text,undefined,{sensitivity:"base"})===0)continue;
    const style=b.style_json??{};
    const textType=String(style.text_type??"dialogue").toLowerCase();
    if(["title","logo","watermark","credit"].includes(textType))continue;
    try{
      const g=geometry(b,w,h);
      const areaRatio=(g.width*g.height)/(w*h),widthRatio=g.width/w,heightRatio=g.height/h;
      if(areaRatio>0.06||widthRatio>0.88||heightRatio>0.14){
        console.warn(JSON.stringify({event:"nano_render_region_rejected",bbox:b.bbox,areaRatio,widthRatio,heightRatio,textType}));
        continue;
      }
      edits.push({bubble_index:edits.length,source_text:source??null,translated_text:text,bbox:g,polygon:g.poly});
      const mask=await safeMaskBuffer(maskSvg(g.width,g.height,g.poly,g.x,g.y),g.width,g.height);
      maskLayers.push({input:mask,left:g.x,top:g.y});
    }catch(error){
      console.warn(JSON.stringify({event:"nano_render_region_skipped",bbox:b.bbox,error:error instanceof Error?error.message:String(error)}));
    }
  }

  if(!edits.length){
    const png=await sharp(original).png().toBuffer();
    const mask=await sharp({create:{width:w,height:h,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
    return {translated:png,mask,qa:{passed:true,changedInsideMask:0,changedOutsideMask:0,width:w,height:h,model:"none"}};
  }

  const rendered=await editPageWithNanoBanana2({
    image:original,
    mimeType:"image/png",
    width:w,
    height:h,
    edits,
  });
  const normalized=await sharp(rendered,{failOn:"warning"})
    .resize({width:w,height:h,fit:"fill"})
    .png().toBuffer();

  let maskPipeline=sharp({create:{width:w,height:h,channels:4,background:{r:255,g:255,b:255,alpha:0}}});
  if(maskLayers.length)maskPipeline=maskPipeline.composite(maskLayers);
  const mask=await maskPipeline.greyscale().png().toBuffer();
  const qa=await inspectNanoOutput(original,normalized,mask);
  return{translated:normalized,mask,qa};
}

async function inspectNanoOutput(original:Buffer,translated:Buffer,mask:Buffer){
  const[a,b,m]=await Promise.all([
    sharp(original).removeAlpha().raw().toBuffer({resolveWithObject:true}),
    sharp(translated).removeAlpha().raw().toBuffer({resolveWithObject:true}),
    sharp(mask).greyscale().raw().toBuffer({resolveWithObject:true}),
  ]);
  if(a.info.width!==b.info.width||a.info.height!==b.info.height||m.info.width!==a.info.width||m.info.height!==a.info.height)
    throw new Error("QA Nano Banana 2: dimensões incompatíveis.");
  let outside=0,inside=0;
  for(let i=0,p=0;i<a.data.length;i+=a.info.channels,p++){
    const changed=a.data[i]!==b.data[i]||a.data[i+1]!==b.data[i+1]||a.data[i+2]!==b.data[i+2];
    if(changed&&m.data[p]>0)inside++;
    if(changed&&m.data[p]===0)outside++;
  }
  if(outside)console.warn(JSON.stringify({event:"nano_render_changed_outside_mask",changedOutsideMask:outside,changedInsideMask:inside}));
  return{passed:true,changedInsideMask:inside,changedOutsideMask:outside,width:a.info.width,height:a.info.height,model:"gemini-3.1-flash-image"};
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
