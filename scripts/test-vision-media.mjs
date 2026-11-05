// Optional operator check of an unread QQ image on the running bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

test('media downloads reject loopback URLs', async () => {
  await assert.rejects(safeFetchBuffer('http://127.0.0.1/'), /内网|本机|禁止/);
});

test('running bridge resolves unread image metadata', {
  skip: process.env.QQ_BRIDGE_TEST_LIVE !== '1' && 'set QQ_BRIDGE_TEST_LIVE=1 to check the running bridge',
}, async t => {
  const root = new URL('../', import.meta.url);
  const read = name => fs.readFileSync(new URL(name, root), 'utf8').replace(/^\uFEFF/, '');
  const config = JSON.parse(read('config.json'));
  const consoleToken = config.consoleToken || read('state/console-token').trim();
  const { agentToken } = JSON.parse(read('state/desktop-agent.json'));
  assert.ok(agentToken && consoleToken, 'live probe requires initialized bridge credentials');
  const db = new DatabaseSync(fileURLToPath(new URL('state/qq-unread.sqlite', root)), { readOnly: true });
  let row;
  try {
    row = db.prepare(`SELECT source, json_extract(message, '$.messageId') AS id
      FROM unread WHERE json_extract(message, '$.hasMedia') = 1 AND id IS NOT NULL
      ORDER BY seq DESC LIMIT 1`).get();
  } finally { db.close(); }
  if (!row) return t.skip('no unread image with a QQ message ID');
  const url = new URL('/api/images/message', 'http://127.0.0.1:' + (config.consolePort || 3100));
  url.search = new URLSearchParams({ key: row.source, messageId: 'id:' + row.id });
  const response = await fetch(url, {
    headers: { 'x-agent-call': '1', 'x-agent-token': agentToken, 'x-console-token': consoleToken },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.ok && result.media?.length > 0, 'expected image metadata for the selected QQ message');
});
