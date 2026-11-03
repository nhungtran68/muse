import {mkdir,rename,stat,unlink,open,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

export function installedBrowserExecutable(){
  if(process.platform!=='win32')return null;
  const candidates=[
    path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe'),
    path.join(process.env.PROGRAMFILES||'C:\\Program Files','Microsoft','Edge','Application','msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe'),
    path.join(process.env.LOCALAPPDATA||'','Google','Chrome','Application','chrome.exe')
  ];
  return candidates.find(file=>existsSync(file))||null;
}

export function parseScenePlan(text,jobId,count) {
  const marker=`PLAN_${jobId.replaceAll('-','_')}`;
  const from=text.lastIndexOf(marker);
  if(from<0) return null;
  for(let start=text.lastIndexOf('{',from);start>=0;start=text.lastIndexOf('{',start-1)) {
    let depth=0,inString=false,escaped=false;
    for(let end=start;end<text.length;end++) {
      const char=text[end];
      if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
      if(char==='"'){inString=true;continue;}
      if(char==='{')depth++;
      if(char==='}')depth--;
      if(depth===0){
        try {
          const plan=JSON.parse(text.slice(start,end+1));
          if(plan.id!==marker||!Array.isArray(plan.scenes)||plan.scenes.length!==count)return null;
          if(!plan.scenes.every((scene,i)=>scene.index===i+1&&typeof scene.prompt==='string'&&scene.prompt.trim().length>=15&&scene.prompt.length<=1200))return null;
          return plan.scenes.map(scene=>({index:scene.index,prompt:scene.prompt.trim()}));
        } catch {}
        break;
      }
    }
  }
  return null;
}

export class MuseAdapter {
  constructor(profileDir,downloadsDir,{sceneTimeoutMs=13*60*1000,pollMs=3000,composerTimeoutMs=30000}={}){
    Object.assign(this,{profileDir,downloadsDir,sceneTimeoutMs,pollMs,composerTimeoutMs});
  }
  async open(){
    if(this.page&&!this.page.isClosed())return this.page;
    const {chromium}=await import('playwright');
    const executablePath=installedBrowserExecutable();
    this.context=await chromium.launchPersistentContext(this.profileDir,{headless:false,acceptDownloads:true,viewport:null,...(executablePath?{executablePath}:{})});
    const pages=this.context.pages();
    this.page=pages.find(page=>{try{return new URL(page.url()).hostname==='muse.ai';}catch{return false;}})||pages[0]||await this.context.newPage();
    if(!this.page.url().startsWith('https://muse.ai/'))await this.page.goto('https://muse.ai/',{waitUntil:'domcontentloaded'});
    return this.page;
  }
  async assertConnected(){
    const p=this.requirePage();
    const disconnected=p.getByRole('heading',{name:/^(\u0110\u00e3 ng\u1eaft k\u1ebft n\u1ed1i Muse|Muse disconnected|Disconnected from Muse)$/i});
    if(await disconnected.isVisible().catch(()=>false)){
      const error=Error('Muse đã ngắt kết nối tài khoản để bảo vệ thông tin. Cần kết nối lại qua hỗ trợ Muse trước khi tạo video.');
      error.code='MUSE_DISCONNECTED';throw error;
    }
  }
  async close(){
    if(this.context)await this.context.close();
    this.context=null;this.page=null;
  }
  async captureDiagnostics(jobId,error){
    const p=this.page;if(!p||p.isClosed())return;
    const dir=path.join(this.downloadsDir,jobId,'diagnostics');await mkdir(dir,{recursive:true});
    const url=new URL(p.url());
    const controls=await p.locator('button,a,[role="button"],[role="link"]').evaluateAll(elements=>elements.map(element=>({tag:element.tagName,role:element.getAttribute('role'),label:(element.getAttribute('aria-label')||element.textContent||'').trim().slice(0,180)})).filter(item=>/^(Mở|Xem) video\b|^(Open|View|Play) (?:animated )?video\b/i.test(item.label)).slice(-10));
    const requestPresent=await p.locator('body').evaluate((element,id)=>element.innerText.includes(id),jobId);
    await writeFile(path.join(dir,'state.json'),JSON.stringify({time:new Date().toISOString(),url:url.origin+url.pathname,error:error.message,requestPresent,composerVisible:await this.composer().isVisible().catch(()=>false),controls},null,2));
    await p.screenshot({path:path.join(dir,'muse.png')});
    console.log(`Thông tin kiểm tra: ${dir}`);
  }
  async waitForLogin({timeoutMs=600000}={}){
    const p=await this.open();
    console.log('Đang kiểm tra kết nối Muse; nếu cần, hãy đăng nhập trong cửa sổ Muse.');
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
      await this.assertConnected();
      if(await this.composer().isVisible().catch(()=>false)){
        console.log(`Đã thấy ô chat Muse. URL: ${p.url()}`);return;
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    const error=Error('Chưa thấy ô chat Muse. Kiểm tra đăng nhập và trạng thái kết nối trong cửa sổ Muse.');
    error.code='MUSE_NOT_READY';throw error;
  }
  requirePage(){
    if(!this.page||this.page.isClosed()||new URL(this.page.url()).hostname!=='muse.ai')throw Error('Cửa sổ Muse không sẵn sàng.');
    return this.page;
  }
  composer(){return this.requirePage().getByRole('textbox',{name:/^(Nh\u1eafn tin|Message)$/i});}
  preview(){return this.requirePage().getByRole('dialog',{name:/Xem tr\u01b0\u1edbc file ph\u01b0\u01a1ng ti\u1ec7n|Media preview/i});}
  async closePreview(){
    const p=this.requirePage(),preview=this.preview();
    if(!await preview.isVisible().catch(()=>false))return;
    await p.keyboard.press('Escape');
    // Escape closes Muse asynchronously. Do not race its transition with a second click.
    const closed=await preview.waitFor({state:'hidden',timeout:Math.min(2000,this.composerTimeoutMs)}).then(()=>true,()=>false);
    if(!closed&&await preview.isVisible().catch(()=>false)){
      const close=preview.getByRole('button',{name:/^(\u0110\u00f3ng|Close|Dismiss)(?:\s|$)/i});
      if(await close.count()===1){
        try{await close.click({timeout:2000});}
        catch(error){if(await preview.isVisible().catch(()=>false))throw error;}
      }
    }
    await preview.waitFor({state:'hidden',timeout:this.composerTimeoutMs});
  }
  async cleanComposer(){
    const p=this.requirePage();
    await this.assertConnected();
    await this.closePreview();
    const input=this.composer();
    // Muse remounts the composer after closing media; keep the current conversation.
    try{await input.waitFor({state:'visible',timeout:this.composerTimeoutMs});}
    catch{throw Error('Không thấy ô chat Muse sau khi chờ giao diện sẵn sàng. Giữ nguyên cuộc chat để tiếp tục cảnh.');}
    await p.getByRole('button',{name:/^(D\u1eebng nhi\u1ec7m v\u1ee5|Stop task)$/i}).waitFor({state:'hidden',timeout:this.composerTimeoutMs});
    const draft=await input.evaluate(element=>'value' in element?element.value:element.textContent||'');
    if(draft.trim())throw Error('Ô chat Muse còn bản nháp; hãy xử lý trước.');
    return input;
  }
  async planScenes(job,imagePath){
    const p=this.requirePage(),input=await this.cleanComposer();
    const marker=`PLAN_${job.id.replaceAll('-','_')}`;
    const prompt=`Chỉ lập kế hoạch, KHÔNG tạo video hoặc ảnh trong lượt này. Dựa vào ẢNH ĐÍNH KÈM và nội dung thương hiệu, phân tích thành đúng ${job.scene_count} cảnh video dọc 9:16, mỗi cảnh ${job.scene_seconds} giây. Giữ chủ thể và phong cách ảnh tham chiếu nhất quán. Trả về DUY NHẤT một đối tượng JSON hợp lệ, không giải thích, gồm trường id bằng ${marker} và trường scenes là mảng đúng ${job.scene_count} đối tượng. Mỗi đối tượng cảnh có index là số thứ tự từ 1 và prompt là mô tả hình ảnh, chuyển động cụ thể dài ít nhất 15 ký tự. Mỗi prompt phải độc lập và không có văn bản trên video. Nội dung: ${job.content}`;
    await this.attachReference(imagePath);
    await input.fill(prompt);await input.press('Enter');
    const until=Date.now()+150000;
    while(Date.now()<until){
      if(p.isClosed())throw Error('Muse đã đóng trong lúc lập kế hoạch.');
      await this.assertConnected();
      const body=await p.locator('body').innerText();
      const parsed=parseScenePlan(body,job.id,job.scene_count);
      if(parsed)return parsed;
      await new Promise(resolve=>setTimeout(resolve,2500));
    }
    throw Error('Muse không trả về kế hoạch cảnh đúng định dạng. Hãy xem cửa sổ Muse trước khi xử lý tiếp.');
  }
  async attachReference(imagePath){
    const p=this.requirePage();
    const inputs=p.locator('input[type="file"]');
    const count=await inputs.count();
    for(let i=0;i<count;i++){
      const item=inputs.nth(i),accept=(await item.getAttribute('accept')||'').toLowerCase();
      if(!accept||accept.includes('image')||accept.includes('.png')||accept.includes('.jpg')){
        await item.setInputFiles(imagePath);return;
      }
    }
    const attach=p.getByRole('button',{name:/^(Thêm ảnh|Đính kèm|Tải ảnh lên|Add image|Attach|Upload)$/i});
    if(await attach.count()===1){
      const chooser=p.waitForEvent('filechooser',{timeout:10000});
      await attach.click();await (await chooser).setFiles(imagePath);return;
    }
    throw Error('Không thấy nút tải ảnh tham chiếu trên Muse. Giao diện Muse có thể đã đổi.');
  }
  async downloadScene(fileId){
    const p=this.requirePage();
    const dialog=this.preview();
    await dialog.waitFor({state:'visible',timeout:30000});
    const video=dialog.locator('video');if(await video.count()!==1)throw Error('Không xác định được video duy nhất.');
    const metadata=await video.evaluate(element=>({duration:element.duration,width:element.videoWidth,height:element.videoHeight}));
    await mkdir(this.downloadsDir,{recursive:true});
    const pending=p.waitForEvent('download',{timeout:45000});pending.catch(()=>{});
    await dialog.getByRole('button',{name:/^(Tải xuống|Download)$/i}).click();
    const download=await pending,temp=path.join(this.downloadsDir,fileId+'.part'),target=path.join(this.downloadsDir,fileId+'.mp4');
    try{
      await download.saveAs(temp);
      if(await download.failure())throw Error('Muse không tải xong cảnh.');
      if((await stat(temp)).size<1024)throw Error('MP4 tải về quá nhỏ.');
      const handle=await open(temp,'r'),header=Buffer.alloc(64);try{await handle.read(header,0,64,0);}finally{await handle.close();}
      if(!header.includes(Buffer.from('ftyp')))throw Error('File tải về không phải MP4.');
      await rename(temp,target);
      await this.closePreview();
      return {path:target,...metadata};
    }catch(error){await unlink(temp).catch(()=>{});throw error;}
  }
  async sceneResponse(requestKey){
    const p=this.requirePage();
    const buttons=p.getByRole('button',{name:/^(M\u1edf|Xem) video\b|^(Open|View|Play) (?:animated )?video\b/i});
    const elements=await buttons.elementHandles();
    const state=await p.evaluateHandle(({elements,key})=>{
      // Match outputs after this request, regardless of how many old cards remain mounted.
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      let node,anchor=null;
      while((node=walker.nextNode())){
        if(node.textContent.includes(key)&&!node.parentElement.closest('textarea,input,[contenteditable="true"],[role="textbox"],script,style'))anchor=node.parentElement;
      }
      const video=anchor?elements.find(element=>element.isConnected&&!element.closest('[role="dialog"]')&&Boolean(anchor.compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING)):null;
      return {requested:Boolean(anchor),video:video||null};
    },{elements,key:requestKey});
    await Promise.all(elements.map(element=>element.dispose()));
    const requestedHandle=await state.getProperty('requested');
    const requested=await requestedHandle.jsonValue();await requestedHandle.dispose();
    const videoHandle=await state.getProperty('video'),video=videoHandle.asElement();
    if(!video)await videoHandle.dispose();
    await state.dispose();
    return {requested,video};
  }
  async generateScene(job,scene,imagePath,{resumeOnly=false}={}){
    const p=this.requirePage();
    const requestKey=`Cảnh ${scene.index}/${job.scene_count} của video thương hiệu ${job.id}.`;
    const receiptFile=path.join(this.downloadsDir,job.id,`request-${scene.index}.json`);
    let receipt=null;
    try{receipt=JSON.parse(await readFile(receiptFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(receipt){
      const url=new URL(receipt.url);
      if(url.protocol!=='https:'||url.hostname!=='muse.ai')throw Error('Địa chỉ cuộc chat đã lưu không hợp lệ.');
      if(p.url()!==url.href)await p.goto(url.href,{waitUntil:'domcontentloaded'});
    }
    await this.closePreview();
    await this.composer().waitFor({state:'visible',timeout:this.composerTimeoutMs});
    let response=await this.sceneResponse(requestKey);
    if(!response.requested){
      if(receipt||resumeOnly)throw Error(`Không thấy yêu cầu cảnh ${scene.index} đã gửi trong cuộc chat Muse. Mở lại đúng cuộc chat rồi tiếp tục; worker chưa gửi lại yêu cầu.`);
      const input=await this.cleanComposer();
      await this.attachReference(imagePath);
      await input.fill(`${requestKey} Dùng ẢNH ĐÍNH KÈM làm tham chiếu cho chủ thể, màu sắc và phong cách. Tạo đúng một video ${job.scene_seconds} giây, khổ dọc 9:16. Không dùng dữ liệu cũ ngoài ảnh này. Không chèn chữ, không đăng lên mạng xã hội. Nếu không hỗ trợ ảnh hoặc thời lượng, hãy báo lại, không tự đổi yêu cầu. Trả file MP4. Mô tả cảnh: ${scene.prompt}`);
      // Save before Enter so an interrupted worker cannot silently submit twice.
      receipt={url:p.url(),requestKey,sentAt:new Date().toISOString()};
      await mkdir(path.dirname(receiptFile),{recursive:true});
      await writeFile(receiptFile,JSON.stringify(receipt));
      await input.press('Enter');
      console.log(`Cảnh ${scene.index}/${job.scene_count}: đã gửi, đang chờ video của đúng cảnh.`);
    }else{
      console.log(`Cảnh ${scene.index}/${job.scene_count}: tiếp tục nhận kết quả yêu cầu đã gửi.`);
    }
    const until=Date.now()+this.sceneTimeoutMs;
    while(Date.now()<until){
      if(p.isClosed())throw Error('Cửa sổ Muse đã đóng giữa chừng.');
      await this.assertConnected();
      if(receipt&&receipt.url!==p.url()){
        receipt.url=p.url();await writeFile(receiptFile,JSON.stringify(receipt));
      }
      if(response.video){
        try{
          await response.video.click();
          console.log(`Cảnh ${scene.index}/${job.scene_count}: đã nhận video, đang tải MP4.`);
          return await this.downloadScene(`${job.id}-${scene.index}`);
        }finally{await response.video.dispose();}
      }
      await new Promise(resolve=>setTimeout(resolve,this.pollMs));
      response=await this.sceneResponse(requestKey);
    }
    if(response.video)await response.video.dispose();
    throw Error(`Chưa nhận được MP4 cho cảnh ${scene.index} sau ${Math.round(this.sceneTimeoutMs/60000)} phút. Yêu cầu đã gửi được giữ lại để tiếp tục, không tự tạo trùng.`);
  }
}
