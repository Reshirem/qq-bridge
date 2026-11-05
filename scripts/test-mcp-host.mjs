import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-host-server.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['snowluma_status'], 'host only exposes read-only status');
  if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
    const result = await client.callTool({ name: 'snowluma_status', arguments: {} });
    assert.notEqual(result.isError, true);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.reachable, true, 'configured gateway must be reachable in live mode');
    console.log('PASS configured SnowLuma gateway is reachable');
  } else console.log('PASS read-only host tool list; SKIP live gateway probe (QQ_BRIDGE_TEST_LIVE=1)');
} finally { await client.close(); }
