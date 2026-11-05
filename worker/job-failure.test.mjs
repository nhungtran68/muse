import test from 'node:test';
import assert from 'node:assert/strict';
import {persistJobFailure} from './job-failure.mjs';

test('records a failed job and keeps the worker available when persistence recovers',async()=>{
  let attempts=0,stopped=false;
  const result=await persistJobFailure({persist:async()=>{if(++attempts<2)throw Error('temporary');},stop:async()=>{stopped=true;},sleep:async()=>{}});
  assert.equal(result,true);assert.equal(attempts,2);assert.equal(stopped,false);
});

test('stops and releases the worker when failure state cannot be recorded',async()=>{
  let attempts=0,stopReason=null;
  const result=await persistJobFailure({persist:async()=>{attempts++;throw Error('database unavailable');},stop:async error=>{stopReason=error;},sleep:async()=>{}});
  assert.equal(result,false);assert.equal(attempts,3);assert.equal(stopReason.message,'database unavailable');
});
