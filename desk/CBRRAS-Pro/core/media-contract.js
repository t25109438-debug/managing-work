// Native request constraints shared by generation, asset creation and real probes.
export function mediaContract(p={}){
 const id=String(p.model||'').toLowerCase();
 if(/seedream-(?:5-5|5-0-(?:pro|flash))/.test(id))return {family:'seedream-current',imageMinArea:921600,imageMaxArea:4624220,imageResolutions:['1K','1.5K','2K'],probeSize:'1024x1024',referenceLimit:14};
 if(/seedream-(?:5-0|4-5|4-0)/.test(id))return {family:'seedream-large',imageMinArea:3686400,imageMaxArea:16777216,imageResolutions:['2K','3K','4K'],probeSize:'1920x1920',referenceLimit:14};
 if(/seedance-2-5/.test(id))return {family:'seedance-2.5',durationMin:4,durationMax:30,referenceLimit:/flash/.test(id)?10:30};
 if(/seedance-2-0/.test(id))return {family:'seedance-2.0',durationMin:4,durationMax:15,referenceLimit:9};
 if(/seedance-1/.test(id))return {family:'seedance-1',durationMin:2,durationMax:12,referenceLimit:1};
 if(/gpt-image|dall-e/.test(id))return {family:'openai-image',probeSize:/dall-e-2/.test(id)?'256x256':'1024x1024',referenceLimit:16};
 if(/sora/.test(id))return {family:'sora',durationMin:4,durationMax:12,supportedDurations:[4,8,12],referenceLimit:1};
 return {family:'configured',referenceLimit:Number(p.maxReferenceImages)||9};
}
export function fitImageArea(width,height,minArea,maxArea){
 let w=Number(width),h=Number(height);if(!(w>0&&h>0))throw Error('图片宽高无效');
 const target=Math.min(maxArea||Infinity,Math.max(minArea||1,w*h));if(target===w*h)return {width:w,height:h};
 const scale=Math.sqrt(target/(w*h));w=Math.max(16,Math.floor(w*scale/16)*16);h=Math.max(16,Math.floor(h*scale/16)*16);
 while(w*h<(minArea||0)){if(w/h<width/height)w+=16;else h+=16;}
 while(w*h>(maxArea||Infinity)){if(w/h>width/height)w-=16;else h-=16;}
 return {width:w,height:h};
}
export function normalizeMediaInput(p,input={}){
 const next={...input},contract={...mediaContract(p)},adjustments=[];
 if(p.imageMaxArea)contract.imageMaxArea=Number(p.imageMaxArea);if(p.imageMinArea)contract.imageMinArea=Number(p.imageMinArea);
 if(p.category==='image'&&contract.imageMaxArea){
  const m=String(next.size||'').match(/^(\d+)[x×](\d+)$/);
  if(m){const[w,h]=m.slice(1).map(Number);if(w/h<1/16||w/h>16)throw Error('此模型图片宽高比需在1:16至16:1内');const fit=fitImageArea(w,h,contract.imageMinArea||1,contract.imageMaxArea);next.size=fit.width+'x'+fit.height;}
  else if(!(contract.imageResolutions||[]).includes(next.size||'2K'))next.size=(contract.imageResolutions||['1024x1024']).at(-1);
  if(next.size!==input.size)adjustments.push({field:'size',requested:input.size,submitted:next.size,reason:'所选模型原生像素范围'});
 }
 if(p.category==='video'&&contract.durationMin){const n=Number(next.duration)||contract.durationMin;if(!Number.isInteger(n)||n<contract.durationMin||n>contract.durationMax)throw Error('所选模型单段支持'+contract.durationMin+'至'+contract.durationMax+'秒，请拆段或选择相应模型');if(contract.supportedDurations&&!contract.supportedDurations.includes(n))throw Error('所选模型支持的时长为'+contract.supportedDurations.join('、')+'秒');}
 const images=next.images?.length?next.images:next.image?[next.image]:[];
 if(images.length>contract.referenceLimit)throw Error(contract.referenceLimit===1?'所选模型只支持一张参考图':'所选模型单次最多支持'+contract.referenceLimit+'张参考图');
 return {input:next,contract,adjustments};
}
export function rejectedTextRepair(p,error,used=new Set()){
 const message=String(error.message||'');if(!/^400[：:]|^422[：:]/.test(message)||!/unsupported|not supported|not allowed|unknown|unrecognized|unexpected|invalid parameter|不支持|未知参数/i.test(message))return null;
 for(const[field,changes]of [['stream_options',{sendStreamUsage:false}],['temperature',{sendTemperature:false}],['reasoning_effort',{omitReasoningEffort:true}],['thinking',{omitThinking:true}],['max_completion_tokens',{tokenField:'max_tokens'}],['max_tokens',{tokenField:'max_completion_tokens'}]])if(message.includes(field)&&!used.has(field))return {profile:{...p,...changes},field,reason:'服务商明确拒绝字段，按返回协议更正'};
 return null;
}
