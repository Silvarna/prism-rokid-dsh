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
    process.env.PRISM_DSH_HOME = path.join(root, 'missing');
    assert.throws(() => resolveDshHome(), /DSH home is invalid/);
  } finally {
    if (previous.prism === undefined) delete process.env.PRISM_DSH_HOME;
    else process.env.PRISM_DSH_HOME = previous.prism;
    if (previous.dsh === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.dsh;
    fs.rmSync(root, { recursive:true, force:true });
  }
});
