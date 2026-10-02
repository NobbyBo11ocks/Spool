import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResponse, classifyUrl, dedupeKey, MAX_URL_LENGTH } from '../extension/lib/detect.js';

const resp = (url, type = 'video/mp4') => ({ url, statusCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Content-Length', value: '5000000' }] });

test('dedupeKey: signing tokens and cache busters are ignored, identifying parameters are not', () => {
  const same = [
    ['https://cdn.test/v/a.mp4?token=1&exp=2#t=3', 'https://cdn.test/v/a.mp4?token=9&exp=8'],
    ['https://cdn.test/v/a.mp4?X-Amz-Signature=aaa&X-Amz-Expires=60', 'https://cdn.test/v/a.mp4?X-Amz-Signature=bbb&X-Amz-Expires=90'],
    ['https://cdn.test/v/a.mp4?sv=1&sig=abc&se=2026&sp=r&id=5', 'https://cdn.test/v/a.mp4?id=5&sig=zzz&se=2027'],
    ['https://cdn.test/v/a.mp4?_=1700000000', 'https://cdn.test/v/a.mp4'],
    ['https://cdn.test/s.m3u8?hdnts=exp~1', 'https://cdn.test/s.m3u8?hdnts=exp~2'],
    ['https://cdn.test/v/a.mp4?b=2&a=1', 'https://cdn.test/v/a.mp4?a=1&b=2'],
  ];
  for (const [a, b] of same) assert.equal(dedupeKey(a), dedupeKey(b), `${a} == ${b}`);
  const different = [
    ['https://cdn.test/watch.mp4?id=1', 'https://cdn.test/watch.mp4?id=2'],
    ['https://cdn.test/v/a.mp4?quality=hd', 'https://cdn.test/v/a.mp4?quality=sd'],
    ['https://cdn.test/v/a.mp4', 'https://other.test/v/a.mp4'],
    ['https://cdn.test/stream?id=1&range=0-9', 'https://cdn.test/stream?id=2&range=0-9'],
  ];
  for (const [a, b] of different) assert.notEqual(dedupeKey(a), dedupeKey(b), `${a} != ${b}`);
  assert.equal(dedupeKey('not a url'), 'not a url');
});

test('absurdly long URLs are ignored, so a page cannot fill the extension storage with a few links', () => {
  const long = `https://cdn.test/${'a'.repeat(MAX_URL_LENGTH)}.mp4`;
  assert.equal(classifyUrl(long), null);
  assert.equal(classifyResponse(resp(long)), null);
  assert.notEqual(classifyUrl(`https://cdn.test/${'a'.repeat(1000)}.mp4`), null);
});

test('sameSite: related hosts get cookies, unrelated ones do not', async () => {
  const { sameSite } = await import('../extension/lib/util.js');
  assert.equal(sameSite('https://www.example.com/a', 'https://cdn.example.com/b'), true);
  assert.equal(sameSite('https://example.com', 'https://a.b.example.com'), true);
  assert.equal(sameSite('https://shop.example.co.uk', 'https://cdn.example.co.uk'), true);
  assert.equal(sameSite('https://example.co.uk', 'https://other.co.uk'), false, 'co.uk is a public suffix, not an owner');
  assert.equal(sameSite('https://example.com', 'https://example.net'), false);
  assert.equal(sameSite('https://bank.example.net', 'https://cdn.example.com'), false);
  assert.equal(sameSite('http://127.0.0.1:4174/x', 'http://127.0.0.1:4175/y'), true);
  assert.equal(sameSite('http://127.0.0.1/x', 'http://127.0.0.2/y'), false);
  assert.equal(sameSite('http://localhost:1/x', 'http://localhost:2/y'), true);
  assert.equal(sameSite('not a url', 'https://example.com'), false);
});
