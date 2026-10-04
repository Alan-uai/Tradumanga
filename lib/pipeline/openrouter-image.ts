import sharp from "sharp";

export type OpenRouterRenderBubble = {
  polygon: unknown;
  bbox: unknown;
  source_text: string | null;
  translated_text: string | null;
  style_json: Record<string, unknown> | null;
};

type RenderResult = {
  image: Buffer;
  model: string;
  costUsd: number | null;
};

type OpenRouterImageModel = {
  id: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, string | number>;
};

const DEFAULT_MODEL = "google/gemini-3.1-flash-image";
const MAX_ATTEMPTS = 3;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedFreeModels: { expiresAt: number; models: string[] } | null = null;

function sleep(ms:number){ return new Promise((resolve)=>setTimeout(resolve,ms)); }

function retryable(status:number){
  return status===408 || status===409 || status===429 || status>=500;
}

function dataUrl(mime:string,buffer:Buffer){
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function clamp(v:number,min:number,max:number){ return Math.max(min,Math.min(max,v)); }

function normalizePoint(point:unknown,width:number,height:number){
  if(!point || typeof point!=="object") return null;
  const p=point as Record<string,unknown>;
  const x=Number(p.x),y=Number(p.y);
  if(!Number.isFinite(x)||!Number.isFinite(y))return null;
  const normalized=Math.abs(x)<=1.01 && Math.abs(y)<=1.01;
  const px=normalized ? x*width : x;
  const py=normalized ? y*height : y;
  return {x:clamp(px,0,width),y:clamp(py,0,height)};
}

function bubbleDescription(b:OpenRouterRenderBubble,width:number,height:number,index:number){
  const polygon=Array.isArray(b.polygon)
    ? b.polygon.map((p)=>normalizePoint(p,width,height)).filter(Boolean)
    : [];
  const bbox=b.bbox&&typeof b.bbox==="object" ? b.bbox as Record<string,unknown> : {};
  const x=Number(bbox.x),y=Number(bbox.y),bw=Number(bbox.width),bh=Number(bbox.height);
  const normalizedXY=Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x)<=1.01&&Math.abs(y)<=1.01;
  const normalizedSize=Number.isFinite(bw)&&Number.isFinite(bh)&&Math.abs(bw)<=1.01&&Math.abs(bh)<=1.01;
  const bx=Number.isFinite(x)?(normalizedXY?x*width:x):0;
  const by=Number.isFinite(y)?(normalizedXY?y*height:y):0;
  const bwidth=Number.isFinite(bw)?(normalizedSize?bw*width:bw):0;
  const bheight=Number.isFinite(bh)?(normalizedSize?bh*height:bh):0;
  const style=b.style_json??{};
  return {
    index,
    translated_text:b.translated_text?.trim()??"",
    source_text:b.source_text?.trim()??"",
    polygon,
    bbox:{x:clamp(bx,0,width),y:clamp(by,0,height),width:clamp(bwidth,0,width),height:clamp(bheight,0,height)},
    orientation:String(style.orientation??"horizontal"),
    text_type:String(style.text_type??"dialogue"),
    shape:String(style.shape??"oval"),
    text_align:String(style.text_align??"center"),
  };
}

function buildPrompt(bubbles:OpenRouterRenderBubble[],width:number,height:number){
  const regions=bubbles.map((b,i)=>bubbleDescription(b,width,height,i));
  return `EDIT MODE — Tradumanga manga/manhwa translation renderer.

Edit the supplied manga/manhwa page. This is an image EDIT, not a new image generation.

TASK:
Replace ONLY the original visible dialogue/narration text identified in the region list below with the supplied Brazilian Portuguese translations.

REGIONS:
${JSON.stringify(regions)}

STRICT PRESERVATION:
1. Keep the original artwork exactly as it is: characters, faces, hair, anatomy, clothing, scenery, perspective, panels, line art, screentones, colors, lighting, effects, borders and composition.
2. Do not redraw, repaint, enhance, upscale, stylize, clean, crop or reinterpret the page.
3. Do not change any pixels outside the identified text regions.
4. Do not translate logos, watermarks, scanlation credits, URLs, publisher marks, signatures or decorative artwork.
5. Remove the original text cleanly from each identified text region and reconstruct only the underlying local balloon/background texture needed for the replacement.
6. Place the Portuguese text in the same semantic text area, preserving the original reading direction, approximate typography, weight, alignment, curvature and visual hierarchy.
7. Do not invent words or add text that is not present in the translation list.
8. Keep all speech-balloon borders, tails and surrounding artwork unchanged unless the original text physically overlaps them.
9. If a translated phrase is shorter or longer, adapt line breaks and font scale to fit naturally; never spill outside its original text region.
10. The result must be the same page, same framing and same aspect ratio as the input.

TRANSLATION IS ALREADY FINAL. Do not translate it again and do not paraphrase it.

Return the edited image only. `;
}

function isActuallyFreeImageEditor(model:OpenRouterImageModel){
  const input=model.architecture?.input_modalities??[];
  const output=model.architecture?.output_modalities??[];
  const pricing=model.pricing??{};
  const hasImageInput=input.includes("image");
  const hasImageOutput=output.includes("image");
  if(!hasImageInput || !hasImageOutput) return false;

  // "Free" here means OpenRouter reports zero cost for every image/text
  // input/output pricing field exposed for the model. A zero prompt price
  // alone is not enough because many paid image models have free text input.
  const relevant=["prompt","completion","image","image_token","image_output"];
  return relevant.every((key)=>{
    const value=pricing[key];
    return value===undefined || value==="0" || value===0;
  }) && (pricing.image_output==="0" || pricing.image_output===0 || pricing.image==="0" || pricing.image===0);
}

async function discoverFreeImageEditors(key:string){
  const now=Date.now();
  if(cachedFreeModels && cachedFreeModels.expiresAt>now) return cachedFreeModels.models;

  const response=await fetch("https://openrouter.ai/api/v1/models?output_modalities=image",{
    headers:{
      Authorization:`Bearer ${key}`,
      "HTTP-Referer":process.env.OPENROUTER_SITE_URL||"https://tradumanga.vercel.app",
      "X-Title":"Tradumanga",
    },
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok){
    throw new Error(`Não foi possível consultar os modelos de imagem gratuitos do OpenRouter: HTTP ${response.status}.`);
  }

  const payload=await response.json() as {data?:OpenRouterImageModel[]};
  const models=(payload.data??[])
    .filter(isActuallyFreeImageEditor)
    .map((model)=>model.id)
    .filter(Boolean);

  cachedFreeModels={expiresAt:now+MODEL_CACHE_TTL_MS,models};
  console.info(JSON.stringify({
    event:"openrouter_free_image_models_discovered",
    count:models.length,
    models,
  }));
  return models;
}

function configuredModels(){
  return (process.env.OPENROUTER_IMAGE_MODELS||"")
    .split(",")
    .map((value)=>value.trim())
    .filter(Boolean);
}

async function resolveModels(key:string){
  const explicit=configuredModels();
  const discovered=await discoverFreeImageEditors(key);

  // Explicit models are only accepted when they are also discovered as
  // genuinely free image editors. This prevents accidentally charging the
  // account through a stale environment variable.
  const ordered=[...explicit,...discovered].filter((model,index,array)=>array.indexOf(model)===index);
  const free=ordered.filter((model)=>discovered.includes(model));

  if(free.length===0){
    throw new Error(
      "O OpenRouter não disponibilizou nenhum modelo de edição de imagem com custo zero neste momento. " +
      "O Tradumanga está configurado em modo FREE_ONLY e não fará fallback para modelos pagos."
    );
  }
  return free;
}

export async function renderPageWithOpenRouter(input:{
  original:Buffer;
  bubbles:OpenRouterRenderBubble[];
  width:number;
  height:number;
}):Promise<RenderResult>{
  const key=process.env.OPENROUTER_API_KEY;
  if(!key)throw new Error("OPENROUTER_API_KEY não configurada.");

  const models=await resolveModels(key);
  const maxInputDimension=Number(process.env.OPENROUTER_MAX_INPUT_DIMENSION||5000);

  const prepared=await sharp(input.original,{failOn:"warning"})
    .resize({width:maxInputDimension,height:maxInputDimension,fit:"inside",withoutEnlargement:true})
    .jpeg({quality:92,mozjpeg:true})
    .toBuffer();

  const source=dataUrl("image/jpeg",prepared);
  const prompt=buildPrompt(input.bubbles,input.width,input.height);
  let lastError="unknown";

  for(const model of models){
    const body={
      model,
      prompt,
      input_references:[{type:"image_url",image_url:{url:source}}],
    };

    for(let attempt=0;attempt<MAX_ATTEMPTS;attempt++){
      const response=await fetch("https://openrouter.ai/api/v1/images",{
        method:"POST",
        headers:{
          Authorization:`Bearer ${key}`,
          "Content-Type":"application/json",
          "HTTP-Referer":process.env.OPENROUTER_SITE_URL||"https://tradumanga.vercel.app",
          "X-Title":"Tradumanga",
        },
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(Number(process.env.OPENROUTER_TIMEOUT_MS||180000)),
      });

      const raw=await response.text();
      if(!response.ok){
        lastError=`OpenRouter model ${model} HTTP ${response.status}: ${raw.slice(0,1000)}`;
        if(retryable(response.status) && attempt<MAX_ATTEMPTS-1){
          await sleep(800*(2**attempt));
          continue;
        }
        // Try the next free image editor after exhausting this model.
        break;
      }

      let payload:any;
      try{ payload=JSON.parse(raw); }catch{ throw new Error("OpenRouter retornou JSON inválido."); }
      const item=payload?.data?.[0];
      if(!item?.b64_json){
        lastError=`OpenRouter model ${model} não retornou uma imagem editada.`;
        break;
      }

      const image=Buffer.from(item.b64_json,"base64");
      if(image.length<1000){
        lastError=`OpenRouter model ${model} retornou uma imagem vazia ou inválida.`;
        break;
      }

      const cost=Number(payload?.usage?.cost);
      console.info(JSON.stringify({
        event:"openrouter_image_edit_success",
        model,
        attempt,
        free_only:true,
        inputBytes:input.original.length,
        outputBytes:image.length,
        costUsd:Number.isFinite(cost)?cost:null,
      }));

      return {image,model,costUsd:Number.isFinite(cost)?cost:null};
    }
  }

  throw new Error(lastError);
}
