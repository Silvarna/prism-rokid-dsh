'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const { resolveDshHome, resolveDshHomeInfo } = require('./dsh-home');
const history = require('./history-reader');
const LOG_DIR = path.join(require('node:os').homedir(), '.prism-dsh');
function log(...parts) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive:true });
    const file = path.join(LOG_DIR, 'plugin.log');
    try { if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`);
  } catch {}
}
const VERSION = require('./package.json').version;
const { resolveDshAppPath, hostCli } = require('./dsh-app');
const execFileAsync = promisify(execFile);
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { serve } = require('@rokid-prism/pluginbridge-plugin-sdk');

function modelOptionId(provider, model) {
  return `dsh:${Buffer.from(JSON.stringify([provider, model])).toString('base64url')}`;
}

function command() {
  if (process.env.PRISM_DSH_COMMAND) return { exe: process.env.PRISM_DSH_COMMAND, args: ['--profile', 'acp'], env: { DSH_HOME:resolveDshHome() } };
  if (process.platform === 'win32') {
    const exe = resolveDshAppPath();
    return { exe, args: ['--expose-internals', hostCli(exe), '--profile', 'acp'], env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME:resolveDshHome() } };
  }
  if (process.platform === 'darwin') {
    try {
      const exe = resolveDshAppPath();
      return { exe, args: ['--expose-internals', hostCli(exe), '--profile', 'acp'], env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME:resolveDshHome() } };
    } catch {}
  }
  return { exe: 'dsh', args: ['--profile', 'acp'], env: { DSH_HOME:resolveDshHome() } };
}
class Acp {
  constructor(onEvent) { this.onEvent = onEvent; this.pending = new Map(); this.n = 0; }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this.boot().catch(e => { this.ready = null; throw e; });
    return this.ready;
  }
  async boot() {
    const c = command();
    this.child = spawn(c.exe, c.args, { env: { ...process.env, ...c.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderrTail = '';
    this.child.stderr.on('data', d => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    readline.createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
    this.child.on('error', e => { log('acp spawn error', c.exe, e.message); this.fail(e); });
    this.child.on('exit', (code) => { log('acp exited', code, this.stderrTail.slice(-500)); this.fail(new Error(`DSH ACP exited (${code})${this.stderrTail ? ': ' + this.stderrTail.trim().split('\n').pop() : ''}`)); });
    await Promise.race([
      this.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'prism-dsh', version: VERSION } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DSH ACP did not answer initialize within 10 s')), 10000).unref()),
    ]).catch(error => { try { this.child.kill(); } catch {} throw error; });
  }
  fail(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); this.ready = null; this.onEvent(null, { type: 'error', error: err.message }); }
  receive(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id !== undefined) {
      // No remote approval UI is advertised: fail closed rather than grant access.
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n');
    } else if (m.method === 'session/update') this.onEvent(m.params.sessionId, m.params.update);
    else if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
  }
  call(method, params) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', err => { if (err) { this.pending.delete(id); reject(err); } }); }); }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  close() { if (this.child) this.child.kill(); }
}
class Adapter {
  constructor() { this.sessions = new Map(); this.runs = new Map(); this.listeners = new Map(); this.acp = new Acp((id, update) => this.event(id, update)); }
  id() { return 'dsh'; }
  async companionRequest(route, payload) {
    const root = resolveDshHome();
    let descriptor;
    try { descriptor = JSON.parse(await fs.promises.readFile(path.join(root, 'prism-companion.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (descriptor.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 ||
        !/^[0-9a-f]{64}$/i.test(descriptor.token || '')) throw new Error('Invalid DSH companion descriptor');
    const response = await fetch(`http://127.0.0.1:${descriptor.port}${route}`, {
      method:payload === undefined ? 'GET' : 'POST',
      headers:{ authorization:`Bearer ${descriptor.token}`, ...(payload === undefined ? {} : { 'content-type':'application/json' }) },
      body:payload === undefined ? undefined : JSON.stringify(payload),
      signal:AbortSignal.timeout(3000),
    });
    const result = await response.json();
    if (response.status === 404 && (route.startsWith('/session/') || route.startsWith('/models/'))) return null;
    if (!response.ok && response.status !== 202) throw new Error(`DSH companion: ${result.error || response.status}`);
    return result;
  }
  async companionSession(id) {
    try { return await this.companionRequest(`/session/${encodeURIComponent(id)}`); }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw error; }
  }
  async probe() {
    const info = resolveDshHomeInfo();
    let ok = false, reason = '';
    const companion = info.home ? await this.companionRequest('/health').catch(e => { log('companion health failed', e.message); return null; }) : null;
    if (!info.home) reason = 'DSH data folder not found. Run scripts/pick-dsh-home.js in the plugin folder.';
    else if (!companion) {
      try { await this.acp.start(); ok = true; } catch (e) { reason = e.message; }
    }
    const readable = !!info.home;
    const live = ok || !!companion;
    log('probe', { version:VERSION, home:info.home, home_source:info.source, tried:info.tried, companion:!!companion, acp:ok, reason });
    return { PluginID:'dsh', Available:readable, NativeVisibleInput:!!companion, NativeVisibleOutput:!!companion, CanAttachSession:true, CanStartSessionWithMessage:true, CanOpenDraft:true, CanListSessions:readable, CanReadHistory:readable, CanInterrupt:false, CanApproval:false, CanForwardSync:live, CanReverseSync:true, CanPluginWideWatch:true, CanWaitRun:live, CanReadStatus:false, CanControlSession:!!companion, IntegrationMode:'protocol-native', VisibilitySurface:companion ? 'dsh-companion' : 'dsh-acp', UnavailableReason:reason };
  }
  async discover() { const p = await this.probe(); return { PluginID:'dsh', Surface:'dsh-acp', Endpoint:'', ProcessID:this.acp.child?.pid || 0, SessionHints:{}, Verified:p.Available, Detail:p.UnavailableReason }; }
  native(id, cwd, visible=false) { return { PluginID:'dsh', NativeSessionID:id, NativeThreadID:id, Surface:visible ? 'dsh-companion' : 'dsh-acp', Endpoint:'', Cwd:String(cwd || '').replace(/\\/g, '/'), Visible:visible }; }
  async readDetail(session) {
    const id = session.NativeSessionID;
    if (!/^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid DSH session id');
    const live = await this.companionRequest(`/models/${encodeURIComponent(id)}`).catch(() => null);
    if (live?.current) {
      const options = live.models.map(item => ({
        option_id:modelOptionId(item.provider, item.model),
        key:modelOptionId(item.provider, item.model),
        value:modelOptionId(item.provider, item.model),
        label:`${item.label} · ${item.providerLabel}`,
        displayName:`${item.label} · ${item.providerLabel}`,
        target:{ option_id:modelOptionId(item.provider, item.model) },
        available:true,
        current:item.provider === live.current.provider && item.model === live.current.model,
      }));
      const current = options.find(item => item.current);
      return { native_conversation_id:id, conversation_id:id, updated_at:Date.now(),
        current_model:current, current_provider:live.current.provider,
        model_options:options, actions:[{ id:'model.switch', label:'切换模型', available:live.status === 'idle' }],
        detail_stale:false };
    }
    const root = resolveDshHome();
    const file = path.join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    const cache = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const row = cache.record?.rows?.modelSelection?.val;
    const selected = row?.next || row?.pending || row?.lastUsed;
    const model = typeof selected?.model === 'string' ? selected.model : '';
    const provider = typeof selected?.provider === 'string' ? selected.provider : '';
    const modelOption = model ? { option_id:model, label:model, available:true, current:true } : undefined;
    return { native_conversation_id:id, conversation_id:id, updated_at:Date.now(), current_model:modelOption, current_provider:provider || undefined,
      model_options:modelOption ? [modelOption] : [], detail_stale:false };
  }
  async controlSession(req) {
    const id = req.session?.NativeSessionID;
    const action = String(req.action || '').toLowerCase().replaceAll('_', '.');
    if (action === 'conversation.select') {
      const known = (await this.listSessions()).some(row => row.NativeSessionID === id);
      if (!known) throw Error('DSH session is not in the local session directory');
      return { ok:true, action:'conversation.select', thread_id:id,
        message:'DSH session selected in Prism.', details:await this.readDetail(req.session), details_confirmed:true };
    }
    if (['controls.describe', 'describe.controls'].includes(action)) {
      return { ok:true, action:req.action, thread_id:id, details:await this.readDetail(req.session), details_confirmed:true };
    }
    if (!['model.switch', 'composer.control.apply'].includes(action))
      return { ok:false, action:req.action, thread_id:id, message:'Unsupported DSH session control' };
    const target = req.target;
    const optionId = typeof target === 'string' ? target :
      target?.option_id || target?.key || target?.model_option_id || target?.entry_id || target?.value || target?.id;
    if (typeof optionId !== 'string') throw Error('A model option_id is required');
    const state = await this.companionRequest(`/models/${encodeURIComponent(id)}`);
    if (!state) throw Error('DSH desktop session is not active');
    const selected = state.models.find(item => modelOptionId(item.provider, item.model) === optionId);
    if (!selected) throw Error('Unknown DSH model option');
    await this.companionRequest('/model', { sessionId:id, provider:selected.provider, model:selected.model });
    const details = await this.readDetail(req.session);
    return { ok:true, action:req.action, thread_id:id, details, details_confirmed:true };
  }
  async runHistoryReader(args) {
    if (history.canDecodeInProcess()) {
      if (args[0] === '--list') return history.list(args[1]);
      const [file, id] = args;
      const st = await fs.promises.stat(file);
      const key = `${file}|${st.mtimeMs}|${st.size}`;
      this.historyCache ||= new Map();
      const hit = this.historyCache.get(id);
      if (hit?.key === key) return hit.rows;
      const rows = history.project(history.decode(file), id);
      this.historyCache.set(id, { key, rows });
      if (this.historyCache.size > 50) this.historyCache.delete(this.historyCache.keys().next().value);
      return rows;
    }
    const c = command(); const exe = (process.platform === 'win32' || process.platform === 'darwin') && !process.env.PRISM_DSH_COMMAND ? c.exe : process.env.PRISM_DSH_NODE;
    if (!exe || exe === 'dsh') throw Error('This Node has no Zstandard; set PRISM_DSH_NODE to Node 22.15+ for history');
    const { stdout } = await execFileAsync(exe, [path.join(__dirname, 'history-reader.js'), ...args], { env:{...process.env, ...c.env}, windowsHide:true, maxBuffer:64*1024*1024, timeout:30000 });
    return JSON.parse(stdout);
  }
  async readHistory(session, limit = 100) {
    const id = session.NativeSessionID;
    if (!/^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid DSH session id');
    const root = path.join(resolveDshHome(), 'sessions');
    const found = [];
    for (const dir of await fs.promises.readdir(root, { withFileTypes:true })) {
      if (!dir.isDirectory()) continue;
      const base = path.join(root, dir.name, id);
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const f = path.join(base, name); try { if ((await fs.promises.stat(f)).isFile()) found.push(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    if (found.length !== 1) { log('readHistory: files found', id, found.length); throw Error(found.length ? 'Multiple DSH history files found' : 'DSH v4 history not found'); }
    let rows;
    try { rows = await this.runHistoryReader([found[0], id]); }
    catch (error) { log('readHistory failed', found[0], error.message); throw error; }
    return rows.slice(-Math.max(1, Math.min(Number(limit) || 100, 500)));
  }
  async *readHistoryStream(session, request = {}, signal) {
    const streamId = request.stream_id || randomUUID();
    const seen = new Map();
    const suppressed = new Set();
    const id = session.NativeSessionID;
    const turn = (message, revision) => ({ turn_id:message.ID, order_key:message.CreatedAt + ':' + message.ID, revision, messages:[message] });
    for (const message of await this.readHistory(session, request.limit)) {
      seen.set(message.ID, { content:message.Content, revision:1 });
      yield { stream_id:streamId, type:'turn', source:'initial', operation:'append', turn:turn(message, 1) };
    }
    yield { stream_id:streamId, type:request.live ? 'page_end' : 'end', source:'initial', operation:'append' };
    if (!request.live) return;
    let lastHistoryAt = 0;
    while (!signal?.aborted) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 250);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        signal?.addEventListener('abort', onAbort, { once:true });
      });
      if (signal?.aborted) break;
      const run = this.runs.get(id);
      if (run?.mode === 'companion' && run.text) {
        const previewId = `prism-preview-${run.id}`;
        const previous = seen.get(previewId);
        const content = run.finalMessage?.Content || run.text;
        const status = run.running ? 'running' : 'completed';
        if (previous?.content !== content || previous?.status !== status) {
          const revision = (previous?.revision || 0) + 1;
          seen.set(previewId, { content, status, revision });
          const time = run.finalMessage?.CreatedAt || run.startedAt;
          const message = { ID:previewId, Role:'assistant', Type:'message', Content:content, Status:status, CreatedAt:time, UpdatedAt:new Date().toISOString() };
          yield { stream_id:streamId, type:'turn', source:'live', operation:previous ? 'replace' : 'append', turn:turn(message, revision) };
        }
        if (run.finalMessage?.ID) suppressed.add(run.finalMessage.ID);
      }
      if (Date.now() - lastHistoryAt < 1000) continue;
      lastHistoryAt = Date.now();
      for (const message of await this.readHistory(session, request.limit)) {
        if (run?.mode === 'companion' && seen.has(`prism-preview-${run.id}`) &&
            message.Role === 'assistant' && message.CreatedAt >= run.startedAt) {
          suppressed.add(message.ID);
        }
        if (suppressed.has(message.ID)) continue;
        const old = seen.get(message.ID);
        if (old?.content === message.Content) continue;
        const revision = (old?.revision || 0) + 1;
        seen.set(message.ID, { content:message.Content, revision });
        yield { stream_id:streamId, type:'turn', source:'live', operation:old ? 'replace' : 'append', turn:turn(message, revision) };
      }
    }
  }
  async listSessions() {
    const root = resolveDshHome();
    let rows;
    try { rows = await this.runHistoryReader(['--list', root]); }
    catch (error) { log('listSessions failed', root, error.message); throw error; }
    return rows.map(s => ({ ...this.native(s.id, s.cwd), Title:s.title || s.id, PrismConversationID:'', Active:false, LastActivityAt:s.updatedAt, Metadata:{} }));
  }
  async *subscribePlugin(signal) {
    const seen = new Map();
    while (!signal?.aborted) {
      const rows = await this.listSessions();
      const current = new Set(rows.map(row => row.NativeSessionID));
      let changed = false;
      for (const row of rows) {
        const key = `${row.Title}\u0000${row.LastActivityAt}`;
        if (seen.get(row.NativeSessionID) === key) continue;
        seen.set(row.NativeSessionID, key);
        changed = true;
        yield this.makeEvent('desktop.session.index.changed', 'idle', row.Title, {
          native_session:{ plugin_id:'dsh', native_session_id:row.NativeSessionID,
            native_thread_id:row.NativeThreadID, surface:row.Surface,
            cwd:row.Cwd, visible:false }, title:row.Title,
          session_hint:{ plugin_id:'dsh', native_session_id:row.NativeSessionID,
            native_thread_id:row.NativeThreadID, prism_conversation_id:'',
            surface:row.Surface, endpoint:row.Endpoint, cwd:row.Cwd,
            title:row.Title, last_activity_at:row.LastActivityAt, metadata:{} },
        });
      }
      for (const id of seen.keys()) {
        if (!current.has(id)) { seen.delete(id); changed = true; }
      }
      if (changed) yield this.makeEvent('desktop.session.directory.reconciled', 'completed', 'DSH session directory updated', { source:'dsh' });
      if (signal?.aborted) break;
      await new Promise(resolve => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 3000);
        signal?.addEventListener('abort', onAbort, { once:true });
      });
    }
  }
  async attachSession(req) {
    const id = req.NativeSessionID;
    if (!this.sessions.has(id)) {
      if (await this.companionSession(id)) this.sessions.set(id, { mode:'companion', cwd:req.Cwd });
    }
    if (!this.sessions.has(id)) {
      await this.acp.start();
      try { await this.acp.call('session/resume', { sessionId:id, cwd:req.Cwd, mcpServers:[] }); }
      catch (error) {
        if (error.message === 'Internal error') throw new Error('DSH ACP could not resume this session. A session open in DeepSeek Harness desktop may already own its writer; close that session there before retrying from Prism.');
        throw error;
      }
      this.sessions.set(id, { mode:'acp', cwd:req.Cwd });
    }
    const entry = this.sessions.get(id);
    return this.native(id, entry.cwd, entry.mode === 'companion');
  }
  async openDraft(req) {
    if (!req.DraftID || !path.isAbsolute(req.Cwd || '')) throw new Error('A draft ID and absolute working directory are required');
    this.drafts ||= new Map();
    const existing = this.drafts.get(req.DraftID);
    if (existing && path.resolve(existing.Cwd) !== path.resolve(req.Cwd)) throw new Error('Draft already belongs to another project');
    const draft = existing || { DraftID:req.DraftID, Cwd:req.Cwd, DraftFingerprint:randomUUID() };
    this.drafts.set(req.DraftID, draft);
    while (this.drafts.size > 100) this.drafts.delete(this.drafts.keys().next().value);
    return { ...draft, Controls:{ actions:[] } };
  }
  async controlDraft(req) {
    const draft = this.drafts?.get(req.DraftID);
    if (!draft) throw new Error('Draft expired or does not exist');
    if (req.Action || req.action) throw new Error('Draft controls are not supported');
    return { DraftID:draft.DraftID, Cwd:draft.Cwd, Controls:{ actions:[] } };
  }
  async startDraftWithMessage(req) {
    const draft = this.drafts?.get(req.DraftID);
    if (!draft) throw new Error('Draft expired or does not exist');
    if (draft.started) throw new Error('Draft was already submitted; do not resend');
    if (!req.Message?.Text?.trim() || req.Message.Attachments?.length) throw new Error('Only non-empty text is supported');
    draft.started = true;
    // Keep uncertain submissions blocked so a retry cannot create a second session.
    return this.startSessionWithMessage({ ...req, Cwd:draft.Cwd });
  }
  async startSessionWithMessage(req) {
    if (!path.isAbsolute(req.Cwd || '')) throw new Error('DSH requires an absolute working directory');
    if (!req.Message?.Text?.trim() || req.Message.Attachments?.length) throw new Error('Only non-empty text is supported');
    await this.acp.start();
    const result = await this.acp.call('session/new', { cwd:req.Cwd, mcpServers:[] }); this.sessions.set(result.sessionId, { mode:'acp', cwd:req.Cwd });
    const session = this.native(result.sessionId, req.Cwd); const receipt = await this.send(session, req.Message);
    return { Session:session, Receipt:receipt, Visibility:this.verifyVisibility(session, req.Message.Text) };
  }
  async send(session, msg) {
    if (!msg.Text?.trim() || msg.Attachments?.length) throw new Error('Only non-empty text is supported');
    const id = session.NativeSessionID; if (!this.sessions.has(id)) throw new Error('Session is not attached');
    if (this.runs.get(id)?.running) throw new Error('A DSH prompt is already running');
    if (this.sessions.get(id).mode === 'companion') return this.sendToCompanion(session, msg);
    const run = { id:msg.PrismMessageID || randomUUID(), running:true, text:'', event:null }; this.runs.set(id, run);
    run.promise = this.acp.call('session/prompt', { sessionId:id, prompt:[{ type:'text', text:msg.Text }] }).then(result => {
      const failed = result.stopReason === 'cancelled'; run.running = false;
      run.event = this.makeEvent(failed ? 'interrupted' : 'completed', failed ? 'interrupted' : 'completed', run.text, { stop_reason:result.stopReason, run_id:run.id }); this.publish(id, run.event); return run.event;
    }, err => { run.running = false; run.event = this.makeEvent('failed', 'failed', err.message, { run_id:run.id }); this.publish(id, run.event); return run.event; });
    return { NativeMessageID:run.id, Accepted:true, Visible:false, PendingConfirmation:true, Detail:'Prompt request sent to DSH ACP; admission and desktop visibility are not yet confirmed.' };
  }
  async sendToCompanion(session, msg) {
    const id = session.NativeSessionID;
    const runId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.PrismMessageID || '') ? msg.PrismMessageID : randomUUID();
    let accepted;
    try { accepted = await this.companionRequest('/send', { sessionId:id, messageId:runId, text:msg.Text }); }
    catch (error) { log('companion send failed', id, error.message); throw error; }
    log('sent via companion', id, runId);
    const run = { id:runId, mode:'companion', running:true, text:accepted.text || '', startedAt:accepted.startedAt || new Date().toISOString(), nativeMessageId:accepted.nativeMessageId, event:null };
    this.runs.set(id, run);
    run.promise = (async () => {
      try {
        let state = accepted;
        while (state.state === 'running') {
          await new Promise(resolve => setTimeout(resolve, 250));
          state = await this.companionRequest(`/run/${runId}`);
          if (typeof state.text === 'string' && state.text !== run.text) {
            const delta = state.text.startsWith(run.text) ? state.text.slice(run.text.length) : state.text;
            run.text = state.text;
            if (delta) this.publish(id, this.makeEvent('progress', 'running', delta, { run_id:runId }));
          }
        }
        if (state.state === 'failed') throw new Error(state.error || 'DSH run failed');
        const history = await this.readHistory(session, 500);
        const index = history.findIndex(item => item.ID === accepted.nativeMessageId);
        const replies = index < 0 ? [] : history.slice(index + 1).filter(item => item.Role === 'assistant');
        run.finalMessage = replies.at(-1);
        const summary = replies.map(item => item.Content).join('\n');
        if (summary) run.text = summary;
        run.event = this.makeEvent('completed', 'completed', summary, { run_id:runId, native_message_id:accepted.nativeMessageId });
      } catch (error) {
        run.event = this.makeEvent('failed', 'failed', error.message, { run_id:runId });
      }
      run.running = false;
      this.publish(id, run.event);
      return run.event;
    })();
    return { NativeMessageID:runId, Accepted:true, Visible:true, PendingConfirmation:false, Detail:'Message accepted by the live DeepSeek Harness desktop agent.' };
  }
  makeEvent(type, status, summary, payload={}) { return { ID:randomUUID(), Type:type, Status:status, Summary:summary || '', Payload:payload, CreatedAt:new Date().toISOString() }; }
  event(id, update) { if (!id) return; const run = this.runs.get(id); if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') { if (run) run.text += update.content.text; this.publish(id, this.makeEvent('progress', 'running', update.content.text)); } }
  publish(id, event) { for (const fn of this.listeners.get(id) || []) fn(event); }
  async *subscribe(session, signal) {
    const id = session.NativeSessionID, queue = []; let wake; const add = e => { queue.push(e); wake?.(); }; let set = this.listeners.get(id); if (!set) this.listeners.set(id, set = new Set()); set.add(add);
    const abort = () => wake?.(); signal?.addEventListener('abort', abort);
    try { while (!signal?.aborted) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; }); wake = null; } } finally { set.delete(add); signal?.removeEventListener('abort', abort); }
  }
  async waitForRun(session, runId) { const run = this.runs.get(session.NativeSessionID); if (!run || (runId && run.id !== runId)) throw new Error('Unknown DSH run'); return run.promise; }
  interrupt(session) { if (this.sessions.get(session.NativeSessionID)?.mode === 'companion') throw new Error('Interrupting a desktop-owned DSH session is not supported'); this.acp.notify('session/cancel', { sessionId:session.NativeSessionID }); }
  verifyVisibility(_session, marker) { return { Visible:false, Marker:marker, Evidence:'', CheckedAt:new Date().toISOString(), FailureReason:'ACP does not confirm desktop visibility' }; }
  close() { this.acp.close(); }
}
if (require.main === module) serve(new Adapter()).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { Acp, Adapter, command };
