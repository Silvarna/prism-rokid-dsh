'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDshHome } = require('../dsh-home');

test('explicit relocated home overrides a stale DSH_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dsh-homes-'));
  const oldHome = path.join(root, 'old');
  const movedHome = path.join(root, 'moved');
  fs.mkdirSync(path.join(oldHome, 'sessions'), { recursive:true });
  fs.mkdirSync(path.join(movedHome, 'sessions'), { recursive:true });
  const previous = { prism:process.env.PRISM_DSH_HOME, dsh:process.env.DSH_HOME };
  try {
    process.env.DSH_HOME = oldHome;
    process.env.PRISM_DSH_HOME = movedHome;
    assert.equal(resolveDshHome(), movedHome);
    // An invalid explicit path falls through to the next source.
    process.env.PRISM_DSH_HOME = path.join(root, 'missing');
    assert.equal(resolveDshHome(), oldHome);
    // A parent folder that holds .dsh is accepted.
    fs.mkdirSync(path.join(root, 'parent', '.dsh', 'sessions'), { recursive:true });
    process.env.PRISM_DSH_HOME = path.join(root, 'parent');
    assert.equal(resolveDshHome(), path.join(root, 'parent', '.dsh'));
  } finally {
    if (previous.prism === undefined) delete process.env.PRISM_DSH_HOME;
    else process.env.PRISM_DSH_HOME = previous.prism;
    if (previous.dsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.dsh;
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('saveDshHome writes config that resolution then uses', () => {
  const { saveDshHome } = require('../dsh-home');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dsh-save-'));
  fs.mkdirSync(path.join(root, 'h', 'sessions'), { recursive:true });
  const file = path.join(root, 'cfg', 'config.json');
  assert.equal(saveDshHome(path.join(root, 'h'), file).home, path.join(root, 'h'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).dsh_home, path.join(root, 'h'));
  assert.throws(() => saveDshHome(path.join(root, 'nope'), file), /Not a DSH data folder/);
  fs.rmSync(root, { recursive:true, force:true });
});
