const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSseParser } = require('../src/main/sse');

test('parses events split across chunks', () => {
  const got = [];
  const push = createSseParser((event, data) => got.push([event, JSON.parse(data)]));
  push('event: delta\ndata: {"te');
  push('xt":"Hel"}\n\nevent: delta\r\ndata: {"text":"lo"}\r\n\r\n');
  push('event: done\ndata: {}\n\n');
  assert.deepEqual(got, [['delta', { text: 'Hel' }], ['delta', { text: 'lo' }], ['done', {}]]);
});

test('defaults event name to message and ignores comments', () => {
  const got = [];
  const push = createSseParser((event, data) => got.push([event, data]));
  push(': keep-alive\n\ndata: hi\n\n');
  assert.deepEqual(got, [['message', 'hi']]);
});
