import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../index.js';

test('authenticated live agent receives one identified followup and reports completion', async () => {
  const token = 'test-secret';
  const sessionId = `session-${randomUUID()}`;
  const messageId = randomUUID();
  const received = [];
  let finish;
  const idle = new Promise(resolve => { finish = resolve; });
  let selected = { provider:'mock', model:'first' };
  const events = [{ type:'model/selection', data:selected }];
  const agent = { status:'idle', session:{ id:sessionId, snapshotEvents:() => events, append(type, data) { events.push({ type, data }); selected = data; } }, followup(message) { received.push(message); }, whenIdle() { return idle; } };
  let stream;
  const llm = { listProviders:() => [{ id:'mock', name:'Mock' }], listModels:async () => [{ id:'first', name:'First' }, { id:'second', name:'Second' }], resolveModelInfo:async (_, model) => { if (model === 'unavailable') throw Error('unavailable'); return {}; } };
  const handler = createHandler({ agents:{ get:id => id === sessionId ? agent : undefined }, llm, on(name, listener) { assert.equal(name, 'agent/assistant-stream'); stream = listener; } }, token);
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization:`Bearer ${token}`, 'content-type':'application/json' };
  try {
    assert.equal((await fetch(`${base}/session/${sessionId}`, { headers })).status, 200);
    const catalog = await (await fetch(`${base}/models/${sessionId}`, { headers })).json();
    assert.equal(catalog.models.length, 2);
    assert.equal(catalog.current.model, 'first');
    const changed = await fetch(`${base}/model`, { method:'POST', headers, body:JSON.stringify({ sessionId, provider:'mock', model:'second' }) });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).current.model, 'second');
    const rejected = await fetch(`${base}/model`, { method:'POST', headers, body:JSON.stringify({ sessionId, provider:'mock', model:'unavailable' }) });
    assert.equal(rejected.status, 400);
    assert.equal(selected.model, 'second');
    assert.equal((await fetch(`${base}/send`, { method:'POST', headers:{ authorization:'Bearer wrong' }, body:'{}' })).status, 401);
    const request = { sessionId, messageId, text:'hello' };
    const first = await fetch(`${base}/send`, { method:'POST', headers, body:JSON.stringify(request) });
    assert.equal(first.status, 202);
    const accepted = await first.json();
    assert.equal(accepted.state, 'running');
    assert.equal(received.length, 1);
    assert.equal(received[0].content[0].text, 'hello');
    stream({ agent, frame:{ type:'chunk', chunk:{ type:'text-delta', text:'Hel' } } });
    stream({ agent, frame:{ type:'chunk', chunk:{ type:'text-delta', text:'lo' } } });
    assert.equal((await (await fetch(`${base}/run/${messageId}`, { headers })).json()).text, 'Hello');
    const duplicate = await fetch(`${base}/send`, { method:'POST', headers, body:JSON.stringify(request) });
    assert.equal(duplicate.status, 200);
    assert.equal(received.length, 1);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    const run = await (await fetch(`${base}/run/${messageId}`, { headers })).json();
    assert.equal(run.state, 'completed');
    assert.equal(run.nativeMessageId, received[0].id);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('inactive session advertises models and changes selection through a temporary agent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prism-inactive-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const sessionId = `session-${randomUUID()}`;
  const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive:true });
  fs.writeFileSync(cacheFile, JSON.stringify({ record:{ rows:{ modelSelection:{ val:{ lastUsed:{ provider:'mock', model:'first' } } } } } }));
  let resumed = 0, disposed = 0;
  const sidebarEvents = [];
  const events = [{ type:'model/selection', data:{ provider:'mock', model:'first' } }];
  const agent = { status:'idle', session:{ snapshotEvents:() => events, append(type, data) { events.push({ type, data }); } } };
  const ctx = {
    agents:{ get:() => undefined, async resume(options) {
      assert.equal(options.resumeSessionId, sessionId);
      resumed++;
      return { agent, async dispose() { disposed++; } };
    } },
    llm:{ listProviders:() => [{ id:'mock', name:'Mock' }],
      listModels:async () => [{ id:'first', name:'First' }, { id:'second', name:'Second' }],
      resolveModelInfo:async () => ({}) },
    get:name => name === 'sessionController' ? {
      list:async () => ({ items:[{ sessionId, cwd:'/workspace', agentAvailable:false, blank:false }] }),
    } : undefined,
    emit:(name, summary) => { sidebarEvents.push({ name, summary }); },
    on() {},
  };
  const handler = createHandler(ctx, 'test-secret');
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization:'Bearer test-secret', 'content-type':'application/json' };
  try {
    const before = await (await fetch(`${base}/models/${sessionId}`, { headers })).json();
    assert.equal(before.active, false);
    assert.equal(before.models.length, 2);
    assert.equal(before.current.model, 'first');
    const result = await fetch(`${base}/model`, { method:'POST', headers,
      body:JSON.stringify({ sessionId, provider:'mock', model:'second' }) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).current.model, 'second');
    assert.equal(resumed, 1);
    assert.equal(disposed, 1);
    assert.equal(sidebarEvents.length, 1);
    assert.equal(sidebarEvents[0].name, 'api-session/added');
    assert.equal(sidebarEvents[0].summary.sessionId, sessionId);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    fs.rmSync(home, { recursive:true, force:true });
  }
});
