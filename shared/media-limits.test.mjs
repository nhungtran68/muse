import test from 'node:test';
import assert from 'node:assert/strict';
import {assertGeneratedMediaSize} from './media-limits.mjs';

test('generated output accepts 75 MiB and exactly 100 MiB, preserving smaller outputs',()=>{
  for(const size of [1024,50*1024*1024,75*1024*1024,104857600])assert.doesNotThrow(()=>assertGeneratedMediaSize(size));
});
test('one byte over 100 MiB is rejected with the actual limit and cannot be blindly retried',()=>{
  assert.throws(()=>assertGeneratedMediaSize(104857601),error=>error.code==='MEDIA_TOO_LARGE'&&error.retryable===false&&error.message.includes('100 MB'));
});
