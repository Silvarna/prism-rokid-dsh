#!/usr/bin/env node
'use strict';
// node scripts/diagnose.js [session-id]  ->  writes ~/.prism-dsh/diagnose.txt (and prints it)
// Shows: which DSH folder is used, companion/ACP status, session list, and for one session
// the raw row kinds plus how the plugin turns them into a thread. Message text is cut to 40 chars.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const history = require('../history-reader');
const { resolveDshHomeInfo } = require('../dsh-home');
const out = [];
const say = (...a) => out.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
(async () => {
  say('platform', process.platform, 'node', process.version, 'zstd in-process', history.canDecodeInProcess());
  const info = resolveDshHomeInfo();
  say('home', info.home || '(none)', 'from', info.source); say('tried', info.tried);
  if (!info.home) return;
  const desc = path.join(info.home, 'prism-companion.json');
  if (fs.existsSync(desc)) {
    const d = JSON.parse(fs.readFileSync(desc, 'utf8'));
    try {
      const r = await fetch(`http://127.0.0.1:${d.port}/health`, { headers:{ authorization:`Bearer ${d.token}` }, signal:AbortSignal.timeout(3000) });
      say('companion', r.status, await r.text());
    } catch (e) { say('companion descriptor exists but not reachable:', e.cause?.code || e.message); }
  } else say('companion: no prism-companion.json (companion not loaded in DSH desktop)');
  const { Adapter } = require('../index');
  const a = new Adapter();
  const p = await a.probe(); say('probe', p); a.close();
  let list = [];
  try { list = history.list(info.home); } catch (e) { say('list failed', e.message); }
  say('sessions', list.length); for (const s of list.slice(0, 8)) say(' ', s.id, s.updatedAt, JSON.stringify(s.title).slice(0, 40));
  const id = process.argv[2] || list[0]?.id; if (!id) return;
  const root = path.join(info.home, 'sessions');
  let file;
  for (const w of fs.readdirSync(root)) for (const n of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) { const f = path.join(root, w, id, n); if (fs.existsSync(f)) file = f; }
  say('session', id, file);
  const text = history.decode(file);
  const rows = text.split('\n').filter(Boolean).map(x => JSON.parse(x));
  const counts = {};
  for (const r of rows.slice(1)) {
    const m = r.type === 'user/message' ? r.data : r.type === 'assistant/message' ? r.data?.message : null;
    const k = [r.type, m?.role, m?.source?.kind, typeof r.surfaceOp === 'object' ? 'replace' : r.surfaceOp, Number.isFinite(r.time) ? 'time' : 'no-time', m ? (m.content || []).map(c => c.type).join('+') : ''].join(' | ');
    counts[k] = (counts[k] || 0) + 1;
  }
  say('row kinds (type | role | source.kind | surfaceOp | time | content types): count');
  for (const [k, v] of Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 40)) say(' ', v, k);
  say('last 20 raw message rows:');
  for (const r of rows.filter(r => /message/.test(r.type)).slice(-20)) {
    const m = r.type === 'user/message' ? r.data : r.data?.message;
    const t = (m?.content || []).filter(c => c.type === 'text').map(c => c.text).join('').replace(/\s+/g, ' ').slice(0, 40);
    say(' ', r.seq, r.type, m?.role, m?.source?.kind, r.time, JSON.stringify(t));
  }
  say('plugin thread (last 20):');
  for (const m of history.project(text, id).slice(-20)) say(' ', m.CreatedAt, m.Role, m.ID, JSON.stringify(m.Content.replace(/\s+/g, ' ').slice(0, 40)));
})().catch(e => say('ERROR', e.stack)).finally(() => {
  const txt = out.join('\n') + '\n';
  const dir = path.join(os.homedir(), '.prism-dsh'); fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(dir, 'diagnose.txt'), txt); process.stdout.write(txt);
  process.stdout.write(`\nSaved: ${path.join(dir, 'diagnose.txt')}\n`); process.exit(0);
});
