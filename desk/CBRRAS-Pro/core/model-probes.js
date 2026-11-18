import {mediaContract} from './media-contract.js';
import {callText,generateMedia,pollMedia,fetchChecked,joinUrl,authHeaders} from './api.js';
import {put} from './store.js';
import {nativeMedia} from './native-service.js';
import {saveBlob,localBackend} from './remote-store.js';
export function probeInput(p){
 const imageSizes=p.supportedImageSizes||[],size=imageSizes[0]||mediaContract(p).probeSize||'1024x1024';
 const durations=p.supportedDurations||[],duration=Number(durations[0]||p.minDuration)||mediaContract(p).durationMin||5;
 return {prompt:'A plain blue ceramic cup on a neutral gray tabletop, static camera, natural daylight. No text, no logos, no people.',size,duration,ratio:'16:9',videoSize:'1280x720',resolution:'720p',voice:p.voice||'alloy',language:'en',featureId:'enabled-model-real-test',documents:['A blue cup.','A red book.']};
}
const identity=async p=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([p.id,p.model,p.baseUrl,p.protocol,p.category,p.apiKey||'',p.authHeader,p.authPrefix,p.extraHeaders,p.extraBody,p.endpointPath,p.statusPath,p.requestTemplate])))),x=>x.toString(16).padStart(2,'0')).join('');
export async function verifyProbeOutput(blob,category,{signal}={}){
 if(!blob?.size||blob.size>180*1048576)throw Error('返回文件为空或超过180MB测试上限');
 const saved=await saveBlob(blob),checked=await nativeMedia('verify-output',{blob:saved,category},{signal,unpackResult:false});
 return {blob:saved,verification:checked};
}
export async function runEnabledProbes({job,profiles,write,progress,control,fetcher=fetch,verify=verifyProbeOutput,delay=ms=>new Promise(r=>setTimeout(r,ms))}){
 job.modelTests||={};const selected=profiles.filter(p=>p.enabled&&job.input.profileIds.includes(p.id));
 if(!selected.length)throw Error('没有已启用的模型可测试');
 for(const p of selected)job.modelTests[p.id]||={profileId:p.id,name:p.name,model:p.model,category:p.category,identity:await identity(p),status:'queued'};await write();
 let cursor=0;const worker=async()=>{while(cursor<selected.length&&!control.pause){const p=selected[cursor++],currentIdentity=await identity(p),row=job.modelTests[p.id]||={profileId:p.id,name:p.name,model:p.model,category:p.category,identity:currentIdentity,status:'queued'};
  if(row.identity!==currentIdentity){row.status='configuration-changed';row.error='配置已更改，请建立新一轮测试，原结果保留';await write();continue;}
  if(row.status==='passed')continue;
  if(row.submittedAt&&!row.output&&!row.terminalResponse){row.status='unknown';row.error='此前请求结果不明，未重复提交；请核对服务商后新建测试';await write();continue;}
  if(row.terminalResponse&&!row.output){row.status='failed';await write();continue;}
  row.status='running';row.startedAt||=new Date().toISOString();progress('真实测试 '+p.name,{done:Object.values(job.modelTests).filter(r=>['passed','failed','unknown'].includes(r.status)).length,total:selected.length});await write();
  try{
   if(['text','vision','video-understanding'].includes(p.category)){
    if(!row.text){row.submittedAt=new Date().toISOString();job.requestCount++;await write();let content='Reply with the word READY and compute 7 + 5. This is a connection test.';
     if(p.vision||p.category!=='text'){const f=await fetcher(new URL('/app/assets/probe-vision.png',localBackend()||import.meta.url));if(!f.ok)throw Error('视觉测试图缺失');const b=new Uint8Array(await f.arrayBuffer());let s='';for(const x of b)s+=String.fromCharCode(x);content=[{type:'text',text:'Describe the dominant background color and the digit in this image. Return JSON {color,digit} only.'},{type:'image_url',image_url:{url:'data:image/png;base64,'+btoa(s)}}];}
     const r=await callText({...p,vision:p.vision||p.category!=='text',thinkingMode:'disabled'},[{role:'user',content}],{max_tokens:512,thinkingMode:'disabled',minimalProbe:true,stream:true,signal:control.signal,featureId:'enabled-model-real-test'},fetcher);row.text=r.content;row.usage=r.usage;row.requestId=r.requestId;row.terminalResponse=true;await write();}
    if(!row.text?.trim()||/^(?:I can.t discuss|I cannot|我无法|无法回答)/i.test(row.text.trim()))throw Error('已收到回复，但未完成测试任务：'+row.text.slice(0,120));
    if(p.vision||p.category!=='text'){if(!/blue|蓝/i.test(row.text)||!/(?:7|seven|七)/i.test(row.text))throw Error('视觉实测未正确识别蓝色背景与数字7，原回复保留');}else if(!/\b12\b/.test(row.text))throw Error('模型未完成最小运算测试，原回复保留');
    row.status='passed';row.verification={method:'actual-content-check',visual:!!p.vision||p.category!=='text'};
   }else{
    if(!row.output){const input=probeInput(p);if(['speech','music'].includes(p.category))input.prompt=p.category==='speech'?'Ready.':'A short soft instrumental chime, no vocals.';
     if(p.category==='asr'){const r=await fetcher(new URL('/app/assets/probe-speech.wav',localBackend()||import.meta.url));if(!r.ok)throw Error('ASR测试音频缺失');const b=new Uint8Array(await r.arrayBuffer());let s='';for(const x of b)s+=String.fromCharCode(x);input.fileData='data:audio/wav;base64,'+btoa(s);input.fileName='probe-speech.wav';}
     row.submittedAt=new Date().toISOString();job.requestCount++;await write();row.output=await generateMedia(p,{...input,signal:control.signal,onTransportRepair:async fix=>{row.repairs||=[];row.repairs.push(fix);job.requestCount++;await write();},onProviderResult:async out=>{row.output=out;await write();}},fetcher);row.terminalResponse=true;await write();}
    if(row.output.taskId&&!row.output.url){const until=Date.now()+15*60*1000;while(Date.now()<until&&!control.pause){const polled=await pollMedia(p,row.output.taskId,fetcher);row.output={...row.output,...polled};await write();if(polled.status==='failed')throw Error(polled.error||'服务商生成失败');if(polled.status==='completed')break;progress(p.name+'：已提交，等待原任务 '+row.output.taskId);await delay(3000);}if(!row.output.url&&row.output.status==='completed'&&row.output.downloadPath){const r=await fetchChecked(joinUrl(p.baseUrl,row.output.downloadPath),{headers:authHeaders(p,{json:false})},fetcher);row.output.blob=await saveBlob(await r.blob());await write();}if(!row.output.url&&!row.output.blob){row.status='pending';row.error='原任务仍在生成，续跑只查询此任务ID';await write();continue;}}
    if(['asr','embedding','rerank'].includes(p.category)){const raw=row.output.raw||{};if(p.category==='asr'&&!/ready/i.test(row.output.text||raw.text||''))throw Error('已返回转写，但未识别测试语音Ready');if(p.category==='embedding'&&!Array.isArray(raw.data?.[0]?.embedding))throw Error('未返回向量');if(p.category==='rerank'&&!Array.isArray(raw.results))throw Error('未返回重排序结果');row.verification={method:'actual-structured-result'};}
    else{let blob;if(row.output.blob){const {unpack}=await import('./remote-store.js');blob=await unpack(row.output.blob);}else{if(!row.output.url)throw Error('没有可下载的媒体结果');const r=await fetcher(row.output.url,{redirect:'follow',credentials:'omit'});if(!r.ok)throw Error('结果下载失败 HTTP '+r.status);blob=await r.blob();}const out=await verify(blob,p.category,{signal:control.signal});row.artifact=out.blob;row.verification=out.verification;await put('assets','model-test:'+job.id+':'+p.id,{id:'model-test:'+job.id+':'+p.id,name:p.name+'真实测试结果',blob:out.blob,kind:'model-test',category:p.category,createdAt:new Date().toISOString(),model:p.model});}
    row.status='passed';
   }
  }catch(e){row.status=control.signal?.aborted?'paused':'failed';row.error=String(e.message).split(p.apiKey||'\0').join('[Key已隐藏]');if(e.result){row.usage=e.result.usage;row.requestId=e.result.requestId;}if(/^(?:400|401|402|403|404|408|422|429|503)[：:]|OUTPUT_LIMIT/.test(e.message)||e.code==='OUTPUT_LIMIT')row.terminalResponse=true;}
  row.finishedAt=new Date().toISOString();await write();
 }};await Promise.all([worker(),worker(),worker(),worker()]);return job.modelTests;
}
