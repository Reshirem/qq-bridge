import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mcpEntry = fileURLToPath(new URL('../node_modules/@snowluma/mcp/dist/server.js', import.meta.url));

const gateway = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const ok = JSON.parse(raw).action === 'get_login_info' && req.headers.authorization === 'Bearer fixture-token';
  res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'failed', retcode: ok ? 0 : 1, data: ok ? { nickname: 'isolated-gateway' } : null }));
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntry],
  env: {
    SNOWLUMA_MCP_ENDPOINT: `http://127.0.0.1:${gateway.address().port}/`,
    SNOWLUMA_MCP_TOKEN: 'fixture-token',
    SNOWLUMA_MCP_MODE: 'write'
  }
});

const client = new Client({ name: 'bridge-test', version: '0.1.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['query_action', 'invoke_action']) assert.ok(tools.some(tool => tool.name === name), name);
  const result = await client.callTool({ name: 'query_action', arguments: { action: 'get_login_info' } });
  assert.notEqual(result.isError, true);
  const reply = JSON.parse(result.content[0].text);
  assert.equal(reply.status, 'ok');
  assert.deepEqual(reply.data, { nickname: 'isolated-gateway' });
  console.log('PASS upstream MCP write-mode tool list and read-only gateway call');
} finally {
  await client.close();
  await new Promise(resolve => gateway.close(resolve));
}
