import {MuseAdapter} from './muse-adapter.mjs';
import {buildStoryboardPrompt,parseMarkedJson,validateStoryboard} from '../shared/storyboard.mjs';
import {clipRequest} from '../shared/brand-video-prompt.mjs';
import {createHash} from 'node:crypto';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function summarizeMuseReply(text){
  return String(text||'').replace(/https?:\/\/\S+/gi,'[liên kết]').replace(/[A-Za-z0-9_-]{40,}/g,'[mã]').replace(/\s+/g,' ').trim().slice(0,240);
}

export function museVideoRejection(text){
  const sentences=String(text||'').split(/(?<=[.!?])\s+|\n+/u);
  return sentences.some(sentence=>{
    // A quoted instruction such as "If unsupported, report an error" is not
    // itself a refusal. Only inspect statements from this request's reply.
    if(/^\s*(?:nếu|if)(?:\s|[:,])/iu.test(sentence))return false;
    return /(?:(?:không|chưa)\s+thể\s+(?:tạo|xuất|render|giao|trả|cung cấp)(?:\s+được)?\s+(?:file\s+)?(?:video|clip|mp4)|không\s+(?:tạo|xuất|render|giao|trả|gửi)\s+được\s+(?:file\s+)?(?:video|clip|mp4)|không\s+(?:giao|trả|gửi)\s+(?:file\s+)?(?:video|clip|mp4)|(?:không|chưa)(?:\s+được)?\s+hỗ trợ|not supported|(?:cannot|can't|unable to)\s+(?:create|generate|render|deliver|provide)(?:\s+\w+){0,3}\s+(?:video|clip|mp4))/iu.test(sentence);
  });
}

// Each job needs its own conversation. If Muse changes its controls, stop instead
// of reusing another customer's conversation.
export class MuseAdapterV2 extends MuseAdapter {
  async sceneResponse(requestKey) {
    const page = this.requirePage();
    const elements = await page.getByRole('button', {
      name: /^(Mở|Xem) video\b|^(Open|View|Play) (?:animated )?video\b/i
    }).elementHandles();
    const state = await page.evaluateHandle(({elements, key}) => {
      const users = [...document.querySelectorAll('.hatch-chat-groupable-bubble.bg-chat-user-bubble')];
      const matches = users.filter(element => element.textContent.includes(key + '.'));
      const anchor = matches.length === 1 ? matches[0] : null;
      const next = anchor && users[users.indexOf(anchor) + 1];
      const follows = (left, right) => Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
      const inReply = element => anchor && follows(anchor, element) && (!next || follows(element, next));
      const video = elements.find(element => element.isConnected && !element.closest('[role="dialog"]') && inReply(element));
      const replies = [...document.querySelectorAll('.hatch-chat-groupable-bubble:not(.bg-chat-user-bubble)')].filter(inReply);
      const text = replies.map(element => element.textContent).join('\n');
      return {requested: Boolean(anchor), video: video || null, text};
    }, {elements, key: requestKey});
    await Promise.all(elements.map(element => element.dispose()));
    const requestedHandle = await state.getProperty('requested');
    const textHandle = await state.getProperty('text');
    const requested = await requestedHandle.jsonValue(), responseText = await textHandle.jsonValue();
    await requestedHandle.dispose(); await textHandle.dispose();
    const handle = await state.getProperty('video'), video = handle.asElement();
    if (!video) await handle.dispose();
    await state.dispose();
    return {requested, video, rejected:!video&&museVideoRejection(responseText),responseText:summarizeMuseReply(responseText)};
  }

  async beginJob(job) {
    const page=this.requirePage();
    await this.closePreview();
    if(job.conversation_ref?.url){
      const url=new URL(job.conversation_ref.url);
      if(url.origin!=='https://muse.ai'||!/^\/thread\/[0-9a-f-]{36}$/i.test(url.pathname))throw Error('Địa chỉ cuộc trò chuyện không hợp lệ.');
      await page.goto(url.href,{waitUntil:'domcontentloaded'});
      await this.composer().waitFor({state:'visible',timeout:this.composerTimeoutMs});
      const current = new URL(page.url());
      if (current.origin !== url.origin || current.pathname !== url.pathname) {
        throw Object.assign(Error('Muse không mở đúng cuộc trò chuyện đã lưu.'), {
          code: 'UNCERTAIN_CONVERSATION',
          retryable: false
        });
      }
      return {url:page.url()};
    }
    if(job.conversation_ref?.state==='creating')throw Object.assign(Error('Lần trước bị gián đoạn khi tạo cuộc trò chuyện; cần kiểm tra trước khi tiếp tục.'),{code:'UNCERTAIN_CONVERSATION',retryable:false});
    const fresh=page.getByRole('button',{name:/^(New side chat|New chat|New conversation|Cuộc trò chuyện mới|Trò chuyện mới|Tạo cuộc trò chuyện)$/i});
    if(!await fresh.isVisible().catch(()=>false)){
      const chats=page.getByRole('button',{name:/Open chat and side chats|Mở (?:chat|cuộc trò chuyện)/i});
      await chats.waitFor({state:'visible',timeout:this.composerTimeoutMs});
      await chats.click();
    }
    await fresh.waitFor({state:'visible',timeout:this.composerTimeoutMs});
    await fresh.click();
    await page.waitForURL(url=>url.pathname==='/thread/new',{timeout:this.composerTimeoutMs,waitUntil:'domcontentloaded'});
    await this.composer().waitFor({state:'visible',timeout:this.composerTimeoutMs});
    // The old composer can briefly survive the route change. Let Muse finish
    // mounting the new one before putting any customer data into the draft.
    await sleep(1500);
    if(new URL(page.url()).pathname!=='/thread/new')throw Error('Muse chưa mở đúng cuộc trò chuyện mới.');
    return {state:'creating'};
  }

  async storyboardResponse(marker) {
    return this.requirePage().locator('.hatch-chat-groupable-bubble').evaluateAll((elements,key)=>{
      const users=elements.filter(element=>element.classList.contains('bg-chat-user-bubble'));
      const anchor=users.filter(element=>element.textContent.includes(key)).at(-1);
      if(!anchor)return '';
      const next=users[users.indexOf(anchor)+1];
      const follows=(left,right)=>Boolean(left.compareDocumentPosition(right)&Node.DOCUMENT_POSITION_FOLLOWING);
      return elements.filter(element=>!element.classList.contains('bg-chat-user-bubble')&&follows(anchor,element)&&(!next||follows(element,next))).map(element=>element.innerText).join('\n');
    },marker);
  }

  async storyboard(job,imagePath,{onConversation=async()=>{}}={}){
    const page=this.requirePage(),marker=`PLAN_${job.id.replaceAll('-','_')}`;
    let issue='';
    for(let attempt=0;attempt<3;attempt++){
      const responseMarker=`${marker}_T${job.attempt||1}_A${attempt}`;
      const input=await this.cleanComposer();
      if(!attempt)await this.attachReference(imagePath);
      const prompt=buildStoryboardPrompt(job,responseMarker,issue);
      await input.fill(prompt);
      await sleep(1000);
      if(await input.inputValue()!==prompt)throw Object.assign(Error('Ô nhập Muse vừa tải lại; nội dung chưa được gửi. Hãy thử lại.'),{code:'MUSE_COMPOSER_RELOADED'});
      await input.press('Enter');
      await page.waitForURL(url=>/^\/thread\/[0-9a-f-]{36}$/i.test(url.pathname),{timeout:60000,waitUntil:'commit'});
      await onConversation({url:page.url()});
      const until=Date.now()+150000;
      while(Date.now()<until){
        if(page.isClosed())throw Error('Muse đã đóng trong lúc phân tích nội dung.');
        await this.assertConnected();
        const text=await this.storyboardResponse(responseMarker);
        const parsed=parseMarkedJson(text,responseMarker);
        if(parsed){
          try{return validateStoryboard({...parsed,id:marker},job);}catch(error){if(error.retryable===false)throw error;issue=error.message;break;}
        }
        await sleep(2500);
      }
      if(!issue)issue='Chưa trả về JSON đúng cấu trúc và mã yêu cầu.';
    }
    throw Object.assign(Error(`Chưa tạo được kịch bản hợp lệ: ${issue}`),{code:'STORYBOARD_INVALID'});
  }

  async generateSceneV2(job,scene,imagePath,{receipt,onBeforeSend}={}){
    const page=this.requirePage();
    const key=`BRAND_${job.id.replaceAll('-','_')}_SCENE_${scene.index}_GEN_${scene.generation||0}`;
    if(receipt&&receipt.key!==key)throw Object.assign(Error('Biên nhận cảnh không khớp lần tạo; cần kiểm tra trước khi tiếp tục.'),{code:'UNCERTAIN_SUBMISSION',retryable:false});
    let videoPrompt=job.schema_version===3?clipRequest(job,scene):null;
    let promptHash=videoPrompt?createHash('sha256').update(videoPrompt).digest('hex'):null;
    if(receipt?.prompt_sha256&&receipt.prompt_sha256!==promptHash&&job.schema_version===3){
      // Resume an already sent request with its original prompt hash. Never
      // submit it again merely because the worker was upgraded.
      const previous=clipRequest(job,scene,{legacy:true});
      if(createHash('sha256').update(previous).digest('hex')===receipt.prompt_sha256){videoPrompt=previous;promptHash=receipt.prompt_sha256;}
    }
    if(receipt?.prompt_sha256&&receipt.prompt_sha256!==promptHash)throw Object.assign(Error('Mẫu prompt hoặc lời thoại đã thay đổi sau lần gửi trước; cần kiểm tra.'),{code:'UNCERTAIN_SUBMISSION',retryable:false});
    await this.closePreview();
    await this.composer().waitFor({state:'visible',timeout:this.composerTimeoutMs});
    let response=await this.sceneResponse(key);
    if (receipt && !response.requested) {
      // The composer may appear before the saved chat messages load.
      const historyDeadline = Date.now() + Math.min(this.composerTimeoutMs, 10000);
      while (!response.requested && Date.now() < historyDeadline) {
        await sleep(Math.min(this.pollMs, historyDeadline - Date.now()));
        response = await this.sceneResponse(key);
      }
    }
    if(!response.requested){
      // A saved receipt means Enter may already have been pressed. Never resend.
      if(receipt)throw Object.assign(Error(`Không tìm thấy yêu cầu cảnh ${scene.index} đã gửi; cần kiểm tra trước khi gửi lại.`),{code:'UNCERTAIN_SUBMISSION',retryable:false});
      const input=await this.cleanComposer();
      await this.attachReference(imagePath);
      const dialogue=scene.dialogue?`Đọc lời thoại tiếng Việt đúng nguyên văn, không thêm hoặc bớt. Nếu không có nhân vật trong hình, dùng giọng thuyết minh. Đọc chậm tự nhiên, trải đều lời trong khoảng 65–90% thời lượng cảnh, bắt đầu sớm, không dồn lời rồi kết thúc quá sớm, không kéo dài âm hoặc lặp từ: “${scene.dialogue}”.`: 'Không có lời thoại hoặc giọng nói.';
      const requestText=videoPrompt?`${key}. ${videoPrompt}`:`${key}. Tạo đúng MỘT video độc lập, dùng ảnh đính kèm, ${job.scene_seconds} giây, khổ dọc 9:16. Không dùng dữ liệu từ khách hàng khác hoặc cuộc trò chuyện khác. Không thêm chữ, không đăng mạng xã hội. Nếu không hỗ trợ thời lượng, báo lỗi thay vì tự đổi. ${dialogue} Hành động và biểu cảm: ${scene.action}. Mô tả cảnh: ${scene.prompt}`;
      await input.fill(requestText);
      await sleep(400);
      if(await input.inputValue()!==requestText)throw Object.assign(Error('Ô nhập Muse đã tải lại trước khi gửi; không gửi lời thoại có thể bị thay đổi.'),{code:'MUSE_COMPOSER_RELOADED'});
      await onBeforeSend({key,url:page.url(),prepared_at:new Date().toISOString(),...(promptHash?{prompt_sha256:promptHash,script_revision:job.script_revision,template_version:job.video_prompt_version}:{})});
      await input.press('Enter');
    }
    const until=Date.now()+this.sceneTimeoutMs;
    while(true){
      await this.assertConnected();
      if(response.video){try{await response.video.click();return await this.downloadScene(`${job.id}-${scene.index}`);}finally{await response.video.dispose();}}
      if(response.rejected)throw Object.assign(Error(`Muse không giao video cảnh ${scene.index}: ${response.responseText||'Dịch vụ từ chối thông số đã chọn.'}`),{code:'MUSE_OUTPUT_REJECTED',retryable:false});
      const remaining=until-Date.now();if(remaining<=0)break;
      await sleep(Math.min(this.pollMs,remaining));response=await this.sceneResponse(key);
    }
    throw Object.assign(Error(`Chưa nhận được video cảnh ${scene.index}; có thể thử lấy tiếp kết quả đã gửi, không tạo trùng.${response.responseText?' Muse trả lời: '+response.responseText:''}`),{code:'MUSE_TIMEOUT',retryable:true});
  }
}
