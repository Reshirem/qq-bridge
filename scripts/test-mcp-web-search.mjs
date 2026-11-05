import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  const blocked = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /内网|本机|禁止/);
  console.log('PASS web_fetch rejects loopback URLs');

  if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
    const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
    assert.notEqual(search.isError, true);
    assert.ok(Array.isArray(JSON.parse(search.content[0].text).results));
    const fetched = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com/' } });
    assert.notEqual(fetched.isError, true);
    assert.match(fetched.content[0].text, /Example Domain/i);
    console.log('PASS live search and fetch');
  } else console.log('SKIP public network calls (QQ_BRIDGE_TEST_LIVE=1)');
} finally { await client.close(); }
