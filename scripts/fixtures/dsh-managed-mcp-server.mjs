// No network, bridge, QQ or model access. Used only by test-managed-mcp-dsh.mjs.
import fs from 'node:fs';
import readline from 'node:readline';
const [auditFile, server, toolName = 'fixture_status'] = process.argv.slice(2);
const audit = event => fs.appendFileSync(auditFile, JSON.stringify({ server, pid: process.pid, event }) + '\n');
audit('start');
process.on('exit', () => audit('exit'));
const input = readline.createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  audit(request.method);
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: toolName, description: 'Fixture only; must not be called', inputSchema: { type: 'object', properties: {} } }] };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'server/discover') {
    // The current host first checks the newer MCP discovery protocol, then
    // falls back to this intentionally legacy JSON-RPC fixture.
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
    return;
  } else throw new Error('Unexpected fixture MCP method: ' + request.method);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
