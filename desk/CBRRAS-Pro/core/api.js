import {normalizeMediaInput,rejectedTextRepair} from './media-contract.js';
import {normalizeImageProfile,buildImageRequest,extractImageResult} from './image-api.js';
import {effectiveProfile,requiresModel} from './connection-schema.js';
import {recordUsage} from './usage-ledger.js';
import {finalizeImage} from './image-processing.js';
import {verifyImageGeometry} from './image-verification.js';
import {localizedMessages,localizationPolicy,unexpectedHan} from './localization.js';
import {resolveArkProfile,arkIssue} from './ark-models.js';
import {runTextRequest} from './stream-api.js';
export function safeUrl(value,{local=true}={}){
 let u;try{u=new URL(String(value));}catch{throw new Error('API 地址格式无效，请填写完整 HTTPS 地址');}
 const loopback=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
 if(u.protocol!=='https:'&&!(local&&u.protocol==='http:'&&loopback))throw new Error('仅支持 HTTPS，或本机 localhost HTTP');
 if(u.username||u.password||u.hash)throw new Error('地址不能包含用户名、密码或片段');return u;
}
export function joinUrl(base,path=''){
 if(/^https?:\/\//i.test(path))return safeUrl(path).href;
 const b=safeUrl(base);if(!path)return b.href.replace(/\/$/,'');
 const suffix=new URL('/'+String(path).replace(/^\/+/,''),b.origin);let parts=b.pathname.split('/').filter(Boolean),tail=suffix.pathname.split('/').filter(Boolean);
 // Accept a pasted completion URL as a base without appending it twice.
 if(/\/(chat\/completions|messages)$/.test(b.pathname))parts=parts.slice(0,b.pathname.endsWith('/messages')?-1:-2);
 let overlap=Math.min(parts.length,tail.length);while(overlap&&!parts.slice(-overlap).every((x,i)=>x===tail[i]))overlap--;
 b.pathname='/'+[...parts,...tail.slice(overlap)].join('/');b.search=suffix.search;return b.href;
}
export function valueAt(obj,path=''){
 if(!path)return obj;return String(path).replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean).reduce((v,k)=>['__proto__','prototype','constructor'].includes(k)?undefined:v?.[k],obj);
}
export function renderTemplate(value,vars){
 if(Array.isArray(value))return value.map(v=>renderTemplate(v,vars));
 if(value&&typeof value==='object'){const out={};for(const [k,v]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(k))throw new Error('请求模板字段无效');out[k]=renderTemplate(v,vars);}return out;}
 if(typeof value!=='string')return value;
 const exact=value.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);if(exact){if(!(exact[1]in vars))throw new Error('未知模板参数：'+exact[1]);return vars[exact[1]];}
 return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g,(_,k)=>{if(!(k in vars))throw new Error('未知模板参数：'+k);return typeof vars[k]==='object'?JSON.stringify(vars[k]):String(vars[k]??'');});
}
export function authHeaders(profile,{json=true}={}){
 const h={Accept:'application/json',...(json?{'Content-Type':'application/json'}:{}),...(profile.extraHeaders||{})};
 if(profile.apiKey)h[profile.authHeader||'Authorization']=(profile.authPrefix??'Bearer ')+profile.apiKey;
 if(profile.protocol==='anthropic'){h['anthropic-version']='2023-06-01';h['anthropic-dangerous-direct-browser-access']='true';}
 return h;
}
export async function fetchChecked(url,init={},fetcher=fetch,timeout=120000){
 safeUrl(url);const deadline=AbortSignal.timeout(timeout),signal=init.signal?AbortSignal.any([init.signal,deadline]):deadline;
 try{const response=await fetcher(url,{...init,signal,redirect:'error',credentials:'omit'});
  if(!response.ok){let message=`HTTP ${response.status}`;try{const d=await response.json();message=d.error?.message||d.message||message;}catch{}
   throw Object.assign(new Error(`${response.status}：${String(message).slice(0,700)}`),{status:response.status,requestId:response.headers.get('request-id')||response.headers.get('x-request-id'),retryAfter:response.headers.get('retry-after')});}
  return response;
 }catch(e){if(signal.aborted)throw new Error('请求超时或已取消；未自动重试，以免重复扣费');throw e;}
}
export async function requestJSON(url,init={},fetcher=fetch,timeout=120000){
 const response=await fetchChecked(url,init,fetcher,timeout),length=Number(response.headers?.get('content-length')||0);
 if(length>24*1024*1024)throw new Error('接口响应过大');let data;try{data=await response.json();}catch(e){if(['AbortError','TimeoutError'].includes(e.name))throw new Error('读取接口响应超时；未重复提交请求');throw new Error('接口未返回 JSON，请检查 API 地址及协议');}return data;
}
export function validateProfile(p,{model=true}={}){
 model=model&&requiresModel(p);safeUrl(p.baseUrl);if(p.baseUrl.includes('?'))throw new Error('API 根地址请不要包含查询参数；鉴权请使用 Key 或请求头');
 if(!p.apiKey&&!['localhost','127.0.0.1','[::1]'].includes(safeUrl(p.baseUrl).hostname)&&!p.allowNoAuth)throw new Error('请填写 API Key');
 if(model&&arkIssue(p))throw new Error(arkIssue(p));
 if(model&&!String(p.model||'').trim())throw new Error('请填写模型 ID，或先获取模型列表');
 if(p.extraHeaders&&typeof p.extraHeaders!=='object')throw new Error('额外请求头必须是 JSON 对象');
 return p;
}
const imgParts=messages=>messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url');
const textContent=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
function imageForAnthropic(part){const url=part.image_url.url,m=url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);return {type:'image',source:m?{type:'base64',media_type:m[1],data:m[2]}:{type:'url',url}};}
export function buildTextRequest(p,messages,opts={}){
 p=resolveArkProfile(effectiveProfile(p));messages=opts.minimalProbe?messages:localizedMessages(messages,opts.localization||{});
 const issue=arkIssue(p);if(issue)throw new Error(issue);
 const budget=Math.max(1,Math.min(Number(opts.max_tokens||opts.maxTokens)||8000,64000));
 let path='/chat/completions',body;
 if(p.protocol==='anthropic'){
  path='/messages';body={model:p.model,max_tokens:budget,system:messages.filter(m=>m.role==='system').map(m=>textContent(m.content)).join('\n'),messages:messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'assistant':'user',content:typeof m.content==='string'?m.content:m.content.map(part=>part.type==='image_url'?imageForAnthropic(part):{type:'text',text:part.text||''})}))};
 }else if(p.protocol==='gemini'){
  path='/models/'+encodeURIComponent(p.model.replace(/^models\//,''))+':generateContent';
  body={systemInstruction:{parts:[{text:messages.filter(m=>m.role==='system').map(m=>textContent(m.content)).join('\n')}]},contents:messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:typeof m.content==='string'?[{text:m.content}]:m.content.map(part=>{if(part.type==='text')return {text:part.text};const match=part.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);if(!match)throw new Error('Gemini 画面分析请使用本地采样图片');return {inlineData:{mimeType:match[1],data:match[2]}};})})),generationConfig:{maxOutputTokens:budget}};
 }else if(p.protocol==='custom'){
  if(!p.requestTemplate)throw new Error('请先配置自定义请求模板');
  path=p.endpointPath||'';body=renderTemplate(p.requestTemplate,{model:p.model,messages,prompt:textContent(messages.at(-1)?.content),system:messages.filter(m=>m.role==='system').map(m=>textContent(m.content)).join('\n'),max_tokens:budget});
 }else{
  body={model:p.model,messages,stream:false};
  body[p.tokenField||(/^o[134]|^gpt-[56]/i.test(p.model)||new URL(p.baseUrl).hostname==='api.xiaomimimo.com'?'max_completion_tokens':'max_tokens')]=budget;
  if(p.sendTemperature!==false&&!/reasoner|^o[134]|^gpt-[56]/i.test(p.model))body.temperature=opts.temperature??0.7;
 }
 // DeepSeek's current official models default to high reasoning, including frame
 // observation. Make the efficient default explicit; custom gateways are untouched.
 if(new URL(p.baseUrl).hostname==='api.deepseek.com'&&['deepseek-flash','deepseek-v4-pro','deepseek-v4-flash-vision-exp'].includes(p.model)&&['openai-chat','anthropic'].includes(p.protocol)){
  const thinking=p.thinkingMode||opts.thinkingMode||'disabled';
  if(thinking==='disabled')body.thinking={type:'disabled'};
  else if(['low','high','max'].includes(thinking)){body.thinking={type:'enabled'};if(p.protocol==='anthropic')body.output_config={effort:thinking};else body.reasoning_effort=thinking;}
 }
 if(new URL(p.baseUrl).hostname==='api.xiaomimimo.com'&&['openai-chat','anthropic'].includes(p.protocol)){if(p.thinkingMode!=='provider')body.thinking={type:(p.thinkingMode&&p.thinkingMode!=='disabled')?'enabled':'disabled'};if(body.thinking?.type==='enabled')delete body.temperature;}
 // Explicit efficiency settings also apply to OpenAI-compatible DeepSeek relays.
 // Other model families keep their provider-specific request contract.
 if(p.protocol==='openai-chat'&&/deepseek[-_/]v?4/i.test(p.model)&&['disabled','low'].includes(opts.thinkingMode||p.thinkingMode)){
  body.thinking={type:'disabled'};body.reasoning_effort='low';
 }
 if(p.omitThinking)delete body.thinking;if(p.omitReasoningEffort)delete body.reasoning_effort;body={...body,...(p.extraBody||{})};return {url:joinUrl(p.baseUrl,p.endpointPath||path),body,headers:authHeaders(p)};
}
export function extractText(data,p={}){
 if(p.textPath){const v=valueAt(data,p.textPath);return typeof v==='string'?v:JSON.stringify(v??'');}
 let c=data.choices?.[0]?.message?.content;
 if(typeof c==='string')return c;if(Array.isArray(c))return c.map(v=>v.text||'').join('\n');
 if(Array.isArray(data.content))return data.content.filter(v=>v.type==='text').map(v=>v.text).join('\n');
 if(data.candidates)return (data.candidates[0]?.content?.parts||[]).filter(v=>!v.thought).map(v=>v.text||'').join('\n');
 if(data.output_text)return data.output_text;return '';
}
async function callTextOnce(p,messages,opts={},fetcher=fetch){p=effectiveProfile(p);
 validateProfile(p);if(imgParts(messages).length&&!['vision','video-understanding'].includes(p.category)&&!p.vision)throw new Error('该配置未启用视觉能力，请选择视觉模型或仅分析字幕');
 const used=new Set(),repairs=[];for(let attempt=0;;attempt++){try{const result=await runTextRequest(p,messages,opts,fetcher);return {...result,transportRepairs:repairs};}catch(error){const fix=attempt<3?rejectedTextRepair(p,error,used):null;if(!fix)throw error;used.add(fix.field);repairs.push({field:fix.field,reason:fix.reason});await opts.onTransportRepair?.(repairs.at(-1));p=fix.profile;}}
}
const normalizeModalities=rows=>[...new Set((Array.isArray(rows)?rows:[]).map(x=>String(x).toLowerCase().split('/')[0]).filter(x=>['text','image','audio','video','pdf','document'].includes(x)))];
export async function discoverModels(p,fetcher=fetch){p=effectiveProfile(p);
 validateProfile(p,{model:false});const path=p.modelsPath||(['openai-chat','anthropic','gemini'].includes(p.protocol)?'/models':'');if(!path)throw new Error('该服务未提供模型目录，请填写模型目录路径或手工配置');
 const first=joinUrl(p.baseUrl,path),result=[],details=[];let next=first;
 for(let page=0;next&&page<12;page++){
  if(new URL(next).origin!==new URL(first).origin)throw new Error('模型分页地址跨域，已停止');
  const d=await requestJSON(next,{headers:authHeaders(p,{json:false})},fetcher,Math.max(30000,Math.min(90000,Number(p.timeoutMs)||60000))),items=d.data||d.models||d.items;
  if(!Array.isArray(items))throw new Error('未找到模型列表；请检查 models 路径');
  for(const m of items){const id=typeof m==='string'?m:m.id||m.name;if(id){const key=String(id).replace(/^models\//,'');result.push(key);details.push(typeof m==='string'?{id:key}:{id:key,name:m.name||key,input:normalizeModalities(m.input_modalities||m.modalities?.input||[]),output:normalizeModalities(m.output_modalities||m.modalities?.output||[]),contextWindow:m.context_window||m.context_length,maxOutputTokens:m.max_output_tokens,effort:m.effort});}}
  if(d.nextPageToken){const u=new URL(first);u.searchParams.set('pageToken',d.nextPageToken);next=u.href;}
  else if(d.has_more&&d.last_id){const u=new URL(first);u.searchParams.set('after_id',d.last_id);next=u.href;}
  else next='';
 }
 return {models:[...new Set(result)].sort(),modelDetails:details,modelsUrl:first,checkedAt:new Date().toISOString()};
}
export async function listModels(p,fetcher=fetch){return (await discoverModels(p,fetcher)).models;}
export async function testProfile(p,fetcher=fetch){
 p=effectiveProfile(p);const discovery=await discoverModels(p,fetcher),models=discovery.models;p=resolveArkProfile({...p,...discovery});const issue=arkIssue(p);if(issue)throw new Error(issue);const found=models.includes(p.model);return {ok:true,models,modelFound:found,accessVerified:false,message:found?'目录鉴权通过，目录包含此ID；生成权限尚未验证。请在对应功能发起一次实际任务核验。':'目录鉴权通过，但未找到所填模型ID。未验证生成权限，请核对完整ID/接入点ID，不能据此视为可调用。'};
}
function bytesDataURL(buffer,type='application/octet-stream'){
 const bytes=new Uint8Array(buffer);let str='';for(let i=0;i<bytes.length;i+=16384)str+=String.fromCharCode(...bytes.subarray(i,i+16384));return 'data:'+type+';base64,'+btoa(str);
}
async function generateMediaOnce(p,input={},fetcher=fetch){
 p=resolveArkProfile(effectiveProfile(normalizeImageProfile(p)));
 if(['elevenlabs-music','elevenlabs-tts','google-tts','gemini-tts'].includes(p.protocol)){
  validateProfile(p,{model:p.protocol!=='google-tts'});const {generateAudio}=await import('./audio-api.js');let checkpoint;
  const asOutput=async result=>({url:result.blob?bytesDataURL(await result.blob.arrayBuffer(),result.blob.type||'audio/mpeg'):result.url||'',taskId:result.taskId||'',status:result.taskId?'processing':'completed',metadata:result.metadata,raw:{usage:result.usage,requestId:result.requestId,cost:result.cost},usageRecorded:true});
  const result=await generateAudio(p,{...input,language:input.language||input.localization?.language||'en',audioKind:p.category==='speech'?'speech':'music'},{fetcher,signal:input.signal,onProviderResult:async r=>{checkpoint=await asOutput(r);await input.onProviderResult?.(checkpoint);},onPendingResult:async r=>input.onProviderResult?.(await asOutput(r)),onTask:async(id,r)=>{checkpoint=await asOutput({...r,taskId:id});await input.onProviderResult?.(checkpoint);}});return checkpoint||await asOutput(result);
 }
 validateProfile(p);const normalized=normalizeMediaInput(p,input);input=normalized.input;if(p.category==='speech'&&unexpectedHan(input.prompt||'',input.localization?.language))throw new Error('跨境成品配音稿含中文；请先翻译为目标站点语言，再提交配音。中文说明不要放入朗读文本。');if(['image','video'].includes(p.category))input.prompt=(input.prompt||'')+'\n'+localizationPolicy(input.localization||{})+'\n'+(input.size?'Requested image/output geometry: '+input.size+'; do not change the selected ratio.':'');const vars={model:p.model,prompt:input.prompt||'',duration:Number(input.duration)||10,ratio:input.ratio||'9:16',size:p.category==='video'?(input.videoSize||input.size||'720x1280'):(input.size||'1024x1024'),voice:input.voice||'alloy',width:input.width||input.imageGeometry?.width||Number(input.videoSize?.split('x')[0])||'',height:input.height||input.imageGeometry?.height||Number(input.videoSize?.split('x')[1])||'',resolution:input.resolution||'',image:input.image||input.images?.[0]||'',images:input.images?.length?input.images:(input.image?[input.image]:[]),seed:input.seed??-1,query:input.prompt||'',documents:input.documents||[]};
 if(p.category==='image'&&Array.isArray(p.supportedImageSizes)&&p.supportedImageSizes.length&&!p.supportedImageSizes.includes(vars.size)){const wanted=input.imageGeometry?.width/input.imageGeometry?.height||1,candidates=p.supportedImageSizes.filter(s=>/^\d+x\d+$/.test(s));if(candidates.length)vars.size=candidates.sort((a,b)=>{const ratio=s=>{const [w,h]=s.split('x').map(Number);return Math.abs(Math.log((w/h)/wanted));};return ratio(a)-ratio(b);})[0];}
 let path='',body,form=false,binary=false;
 if(p.protocol==='custom'&&vars.images.length&&!/\{\{images?\}\}/.test(JSON.stringify(p.requestTemplate)))throw new Error('此自定义模板没有image/images参考图字段，不能忽略人物或产品参考图；请在API设置补充模板');
 if(p.protocol==='custom'&&vars.images.length>1&&!JSON.stringify(p.requestTemplate).includes('{{images}}'))throw new Error('多图自定义协议需要在请求模板使用{{images}}，避免静默只发送第一张');
 switch(p.protocol){
 case 'openai-chat-image':case 'gemini-image':{const built=await buildImageRequest(p,input,vars,{fetchImage:async value=>{const r=await fetchChecked(value,{},fetcher);const blob=await r.blob();if(blob.size>24*1048576||!blob.type.startsWith('image/'))throw new Error('参考图片格式或大小无效');return bytesDataURL(await blob.arrayBuffer(),blob.type);}});path=built.path;body=built.body;break;}
 case 'openai-image':path='/images/generations';body={model:p.model,prompt:vars.prompt,n:1,size:vars.size};if(p.providerId==='ark'||/seedream/i.test(p.model)){body.watermark=false;delete body.n;if(normalized.contract.family==='seedream-large')body.sequential_image_generation='disabled';if(vars.images.length)body.image=vars.images.length===1?vars.images[0]:vars.images;}else if(vars.images.length){path='/images/edits';form=true;body=new FormData();body.set('model',p.model);body.set('prompt',vars.prompt);body.set('n','1');body.set('size',vars.size);for(let i=0;i<vars.images.length;i++){const value=vars.images[i],match=value.match(/^data:([^;]+);base64,(.+)$/s);let blob;if(match)blob=new Blob([Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0))],{type:match[1]});else{const response=await fetchChecked(value,{},fetcher);blob=await response.blob();}if(blob.size>20*1048576||!blob.type.startsWith('image/'))throw new Error('参考图片格式或大小不受支持');body.append(vars.images.length>1?'image[]':'image',blob,'reference-'+i+'.'+(blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png'));}}break;
 case 'ark-video':{
  if(vars.duration<2||vars.duration>30||!Number.isInteger(vars.duration))throw new Error('视频时长必须是2–30秒整数，具体范围以所选模型为准');
  path='/contents/generations/tasks';body={model:p.model,content:[{type:'text',text:vars.prompt}],duration:vars.duration,ratio:vars.ratio,resolution:input.resolution||'720p',watermark:false};
  if(input.characterReference&&!/seedance-2-/.test(p.model)&&!p.multiImageReferences)throw new Error('当前方舟模型未声明人物参考支持；请选择Seedance2系列，或在API高级设置确认参考图能力');
  if(vars.images.length>normalized.contract.referenceLimit)throw new Error('所选Seedance模型参考图超过上限');
  if(vars.images.length>1&&!/seedance-2-/.test(p.model)&&!p.multiImageReferences)throw new Error('此视频模型未配置多图参考支持；请选一张或改用支持多图的Seedance2系列');
  for(const image of vars.images)body.content.push({type:'image_url',image_url:{url:image},role:input.characterReference?'reference_image':vars.images.length===1?'first_frame':'reference_image'});break;
 }
 case 'openai-video':{
  if(vars.images.length>1)throw new Error('此视频协议只支持一张参考图；请选一张或改用支持多图的模型');
  path='/videos';form=true;body=new FormData();body.set('model',p.model);body.set('prompt',vars.prompt);body.set('seconds',String(vars.duration));body.set('size',input.videoSize||'720x1280');
  if(vars.image){const match=vars.image.match(/^data:([^;]+);base64,(.+)$/s);if(!match)throw new Error('Sora 参考图请上传本地图片');body.set('input_reference',new Blob([Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0))],{type:match[1]}),'reference.png');}break;
 }
 case 'meshy-3d':path='/openapi/v2/text-to-3d';body={mode:'preview',prompt:vars.prompt,...(p.model?{ai_model:p.model}:{})};break;
 case 'tripo-3d':{const current=/\/v3\/?$/.test(new URL(p.baseUrl).pathname);path=current?'/generation/text-to-model':'/task';body=current?{model:p.model,prompt:vars.prompt}:{type:'text_to_model',model_version:p.model,prompt:vars.prompt};break;}
 case 'openai-speech':path='/audio/speech';body={model:p.model,input:vars.prompt,voice:vars.voice,response_format:'mp3'};binary=true;break;
 case 'openai-asr':{
  path='/audio/transcriptions';form=true;const match=String(input.fileData||'').match(/^data:([^;]+);base64,(.+)$/s);if(!match)throw new Error('请上传要识别的音频文件');body=new FormData();body.set('model',p.model);body.set('file',new Blob([Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0))],{type:match[1]}),input.fileName||'audio.mp3');if(input.timestamps){body.set('response_format','verbose_json');body.append('timestamp_granularities[]','segment');}if(input.language&&input.language!=='auto')body.set('language',input.language);break;
 }
 case 'openai-embedding':path='/embeddings';body={model:p.model,input:vars.prompt};break;
 case 'cohere-rerank':path='/rerank';body={model:p.model,query:vars.query,documents:vars.documents};break;
 case 'custom':if(!p.requestTemplate)throw new Error('原生接口模板尚未配置，请在高级设置填写请求体与结果字段路径');path=p.endpointPath||'';body=renderTemplate(p.requestTemplate,vars);break;
 default:throw new Error('该协议不支持此生成操作');
 }
 if(!form)body={...body,...(p.extraBody||{})};else for(const [k,v]of Object.entries(p.extraBody||{}))body.set(k,typeof v==='object'?JSON.stringify(v):String(v));
 const endpoint=(p.endpointPath||path).replace(/\{(model|voice)\}/g,(_,key)=>encodeURIComponent(vars[key]));
 const init={method:'POST',signal:input.signal,headers:authHeaders(p,{json:!form}),body:form?body:JSON.stringify(body)},url=joinUrl(p.baseUrl,endpoint);
 if(binary){const r=await fetchChecked(url,init,fetcher,180000),buf=await r.arrayBuffer();if(buf.byteLength>20*1024*1024)throw new Error('音频超过20MB');const {validateAudioBlob}=await import('./audio-api.js');await validateAudioBlob(new Blob([buf],{type:r.headers.get('content-type')||'audio/mpeg'}));const out={url:bytesDataURL(buf,r.headers.get('content-type')||'audio/mpeg'),status:'completed',raw:{bytes:buf.byteLength},requestId:r.headers.get('request-id')||r.headers.get('x-request-id')};await input.onUsageResult?.(out);await input.onProviderResult?.(out);return out;}
 const d=await requestJSON(url,init,fetcher,Number(p.timeoutMs)||180000),imageResult=p.category==='image'?extractImageResult(d):null,urlValue=p.urlPath?valueAt(d,p.urlPath):imageResult?.url||d.data?.[0]?.url||(d.data?.[0]?.b64_json?'data:image/png;base64,'+d.data[0].b64_json:'')||d.content?.video_url||d.output?.url||'';
 const taskId=p.taskIdPath?valueAt(d,p.taskIdPath):p.category==='image'&&['openai-chat-image','gemini-image'].includes(p.protocol)?'':d.id||d.task_id||d.data?.task_id||d.result||'';
 await input.onUsageResult?.({raw:d,usage:d.usage,requestId:d.request_id||d.id});
 if(urlValue&&typeof urlValue!=='string')throw new Error('媒体结果地址必须是字符串，请核对结果字段路径');if(taskId&&!['string','number'].includes(typeof taskId))throw new Error('媒体任务ID必须是字符串，请核对任务字段路径');
 if(['image','video','model3d','avatar','speech','music'].includes(p.category)&&!urlValue&&!taskId)throw new Error('接口未返回媒体地址或任务 ID，请核对请求协议与结果字段路径');
 if(urlValue||taskId)await input.onProviderResult?.({url:urlValue,raw:d,status:urlValue?'provider-returned':'processing',taskId});
 let geometry=p.category==='image'&&urlValue&&input.imageGeometry?await verifyImageGeometry(urlValue,input.imageGeometry,fetcher):undefined;
 let finalUrl=urlValue,originalUrl;if(p.category==='image'&&urlValue&&input.imageGeometry?.width&&geometry?.status!=='matched'){const fixed=await finalizeImage(urlValue,input.imageGeometry,{strategy:input.imageFit||'contain',fetcher});if(!fixed)throw new Error('图片校正未完成');geometry=fixed.geometry;finalUrl=fixed.url;originalUrl=fixed.originalUrl;}
 return {actualModel:p.model,submittedSize:vars.size,requestAdjustments:normalized.adjustments,geometry,originalUrl,url:finalUrl,taskId:taskId?String(taskId):'',status:urlValue?'completed':taskId?'processing':'completed',text:imageResult?.text||d.text||'',images:imageResult?.images,usage:imageResult?.usage||d.usage||{},raw:d};
}
export async function generateMedia(p,input={},fetcher=fetch){
 const started=Date.now(),native=['elevenlabs-music','elevenlabs-tts','google-tts','gemini-tts'].includes(p.protocol);let recorded=false,accepted=false;const repairs=[];
 const log=async out=>{if(recorded||native)return;recorded=true;await recordUsage(p,{...out,usage:out.usage||out.raw?.usage||{},elapsedMs:Date.now()-started},{featureId:input.featureId||p.category});};
 for(let attempt=0;;attempt++)try{
  const result=await generateMediaOnce(p,{...input,onUsageResult:log,onProviderResult:async out=>{accepted=true;await input.onProviderResult?.(out);}},fetcher);await log(result);return {...result,transportRepairs:repairs};
 }catch(error){
  if(p.apiKey)error.message=String(error.message).split(p.apiKey).join('[Key已隐藏]');
  if(!accepted&&attempt<2){let fix=null;const message=String(error.message),bound=message.match(/image area must be at (most|least) (\d+) pixels/i);
   if(/^400[：:]/.test(message)&&p.category==='image'&&bound){p={...p,[bound[1].toLowerCase()==='most'?'imageMaxArea':'imageMinArea']:Number(bound[2])};fix={field:'size',reason:'按服务商明确返回的像素边界更正，保留目标比例和参考图'};}
   else if(/^(408|429|503)[：:]/.test(message)&&/overload|overloaded|capacity|busy|temporar|过载|繁忙/i.test(message)){fix={field:'overload',reason:'服务商明确拒绝且未受理，短暂等待后重试'};await new Promise(resolve=>setTimeout(resolve,Math.min(10000,1000*2**attempt)));}
   if(fix){repairs.push(fix);await input.onTransportRepair?.(fix);await recordUsage(p,{elapsedMs:Date.now()-started},{featureId:input.featureId||p.category,status:'failed',error:error.message});recorded=false;continue;}
  }
  if(!recorded&&!native)await recordUsage(p,{elapsedMs:Date.now()-started},{featureId:input.featureId||p.category,status:'failed',error:error.message});throw error;
 }
}
export async function pollMedia(p,taskId,fetcher=fetch){p=effectiveProfile(p);
 validateProfile(p,{model:false});if(!taskId||String(taskId).length>300)throw new Error('任务 ID 无效');
 let path=p.statusPath|| (p.protocol==='ark-video'?'/contents/generations/tasks/{id}':p.protocol==='openai-video'?'/videos/{id}':p.protocol==='meshy-3d'?'/openapi/v2/text-to-3d/{id}':p.protocol==='tripo-3d'?(/\/v3\/?$/.test(new URL(p.baseUrl).pathname)?'/tasks/{id}':'/task/{id}'):'');
 if(!path)throw new Error('请在 API 高级设置中填写状态查询路径');
 path=path.replaceAll('{id}',encodeURIComponent(taskId));
 const d=await requestJSON(joinUrl(p.baseUrl,path),{headers:authHeaders(p,{json:false})},fetcher,25000),rawStatus=p.statusField?valueAt(d,p.statusField):d.status||d.data?.status,status=p.statusMap?.[String(rawStatus)]||String(rawStatus||'').toLowerCase();
 const url=p.urlPath?valueAt(d,p.urlPath):d.content?.video_url||d.data?.[0]?.url||d.output?.url||d.model_urls?.glb||d.data?.output?.model||d.data?.output?.pbr_model||d.data?.model_url||'';
 if(['failed','error','cancelled','canceled','expired'].includes(status))return {status:'failed',error:d.error?.message||d.error||'生成任务失败',raw:d};
 return {status:['succeeded','completed','success'].includes(status)?'completed':'processing',url,progress:d.progress??null,raw:d,downloadPath:p.protocol==='openai-video'?'/videos/'+encodeURIComponent(taskId)+'/content':''};
}

export async function callText(p,messages,opts={},fetcher=fetch){const start=Date.now();try{const r=await callTextOnce(p,messages,opts,fetcher);r.elapsedMs=Date.now()-start;await recordUsage(p,r,opts);return r;}catch(e){await recordUsage(p,{...(e.result||{}),elapsedMs:Date.now()-start},{...opts,status:"failed",error:e.message});throw e;}}
