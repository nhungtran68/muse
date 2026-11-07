import test from 'node:test';
import assert from 'node:assert/strict';
import {displayMessage} from './display-text.mjs';

test('system messages hide provider names without losing the reason', () => {
  assert.equal(displayMessage('Không thấy ô chat Muse. Hãy thử lại.'), 'Không thấy ô chat hệ thống. Hãy thử lại.');
  assert.equal(displayMessage('MUSE_TIMEOUT: Muse.ai không phản hồi'), 'lỗi hệ thống: hệ thống không phản hồi');
  assert.equal(displayMessage(null), '');
});
