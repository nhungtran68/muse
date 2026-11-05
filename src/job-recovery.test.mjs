import test from 'node:test';
import assert from 'node:assert/strict';
import {hasUncertainSubmission, visibleSceneStatus} from './job-recovery.mjs';

const scene = {status:'generating',submission_state:'sending',request_receipt:{key:'saved'},output_path:null};

test('uncertain submitted clips expose safe continuation and no longer look active after job failure',()=>{
  const job={status:'error',error_code:'UNCERTAIN_SUBMISSION',error:'Không tìm thấy yêu cầu cảnh 1 đã gửi; cần kiểm tra trước khi gửi lại.',brand_scenes:[scene]};
  assert.equal(hasUncertainSubmission(job),true);
  assert.equal(visibleSceneStatus(job,scene),'error');
});

test('a saved-receipt continuation remains available after the job is normalized',()=>{
  const job={status:'error',error_code:'SUBMISSION_NOT_FOUND',retryable:false,brand_scenes:[{...scene,status:'error'}]};
  assert.equal(hasUncertainSubmission(job),true);
  assert.equal(visibleSceneStatus(job,job.brand_scenes[0]),'error');
});

test('missing receipts and already stored clips never expose uncertain retry',()=>{
  const noReceipt={...scene,request_receipt:null};
  const stored={...scene,output_path:'user/job/scene.mp4'};
  for(const current of [noReceipt,stored]){
    const job={status:'error',error_code:'UNCERTAIN_SUBMISSION',error:'Không tìm thấy yêu cầu cảnh 1 đã gửi; cần kiểm tra trước khi gửi lại.',brand_scenes:[current]};
    assert.equal(hasUncertainSubmission(job),false);
    assert.equal(visibleSceneStatus(job,current),current.status);
  }
});

test('unrelated uncertain submissions do not offer automatic recovery',()=>{
  const job={status:'error',error_code:'UNCERTAIN_SUBMISSION',error:'Biên nhận cảnh không khớp lần tạo.',brand_scenes:[scene]};
  assert.equal(hasUncertainSubmission(job),false);
});
