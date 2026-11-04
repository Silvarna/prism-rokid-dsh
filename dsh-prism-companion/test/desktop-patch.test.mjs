import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { desktopPatch } from '../desktop-patch.mjs';

test('desktop patch uses the installed companion path', () => {
  const entry = path.resolve('another location', 'index.js');
  const patch = desktopPatch(entry);
  assert.match(patch, /id: prism-companion/);
  assert.ok(patch.includes(JSON.stringify(entry.replaceAll('\\', '/'))));
});
