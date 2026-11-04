'use strict';
// Opt-in integration check: sends one harmless prompt to an existing DSH desktop session.
const { Adapter } = require('../index');

async function main() {
  const id = process.argv[2];
  if (!/^session-[0-9a-f-]{36}$/i.test(id || '')) throw Error('Pass a DSH session ID');
  const adapter = new Adapter();
  const listed = (await adapter.listSessions()).find(row => row.NativeSessionID === id);
  if (!listed) throw Error('Session not listed');
  const session = await adapter.attachSession(listed);
  if (!session.Visible) throw Error('Desktop companion did not attach');
  const signal = new AbortController();
  const stream = adapter.readHistoryStream(session, { stream_id:'live-smoke', limit:10, live:true }, signal.signal)[Symbol.asyncIterator]();
  while ((await stream.next()).value?.type !== 'page_end') {}
  const previews = [];
  const watching = (async () => {
    for (;;) {
      const { value, done } = await stream.next();
      if (done) break;
      const message = value?.turn?.messages?.[0];
      if (!message?.ID?.startsWith('prism-preview-')) continue;
      previews.push({ length:message.Content.length, status:message.Status, operation:value.operation });
      if (message.Status === 'completed') break;
    }
  })();
  try {
    const receipt = await adapter.send(session, { Text:'流式显示测试：请只输出从 1 到 300 的数字，每行一个，不要调用工具。' });
    if (!receipt.Accepted) throw Error('Prompt not accepted');
    const event = await adapter.waitForRun(session, receipt.NativeMessageID);
    await Promise.race([watching, new Promise((_, reject) => setTimeout(() => reject(Error('stream timeout')), 10000))]);
    if (event.Status !== 'completed') throw Error(`Run ${event.Status}: ${event.Summary}`);
    const partial = previews.filter(row => row.status === 'running');
    console.log(JSON.stringify({ accepted:true, partialUpdates:partial.length, distinctPartialLengths:new Set(partial.map(row => row.length)).size, finalSeen:previews.some(row => row.status === 'completed'), finalLength:previews.at(-1)?.length || 0 }));
  } finally {
    signal.abort();
    adapter.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
