'use strict';
// Runs under DSH's Node 24/Electron runtime, which provides Zstandard.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const MAX_BYTES = 64 * 1024 * 1024;
function frames(buffer) {
  const result = []; let p = 0;
  while (p < buffer.length) {
    const start = p; if (buffer.length - p < 5) break;
    if (buffer.readUInt32LE(p) !== 0xfd2fb528) throw Error('Invalid Zstandard frame'); p += 4;
    const d = buffer[p++]; if (d & 0x18) throw Error('Invalid Zstandard descriptor');
    const f = d >>> 6, single = !!(d & 0x20), dict = d & 3;
    p += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (f === 0 ? (single ? 1 : 0) : 1 << f);
    if (p > buffer.length) break;
    let incomplete = false;
    for (;;) {
      if (buffer.length - p < 3) { incomplete = true; break; }
      const h = buffer.readUIntLE(p, 3); p += 3; const type = (h >>> 1) & 3;
      if (type === 3) throw Error('Invalid Zstandard block');
      p += type === 1 ? 1 : h >>> 3;
      if (p > buffer.length) { incomplete = true; break; }
      if (h & 1) break;
    }
    if (incomplete || p + ((d & 4) ? 4 : 0) > buffer.length) break;
    if (d & 4) p += 4;
    result.push(buffer.subarray(start, p));
  }
  return result;
}
function decode(file) {
  const stat = fs.statSync(file); if (stat.size > MAX_BYTES) throw Error('DSH history exceeds 64 MiB');
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8');
  let total = 0; const pieces = [];
  for (const frame of frames(buf)) { const out = zlib.zstdDecompressSync(frame, { maxOutputLength: MAX_BYTES - total }); total += out.length; pieces.push(out); }
  return Buffer.concat(pieces).toString('utf8');
}
function project(text, expected) {
  const rows = text.split('\n').filter(Boolean).map(x => JSON.parse(x)); const header = rows.shift();
  if (!header || header.type !== 'session' || header.id !== expected || header.version !== 4) throw Error('DSH session identity or format mismatch');
  const surface = [];
  for (const row of rows) {
    if (row.surfaceOp === 'append') surface.push(row);
    else if (row.surfaceOp && typeof row.surfaceOp === 'object') {
      const start = surface.findIndex(x => x.seq === row.surfaceOp.startSeq), end = surface.findIndex(x => x.seq === row.surfaceOp.endSeq);
      if (start < 0 || end < start) throw Error('DSH history replacement range is invalid');
      surface.splice(start, end - start + 1, row);
    }
  }
  return surface.flatMap(row => {
    const msg = row.type === 'user/message' ? row.data : row.type === 'assistant/message' ? row.data?.message : null;
    if (!msg || (msg.role === 'user' && !['user', 'user-rpc'].includes(msg.source?.kind)) || !['user', 'assistant'].includes(msg.role)) return [];
    const content = (msg.content || []).filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('');
    if (!content) return [];
    const time = Number.isFinite(row.time) ? new Date(row.time).toISOString() : new Date(0).toISOString();
    return [{ ID: String(msg.id || row.seq), Role:msg.role, Type:'message', Content:content, Status:'completed', CreatedAt:time, UpdatedAt:time }];
  });
}
function list(root) {
  const sessions = path.join(root, 'sessions');
  if (!fs.existsSync(sessions)) return [];
  let archived = new Set();
  try {
    const workspace = JSON.parse(fs.readFileSync(path.join(root, 'storages', 'workspace.json'), 'utf8'));
    archived = new Set(workspace.global?.archivedSessionIds || []);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const out = [];
  for (const workspace of fs.readdirSync(sessions, { withFileTypes:true })) {
    if (!workspace.isDirectory()) continue;
    const parent = path.join(sessions, workspace.name);
    for (const entry of fs.readdirSync(parent, { withFileTypes:true })) {
      if (!entry.isDirectory() || archived.has(entry.name) || !/^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;
      const dir = path.join(parent, entry.name);
      const file = ['session.v4.jsonl.zstd', 'session.v4.jsonl'].map(x => path.join(dir,x)).find(x => fs.existsSync(x));
      if (!file) continue;
      const buf = fs.readFileSync(file); if (buf.length > MAX_BYTES) continue;
      const first = file.endsWith('.zstd') ? zlib.zstdDecompressSync(frames(buf)[0], { maxOutputLength:1024*1024 }).toString('utf8') : buf.toString('utf8');
      const header = JSON.parse(first.split('\n')[0]);
      if (header.id !== entry.name || header.version !== 4 || header.origin === 'subagent' || !path.isAbsolute(header.cwd || '')) continue;
      let title = '';
      try { const cache = JSON.parse(fs.readFileSync(path.join(root, 'storages', 'session_projcache', 'sessions', `${entry.name}.json`), 'utf8')); if (cache.record?.identity?.createdAt === header.createdAt && cache.record?.identity?.cwd === header.cwd && typeof cache.record?.rows?.title?.val === 'string') title = cache.record.rows.title.val; } catch {}
      out.push({ id:header.id, cwd:header.cwd, title, updatedAt:fs.statSync(file).mtime.toISOString() });
    }
  }
  return out.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
if (require.main === module) { try { process.stdout.write(JSON.stringify(process.argv[2] === '--list' ? list(process.argv[3]) : project(decode(process.argv[2]), process.argv[3]))); } catch (e) { console.error(e.message); process.exitCode = 1; } }
module.exports = { frames, decode, project };
