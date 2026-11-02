import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScenePlan} from './muse-adapter.mjs';
import {validateScene} from './ffmpeg.mjs';

const id='59f9bb31-923f-4c71-981c-f7ff69e46866';
const marker='PLAN_'+id.replaceAll('-','_');

test('only a complete Muse scene plan with the requested ID and count is accepted',()=>{
  const echoed=`Hãy trả về JSON với id ${marker}, 2 cảnh.`;
  assert.equal(parseScenePlan(echoed,id,2),null);
  const reply=`${echoed}\n{\"id\":\"${marker}\",\"scenes\":[{\"index\":1,\"prompt\":\"Cảnh mở đầu với sản phẩm trên bàn gỗ và camera tiến chậm\"},{\"index\":2,\"prompt\":\"Cảnh kết với logo thương hiệu trên nền sản phẩm tự nhiên\"}]}`;
  const result=parseScenePlan(reply,id,2);
  assert.equal(result.length,2);
  assert.equal(result[0].index,1);
  assert.equal(parseScenePlan(reply,id,3),null);
  assert.equal(parseScenePlan(reply.replaceAll(marker,'OTHER_MARKER'),id,2),null);
});

test('wrong duration or frame ratio is stopped before joining',()=>{
  assert.doesNotThrow(()=>validateScene({duration:10,width:720,height:1280,codec:'h264'},10));
  assert.throws(()=>validateScene({duration:8,width:720,height:1280,codec:'h264'},10),/thời lượng/);
  assert.throws(()=>validateScene({duration:10,width:1280,height:720,codec:'h264'},10),/9:16/);
});
