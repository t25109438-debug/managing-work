export async function installDoubaoFlow(api){
 const groups={accounts:['s4'],materials:['s3','script-assets'],scripts:['s2'],production:['s5p','s6','s5'],reference:['s0','s1']};
 const nav=document.createElement('nav');nav.className='doubao-flow-nav';nav.id='doubao-flow-nav';nav.innerHTML=[['all','豆包视频SOP'],['accounts','1 · 账号'],['materials','2 · 产品与资产'],['scripts','3 · 脚本'],['production','4 · 生成与成片'],['reference','参考与工具']].map(([id,label])=>`<button data-flow="${id}" id="doubao-flow-${id}">${label}</button>`).join('')+'<button id="doubao-flow-tools">状态与导出</button>';
 document.querySelector('.top').after(nav);document.body.classList.add('cbrras-flow');
 const activate=key=>{if(!groups[key]&&key!=='all')key='reference';document.body.dataset.doubaoFlow=key;for(const [group,ids]of Object.entries(groups))for(const id of ids){const el=document.getElementById(id);if(el)el.hidden=key!=='all'&&key!==group;}nav.querySelectorAll('[data-flow]').forEach(b=>b.classList.toggle('active',b.dataset.flow===key));};
 nav.onclick=e=>{const b=e.target.closest('[data-flow]');if(b)activate(b.dataset.flow);};activate('all');
 const reveal=id=>{const key=Object.entries(groups).find(([,ids])=>ids.some(x=>document.getElementById(x)?.contains(document.getElementById(id))));if(key)activate(key[0]);};
 api.wrapNavigation(reveal);
 // Existing handlers that scroll to another step still reveal the destination.
 for(const id of [...Object.values(groups).flat(),'accountPanel']){const el=document.getElementById(id);if(!el)continue;const scroll=el.scrollIntoView.bind(el);el.scrollIntoView=options=>{reveal(id);scroll(options);};}
 const aside=document.querySelector('main > aside');if(aside){aside.id='doubao-flow-tool-panel';aside.hidden=true;nav.querySelector('#doubao-flow-tools').onclick=()=>{aside.hidden=!aside.hidden;document.body.classList.toggle('show-flow-tools',!aside.hidden);};}
 for(const el of document.querySelectorAll('#s3 > .body > .hint,#s0 .notice.info')){if(el.textContent.length<180)continue;const d=document.createElement('details');d.className='doubao-help-fold';d.innerHTML='<summary>操作说明与边界</summary>';el.before(d);d.append(el);}
 const {chooseProductImages,installGalleryInputs}=await import('/app/core/product-gallery.js');
 const button=document.createElement('button');button.id='doubao-product-gallery';button.className='btn primary';button.textContent='从产品图库配图';document.querySelector('#s3 > .body > .row').prepend(button);
 button.onclick=()=>chooseProductImages({max:30,apply:api.addProductImages}).catch(e=>api.error(e.message));
 installGalleryInputs(document);
 return {activate};
}
