'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Adapter, Acp } = require('../index');
const { project } = require('../history-reader');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('detail returns the SDK model option and native identity', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dsh-detail-'));
  const id = 'session-18a4b129-317e-42c9-b601-c5a5c8fd58a2';
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ record:{ rows:{ modelSelection:{ val:{ lastUsed:{ provider:'test', model:'model-a' } } } } } }));
  const old = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const detail = await new Adapter().readDetail({ NativeSessionID:id });
    assert.deepEqual(detail.current_model, { option_id:'model-a', label:'model-a', available:true, current:true });
    assert.equal(detail.native_conversation_id, id);
    assert.deepEqual(detail.model_options, [{ option_id:'model-a', label:'model-a', available:true, current:true }]);
  } finally {
    if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old;
    fs.rmSync(home, { recursive:true, force:true });
  }
});

test('desktop model catalog is selectable and control confirms the new model', async () => {
  const a = new Adapter();
  const id = `session-${require('node:crypto').randomUUID()}`;
  const session = a.native(id, process.cwd(), true);
  let current = { provider:'mock', model:'first' };
  const models = [
    { provider:'mock', model:'first', label:'First', providerLabel:'Mock' },
    { provider:'mock', model:'second', label:'Second', providerLabel:'Mock' },
  ];
  a.companionRequest = async (route, payload) => {
    if (route.startsWith('/models/')) return { current, models, status:'idle' };
    if (route === '/model') { current = { provider:payload.provider, model:payload.model }; return { current, models }; }
    throw Error(route);
  };
  const detail = await a.readDetail(session);
  assert.equal(detail.model_options.length, 2);
  assert.equal(detail.current_model.label, 'First · Mock');
  assert.equal(detail.model_options[1].target.option_id, detail.model_options[1].key);
  assert.equal(detail.actions[0].id, 'model.switch');
  assert.equal((await a.controlSession({ session, action:'controls.describe', metadata:{} })).details.model_options.length, 2);
  const second = detail.model_options[1];
  const result = await a.controlSession({ session, action:'model.switch', target:{ option_id:second.option_id }, metadata:{} });
  assert.equal(result.ok, true);
  assert.equal(result.details_confirmed, true);
  assert.equal(result.details.current_model.label, 'Second · Mock');
  await assert.rejects(a.controlSession({ session, action:'model.switch', target:{ option_id:'unknown' }, metadata:{} }), /Unknown/);
});

test('selecting another known DSH conversation confirms its native identity without resuming it', async () => {
  const a = new Adapter();
  const id = `session-${require('node:crypto').randomUUID()}`;
  const session = a.native(id, process.cwd());
  a.listSessions = async () => [{ NativeSessionID:id }];
  a.readDetail = async () => ({ native_conversation_id:id, current_model:{ label:'Second' } });
  a.acp = { start:async () => { throw Error('selection must not resume ACP'); }, close() {} };
  const result = await a.controlSession({ session, action:'conversation.select', metadata:{} });
  assert.equal(result.ok, true);
  assert.equal(result.thread_id, id);
  assert.equal(result.details.native_conversation_id, id);
  await assert.rejects(a.controlSession({ session:{ NativeSessionID:'missing' }, action:'conversation.select', metadata:{} }), /not in the local/);
});

test('plugin-wide watcher reports persisted sessions and later additions', async () => {
  const a = new Adapter();
  const first = a.native(`session-${require('node:crypto').randomUUID()}`, process.cwd());
  const second = a.native(`session-${require('node:crypto').randomUUID()}`, process.cwd());
  let rows = [{ ...first, Title:'First', LastActivityAt:'2026-11-03T00:00:00Z' }];
  a.listSessions = async () => rows;
  const controller = new AbortController();
  const stream = a.subscribePlugin(controller.signal)[Symbol.asyncIterator]();
  const initial = (await stream.next()).value;
  assert.equal(initial.Type, 'desktop.session.index.changed');
  assert.equal(initial.Payload.native_session.native_session_id, first.NativeSessionID);
  assert.equal(initial.Payload.session_hint.title, 'First');
  assert.equal((await stream.next()).value.Type, 'desktop.session.directory.reconciled');
  rows = [...rows, { ...second, Title:'Second', LastActivityAt:'2026-11-03T00:01:00Z' }];
  const added = (await stream.next()).value;
  assert.equal(added.Payload.native_session.native_session_id, second.NativeSessionID);
  controller.abort();
  assert.equal((await stream.next()).value.Type, 'desktop.session.directory.reconciled');
  assert.equal((await stream.next()).done, true);
});

test('new session, prompt, completion and concurrent prompt rejection', async () => {
  const a = new Adapter(); let finish;
  a.acp = { start: async () => {}, call: async (method, p) => {
    if (method === 'session/new') return { sessionId:'s1' };
    if (method === 'session/prompt') { assert.equal(p.prompt[0].text, 'hello'); return new Promise(r => { finish = r; }); }
    throw Error(method);
  }, close() {} };
  const start = await a.startSessionWithMessage({ Cwd:process.cwd(), Message:{ PrismMessageID:'r1', Text:'hello' } });
  assert.equal(start.Session.NativeSessionID, 's1');
  assert.equal(start.Visibility.Visible, false);
  await assert.rejects(a.send(start.Session, { Text:'second' }), /already running/);
  a.event('s1', { sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'world' } });
  finish({ stopReason:'end_turn' });
  const result = await a.waitForRun(start.Session, 'r1');
  assert.equal(result.Type, 'completed'); assert.equal(result.Summary, 'world');
  await assert.rejects(a.waitForRun(start.Session, 'other'), /Unknown/);
});

test('live desktop session attaches without ACP and sends through companion', async () => {
  const a = new Adapter();
  const id = `session-${require('node:crypto').randomUUID()}`;
  let acpCalled = false;
  a.acp = { start:async () => { acpCalled = true; throw Error('ACP must not resume desktop session'); }, close() {} };
  a.companionSession = async () => ({ active:true, status:'idle' });
  let request;
  a.companionRequest = async (route, payload) => {
    if (route === '/send') { request = payload; return { state:'completed', nativeMessageId:'native-user-1' }; }
    throw Error(route);
  };
  a.readHistory = async () => [
    { ID:'native-user-1', Role:'user', Content:'hello' },
    { ID:'assistant-1', Role:'assistant', Content:'world' },
  ];
  const session = await a.attachSession({ NativeSessionID:id, Cwd:process.cwd() });
  assert.equal(session.Visible, true);
  assert.equal(acpCalled, false);
  const receipt = await a.send(session, { Text:'hello', PrismMessageID:require('node:crypto').randomUUID() });
  assert.equal(receipt.Accepted, true);
  assert.equal(receipt.Visible, true);
  assert.equal(receipt.NativeMessageID, request.messageId);
  assert.equal(request.sessionId, id);
  const event = await a.waitForRun(session, receipt.NativeMessageID);
  assert.equal(event.Status, 'completed');
  assert.equal(event.Summary, 'world');
});

test('live history stream emits a reply written after the page opens', async () => {
  const a = new Adapter();
  const session = a.native(`session-${require('node:crypto').randomUUID()}`, process.cwd());
  const messages = [{ ID:'user-1', Role:'user', Content:'hello', CreatedAt:'2026-01-01T00:00:00.000Z' }];
  a.readHistory = async () => messages.slice();
  const controller = new AbortController();
  const stream = a.readHistoryStream(session, { stream_id:'stream-1', live:true }, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.turn.messages[0].ID, 'user-1');
  assert.equal((await stream.next()).value.type, 'page_end');
  messages.push({ ID:'assistant-1', Role:'assistant', Content:'world', CreatedAt:'2026-01-01T00:00:01.000Z' });
  const live = (await stream.next()).value;
  assert.equal(live.type, 'turn');
  assert.equal(live.source, 'live');
  assert.equal(live.turn.messages[0].Content, 'world');
  controller.abort();
  assert.equal((await stream.next()).done, true);
});

test('live companion text appears incrementally and final reply replaces its preview', async () => {
  const a = new Adapter();
  const session = a.native(`session-${require('node:crypto').randomUUID()}`, process.cwd());
  const messages = [];
  a.readHistory = async () => messages.slice();
  const controller = new AbortController();
  const stream = a.readHistoryStream(session, { stream_id:'stream-live', live:true }, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.type, 'page_end');
  const run = { id:'run-1', mode:'companion', running:true, text:'Hel', startedAt:'2026-01-01T00:00:00.000Z' };
  a.runs.set(session.NativeSessionID, run);
  const first = (await stream.next()).value;
  assert.equal(first.turn.messages[0].Content, 'Hel');
  assert.equal(first.operation, 'append');
  run.text = 'Hello';
  const second = (await stream.next()).value;
  assert.equal(second.turn.messages[0].Content, 'Hello');
  assert.equal(second.operation, 'replace');
  run.running = false;
  run.finalMessage = { ID:'native-assistant', Content:'Hello!', CreatedAt:'2026-01-01T00:00:01.000Z' };
  messages.push({ ...run.finalMessage, Role:'assistant' });
  const final = (await stream.next()).value;
  assert.equal(final.turn.messages[0].Content, 'Hello!');
  assert.equal(final.turn.messages[0].Status, 'completed');
  controller.abort();
  assert.equal((await stream.next()).done, true);
});

test('approval requests are cancelled and never silently granted', () => {
  const sent = []; const acp = new Acp(() => {});
  acp.child = { stdin:{ write:s => sent.push(JSON.parse(s)) } };
  acp.receive(JSON.stringify({ jsonrpc:'2.0', id:12, method:'session/request_permission', params:{} }));
  assert.deepEqual(sent[0].result, { outcome:{ outcome:'cancelled' } });
});

test('failed prompts produce failed run and do not report success', async () => {
  const a = new Adapter(); a.sessions.set('s', process.cwd());
  a.acp = { call: async () => { throw Error('model unavailable'); }, close() {} };
  await a.send(a.native('s', process.cwd()), { Text:'hi', PrismMessageID:'x' });
  const event = await a.waitForRun(a.native('s', process.cwd()), 'x');
  assert.equal(event.Status, 'failed'); assert.match(event.Summary, /model unavailable/);
});

test('history exposes user and assistant text and excludes internal messages', () => {
  const id = '18a4b129-317e-42c9-b601-c5a5c8fd58a2';
  const lines = [
    {type:'session',version:4,id},
    {type:'user/message',seq:1,time:1000,surfaceOp:'append',data:{id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'hello'}]}},
    {type:'user/message',seq:2,time:2000,surfaceOp:'append',data:{id:'internal',role:'user',source:{kind:'plugin'},content:[{type:'text',text:'hidden'}]}},
    {type:'assistant/message',seq:3,time:3000,surfaceOp:'append',data:{message:{id:'a',role:'assistant',content:[{type:'text',text:'hi'}]}}},
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(project(lines,id).map(m => [m.Role,m.Content]), [['user','hello'],['assistant','hi']]);
  assert.throws(() => project(lines,'another'), /identity/);
});
