// Runs only in an isolated installed-DSH process with fake MCP servers.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as ManagedMcp from '../../plugins/qq-agent-presets/managed-mcp.mjs';

export const name = 'qq-managed-mcp-host-check';
export const inject = ['mcpManager'];

export async function apply(ctx) {
  const config = (serverName, toolCallTimeoutMs) => ({
    serverName, transport: 'stdio', command: process.env.QQ_FIXTURE_NODE,
    args: [fileURLToPath(new URL('./dsh-managed-mcp-server.mjs', import.meta.url)), process.env.QQ_FIXTURE_AUDIT, serverName],
    toolCallTimeoutMs,
  });
  const waitFor = async predicate => {
    for await (const list of ctx.mcpManager.watch(AbortSignal.timeout(12000))) {
      if (predicate(list)) return list;
    }
    throw new Error('Fixture manager status timed out');
  };
  const handles = [];
  try {
    handles.push(ctx.plugin(ManagedMcp, config('qq', 725000)));
    handles.push(ctx.plugin(ManagedMcp, config('qq-memory', 150000)));
    await Promise.all(handles.map(handle => handle.await()));
    const initial = await waitFor(list => list.length === 2 && list.every(row => row.status.state === 'connected'));
    assert.ok(initial.every(row => row.configured && row.status.toolCount === 1));
    const memoryBefore = initial.find(row => row.name === 'qq-memory').status.connectedAt;
    const probe = await ctx.mcpManager.probe('qq');
    assert.equal(probe.ok, true); assert.equal(probe.closeConfirmed, true);
    assert.deepEqual(probe.toolNames, ['fixture_status']);
    await ctx.mcpManager.restart('qq');
    const restarted = await waitFor(list => list.length === 2 && list.every(row => row.status.state === 'connected'));
    assert.equal(restarted.find(row => row.name === 'qq-memory').status.connectedAt, memoryBefore);
    await handles[0].dispose();
    await waitFor(list => !list.some(row => row.name === 'qq'));
    await handles[1].dispose();
    await waitFor(list => list.length === 0);
    process.stdout.write('QQ_MANAGED_MCP_HOST_CHECK_OK\n', () => process.exit(0));
    await new Promise(() => {}); // Never allow a model turn in this fixture.
  } catch (error) {
    await Promise.allSettled(handles.map(handle => handle.dispose()));
    process.stderr.write('QQ_MANAGED_MCP_HOST_CHECK_FAILED: ' + error.stack + '\n', () => process.exit(1));
    await new Promise(() => {});
  }
}
