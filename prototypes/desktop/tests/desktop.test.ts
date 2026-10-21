import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedLoginUrl, panelBounds, panelUrl } from '../src/desktop/policy.js';
test('only official HTTPS login destinations can be opened externally', () => {
  assert.equal(allowedLoginUrl('https://auth.openai.com/authorize?state=example'), true);
  for (const url of ['file:///C:/Windows/test', 'https://auth.openai.com.evil.invalid/', 'http://auth.openai.com/', 'https://user:pass@auth.openai.com/', 'javascript:alert(1)']) assert.equal(allowedLoginUrl(url), false);
});

test('browser panels accept web and loopback URLs without exposing file, script or credential URLs', () => {
  assert.equal(panelUrl('http://127.0.0.1:3000/test'), 'http://127.0.0.1:3000/test');
  assert.equal(panelUrl('https://example.com'), 'https://example.com/');
  for (const value of ['file:///G:/secret', 'javascript:alert(1)', 'data:text/html,x', 'mixcat-preview://other/private', 'https://user:secret@example.com', null]) assert.throws(() => panelUrl(value));
});

test('native panel rectangles remain within the owned desktop window', () => {
  const size = { width: 1000, height: 700 };
  assert.deepEqual(panelBounds({ x: 800.2, y: 500, width: 9999, height: 9999 }, size), { x: 800, y: 500, width: 200, height: 200 });
  assert.equal(panelBounds(null, size), null);
  for (const bounds of [{ x: -1, y: 0, width: 100, height: 100 }, { x: 1, y: Infinity, width: 100, height: 100 }, { x: 0 }]) assert.throws(() => panelBounds(bounds, size));
});
