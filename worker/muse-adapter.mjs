import {mkdir,rename,stat,unlink,open} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

function installedBrowserExecutable(){
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
  constructor(profileDir,downloadsDir){this.profileDir=profileDir;this.downloadsDir=downloadsDir;}
  async open(){
    if(this.page&&!this.page.isClosed())return this.page;
    const {chromium}=await import('playwright');
    const executablePath=installedBrowserExecutable();
    this.context=await chromium.launchPersistentContext(this.profileDir,{headless:false,acceptDownloads:true,viewport:null,...(executablePath?{executablePath}:{})});
    this.page=this.context.pages()[0]||await this.context.newPage();
    await this.page.goto('https://muse.ai/',{waitUntil:'domcontentloaded'});
    return this.page;
  }
  async waitForLogin(){
    const p=await this.open();
    console.log('Hãy đăng nhập Muse trong cửa sổ vừa mở; worker sẽ tiếp tục khi thấy ô chat.');
    await p.getByRole('textbox',{name:/^(Nhắn tin|Message)$/i}).waitFor({state:'visible',timeout:600000});
    console.log('Đã thấy ô chat Muse.');
  }
  requirePage(){
    if(!this.page||this.page.isClosed()||new URL(this.page.url()).hostname!=='muse.ai')throw Error('Cửa sổ Muse không sẵn sàng.');
    return this.page;
  }
  async cleanComposer(){
    const p=this.requirePage();
    const preview=p.getByRole('dialog',{name:/Xem trước file phương tiện|Media preview/i});
    if(await preview.isVisible().catch(()=>false))await preview.getByRole('button',{name:/^(Đóng|Close)$/i}).click();
    if(await p.getByRole('button',{name:/^(Dừng nhiệm vụ|Stop task)$/i}).count())throw Error('Muse đang làm tác vụ khác.');
    const input=p.getByRole('textbox',{name:/^(Nhắn tin|Message)$/i});
    if(await input.count()!==1||!await input.isVisible())throw Error('Không thấy ô chat Muse.');
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
    const dialog=p.getByRole('dialog',{name:/Xem trước file phương tiện|Media preview/i});
    if(!await dialog.isVisible())throw Error('Không thấy cửa sổ video mới.');
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
      await rename(temp,target);return {path:target,...metadata};
    }catch(error){await unlink(temp).catch(()=>{});throw error;}
  }
  async generateScene(job,scene,imagePath){
    const p=this.requirePage(),input=await this.cleanComposer();
    const resultButtons=p.getByRole('button',{name:/^(Mở video có hoạt ảnh|Open animated video)/i});
    const previous=await resultButtons.count();
    await this.attachReference(imagePath);
    await input.fill(`Cảnh ${scene.index}/${job.scene_count} của video thương hiệu ${job.id}. Dùng ẢNH ĐÍNH KÈM làm tham chiếu cho chủ thể, màu sắc và phong cách. Tạo đúng một video ${job.scene_seconds} giây, khổ dọc 9:16. Không dùng dữ liệu cũ ngoài ảnh này. Không chèn chữ, không đăng lên mạng xã hội. Nếu không hỗ trợ ảnh hoặc thời lượng, hãy báo lỗi, không tự đổi yêu cầu. Trả file MP4. Mô tả cảnh: ${scene.prompt}`);
    await input.press('Enter');
    const until=Date.now()+13*60*1000;
    while(Date.now()<until){
      if(p.isClosed())throw Error('Cửa sổ Muse đã đóng giữa chừng.');
      if(await resultButtons.count()>previous){await resultButtons.last().click();return this.downloadScene(`${job.id}-${scene.index}`);}
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
    throw Error('Chưa thấy MP4 của cảnh sau 13 phút. Kiểm tra Muse; không tự gửi lại.');
  }
}
