import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const name = 'prism-companion';
export const inject = ['agents', 'llm'];

const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024;

function reply(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'content-length':Buffer.byteLength(data) });
  res.end(data);
}

async function body(req) {
  let bytes = 0, chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req, token) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createHandler(ctx, token) {
  const runs = new Map();
  async function storedSelection(sessionId) {
    const root = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(root, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    try {
      const cache = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const row = cache.record?.rows?.modelSelection?.val;
      const selected = row?.next || row?.pending || row?.lastUsed;
      return typeof selected?.provider === 'string' && typeof selected?.model === 'string' ?
        { provider:selected.provider, model:selected.model } : undefined;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async function modelState(agent, sessionId) {
    const current = agent?.model?.current?.() ||
      agent?.session.snapshotEvents().findLast(event => event.type === 'model/selection')?.data ||
      (agent?.options?.provider && agent?.options?.model
        ? { provider:agent.options.provider, model:agent.options.model }
        : undefined) || await storedSelection(sessionId);
    const providers = ctx.llm.listProviders();
    const groups = await Promise.all(providers.map(async provider => {
      try {
        return (await ctx.llm.listModels(provider.id)).map(model => ({
          provider:provider.id, model:model.id, label:model.name || model.id,
          providerLabel:provider.name || provider.id,
        }));
      } catch { return []; }
    }));
    const models = groups.flat().filter(item => typeof item.model === 'string' && item.model);
    if (current && !models.some(item => item.provider === current.provider && item.model === current.model)) {
      models.unshift({ provider:current.provider, model:current.model, label:current.model, providerLabel:current.provider });
    }
    return { current, models:models.slice(0, 500), status:agent?.status || 'idle', active:!!agent };
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return;
    for (const run of runs.values()) {
      if (run.sessionId !== agent.session.id || run.state !== 'running') continue;
      run.text = (run.text || '') + frame.chunk.text;
      run.revision = (run.revision || 0) + 1;
    }
  });
  return async (req, res) => {
    if (!authorized(req, token)) return reply(res, 401, { error:'unauthorized' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok:true, pid:process.pid });
    const session = /^\/session\/(session-[0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && session && SESSION_ID.test(session[1])) {
      const agent = ctx.agents.get(session[1]);
      return reply(res, agent ? 200 : 404, agent ? { active:true, status:agent.status } : { active:false });
    }
    const modelPath = /^\/models\/(session-[0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && modelPath && SESSION_ID.test(modelPath[1])) {
      const agent = ctx.agents.get(modelPath[1]);
      const state = await modelState(agent, modelPath[1]);
      return reply(res, state.current ? 200 : 404, state.current ? state : { error:'session_not_found' });
    }
    const runPath = /^\/run\/([0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && runPath && RUN_ID.test(runPath[1])) {
      const run = runs.get(runPath[1]);
      return reply(res, run ? 200 : 404, run || { error:'unknown_run' });
    }
    if (req.method !== 'POST' || !['/send', '/model'].includes(url.pathname)) return reply(res, 404, { error:'not_found' });
    let input;
    try { input = await body(req); } catch { return reply(res, 400, { error:'invalid_body' }); }
    if (url.pathname === '/model') {
      const { sessionId, provider, model } = input || {};
      if (!SESSION_ID.test(sessionId) || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model)
        return reply(res, 400, { error:'invalid_model' });
      let agent = ctx.agents.get(sessionId);
      const state = await modelState(agent, sessionId);
      if (!state.current) return reply(res, 404, { error:'session_not_found' });
      if (agent && agent.status !== 'idle') return reply(res, 409, { error:'session_busy' });
      if (!state.models.some(item => item.provider === provider && item.model === model))
        return reply(res, 400, { error:'model_not_advertised' });
      if (state.current?.provider === provider && state.current?.model === model)
        return reply(res, 200, state);
      try { await ctx.llm.resolveModelInfo(provider, model); }
      catch { return reply(res, 400, { error:'model_unavailable' }); }
      let handle;
      try {
        if (!agent) {
          handle = await ctx.agents.resume({ resumeSessionId:sessionId });
          agent = handle.agent;
        }
        if (agent.status !== 'idle') return reply(res, 409, { error:'session_busy' });
        if (agent.model?.select) agent.model.select({ provider, model });
        else agent.session.append('model/selection', { provider, model });
        return reply(res, 200, await modelState(agent, sessionId));
      } finally {
        if (handle) {
          await handle.dispose();
          // DSH emits api-session/removed when a temporary Agent releases its
          // Session. Restore the persisted row for desktop clients immediately.
          try {
            const controller = ctx.get?.('sessionController');
            if (controller?.list) {
              const summary = (await controller.list({}, AbortSignal.timeout(3000))).items
                .find(item => item.sessionId === sessionId);
              if (summary) ctx.emit('api-session/added', summary);
            }
          } catch (error) {
            ctx.logger?.warn?.(`prism-companion: could not refresh desktop session list: ${String(error)}`);
          }
        }
      }
    }
    const { sessionId, messageId, text } = input || {};
    if (!SESSION_ID.test(sessionId) || !RUN_ID.test(messageId) || typeof text !== 'string' || !text.trim() || text.length > 32000)
      return reply(res, 400, { error:'invalid_message' });
    const known = runs.get(messageId);
    if (known) return reply(res, known.sessionId === sessionId ? 200 : 409, known.sessionId === sessionId ? known : { error:'message_id_conflict' });
    const agent = ctx.agents.get(sessionId);
    if (!agent) return reply(res, 404, { error:'session_not_active' });
    if (agent.status !== 'idle') return reply(res, 409, { error:'session_busy' });
    const message = Object.freeze({
      id:randomUUID(), role:'user', source:Object.freeze({ kind:'user' }),
      content:Object.freeze([Object.freeze({ type:'text', text })]),
    });
    const run = { sessionId, messageId, state:'running', nativeMessageId:message.id, text:'', revision:0, startedAt:new Date().toISOString() };
    runs.set(messageId, run);
    try {
      agent.followup(message);
      void agent.whenIdle().then(() => { run.state = 'completed'; }, error => { run.state = 'failed'; run.error = String(error?.message || error); });
    } catch (error) {
      runs.delete(messageId);
      return reply(res, 500, { error:String(error?.message || error) });
    }
    if (runs.size > 1000) for (const [id, row] of runs) { if (row.state !== 'running') { runs.delete(id); if (runs.size <= 800) break; } }
    return reply(res, 202, run);
  };
}

export async function apply(ctx) {
  const root = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const descriptor = path.join(root, 'prism-companion.json');
  const token = randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => {
    void createRequest(req, res);
  });
  const handler = createHandler(ctx, token);
  async function createRequest(req, res) {
    try { await handler(req, res); }
    catch (error) { if (!res.headersSent) reply(res, 500, { error:'internal_error', detail:String(error?.message || error) }); else res.destroy(); }
  }
  await ctx.effect(async () => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const generation = randomUUID();
    const record = { version:1, pid:process.pid, port:server.address().port, token, generation };
    const tmp = `${descriptor}.${generation}.tmp`;
    try {
      await fs.promises.mkdir(root, { recursive:true });
      await fs.promises.writeFile(tmp, JSON.stringify(record), { mode:0o600, flag:'wx' });
      await fs.promises.rename(tmp, descriptor);
    } catch (error) {
      server.close();
      await fs.promises.rm(tmp, { force:true }).catch(() => {});
      throw error;
    }
    return async () => {
      await new Promise(resolve => server.close(resolve));
      try {
        const current = JSON.parse(await fs.promises.readFile(descriptor, 'utf8'));
        if (current.generation === generation) await fs.promises.rm(descriptor);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  });
}
