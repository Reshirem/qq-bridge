// Protocol regression: synthetic frames exercise MaaMCP, FastMCP and the JS MCP client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.QQ_MAAMCP_TEST_PYTHON;
assert.ok(python && path.isAbsolute(python) && fs.existsSync(python),
  'Set QQ_MAAMCP_TEST_PYTHON to a Python executable with MaaMCP installed (or on PYTHONPATH).');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maamcp-test-'));
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/KEY|PASSWORD|SECRET|TOKEN|^DSH_/i.test(name)));
Object.assign(env, { QQ_MAAMCP_DATA_DIR: path.join(temporary, 'data'), PYTHONDONTWRITEBYTECODE: '1' });
const transport = new StdioClientTransport({
  command: python, args: [path.join(root, 'scripts', 'fixtures', 'maa-mcp-stdio.py')],
  cwd: root, env, stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (data) => { stderr = (stderr + data).slice(-6000); });
const client = new Client({ name: 'qq-maamcp-test', version: '1.0.0' });
const call = (args) => client.callTool({ name: 'screencap', arguments: args }, undefined, { timeout: 15000 });
const text = (result) => result.content.find((block) => block.type === 'text')?.text;
const image = (result) => result.content.find((block) => block.type === 'image');

try {
  await client.connect(transport, { timeout: 25000 });
  const instructions = client.getInstructions();
  assert.equal(typeof instructions, 'string');
  assert.ok(Buffer.byteLength(`### MCP server: maa\n\n${instructions}`) <= 32768, 'instructions fit the DSH default limit');
  assert.doesNotMatch(instructions, /read_file|start_pipeline\(|get_pipeline_status\(|get_new_messages\(/,
    'instructions only refer to the standard entry and inline screenshots');
  assert.match(instructions, /主动考虑/);
  assert.match(instructions, /可复用工具服务/);
  assert.match(instructions, /会注销该控制器/);
  assert.match(instructions, /网络设备无需先出现在设备列表/);
  const { tools } = await client.listTools();
  for (const name of ['screencap', 'ocr', 'click', 'save_captured_image', 'run_pipeline', 'stop_pipeline']) {
    assert.ok(tools.some((tool) => tool.name === name), `${name} remains available`);
  }
  assert.equal(tools.some((tool) => tool.name === 'start_pipeline'), false, 'standard entry has no continuous monitor');
  const captureTool = tools.find((tool) => tool.name === 'screencap');
  assert.equal(captureTool.inputSchema.properties.include_metadata.default, true);
  assert.doesNotMatch(captureTool.description, /Read 源图|Read 裁剪结果/);

  const connectAdbTool = tools.find((tool) => tool.name === 'connect_adb_device');
  assert.match(connectAdbTool.description, /IP:端口/);
  const adbCall = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
  const discovered = await adbCall('find_adb_device_list');
  assert.deepEqual(JSON.parse(text(discovered)), ['fixture-usb']);
  const legacyAdb = await adbCall('connect_adb_device', { device_name: 'fixture-usb', target_short_side: null });
  assert.ok(!legacyAdb.isError, text(legacyAdb));
  const networkAdb = await adbCall('connect_adb_device', { device_name: '192.0.2.17:5555', target_short_side: 1080 });
  assert.ok(!networkAdb.isError, text(networkAdb));
  const ipv6Adb = await adbCall('connect_adb_device', { device_name: '[2001:db8::17]:5555' });
  assert.ok(!ipv6Adb.isError, text(ipv6Adb));
  const adbLog = path.join(temporary, 'data', 'adb-calls.jsonl');
  const adbRequests = fs.readFileSync(adbLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(adbRequests.map(request => request.address), ['fixture-serial', '192.0.2.17:5555', '[2001:db8::17]:5555']);
  assert.equal(adbRequests[0].raw_size, true);
  assert.equal(adbRequests[1].short_side, 1080);
  assert.equal(adbRequests[2].short_side, 720);
  for (const device_name of ['missing-device', '192.0.2.17:0', '192.0.2.17:65536', '192.0.2.17:5555 & whoami', '192.0.2.17:5555\n', '2001:db8::17:5555']) {
    const invalid = await adbCall('connect_adb_device', { device_name });
    assert.equal(invalid.isError, true, `${device_name} must fail before connecting`);
  }
  assert.equal(fs.readFileSync(adbLog, 'utf8').trim().split('\n').length, 3);
  const failedAdb = await adbCall('connect_adb_device', { device_name: '192.0.2.254:5555' });
  assert.equal(failedAdb.isError, true);
  assert.match(text(failedAdb), /ADB 连接失败/);
  fs.unlinkSync(path.join(temporary, 'data', 'fixture-adb.exe'));
  const missingExecutable = await adbCall('connect_adb_device', { device_name: '192.0.2.18:5555' });
  assert.equal(missingExecutable.isError, true);
  assert.match(text(missingExecutable), /必须指向已安装 adb/);

  const full = await call({ controller_id: 'frame' });
  assert.ok(!full.isError, text(full));
  const fullMetadata = JSON.parse(text(full));
  assert.deepEqual(fullMetadata.coordinate_size, [1920, 1080]);
  assert.deepEqual(fullMetadata.image_size, [1920, 1080]);
  assert.equal(image(full).mimeType, 'image/png');
  const png = Buffer.from(image(full).data, 'base64');
  assert.equal(png.readUInt32BE(16), 1920);
  assert.equal(png.readUInt32BE(20), 1080);
  assert.equal(fs.realpathSync(path.dirname(fullMetadata.path)), fs.realpathSync(path.join(temporary, 'data', 'screenshots')));

  const crop = await call({ controller_id: 'frame', region: [300, 150, 600, 300], resolution: 540 });
  assert.ok(!crop.isError, text(crop));
  const metadata = JSON.parse(text(crop));
  assert.deepEqual(metadata.coordinate_size, [1920, 1080]);
  assert.deepEqual(metadata.image_size, [300, 150]);
  assert.deepEqual(metadata.image_to_controller, { scale: [2, 2], offset: [300, 150] });
  const croppedPng = Buffer.from(image(crop).data, 'base64');
  assert.equal(croppedPng.readUInt32BE(16), 300);
  assert.equal(croppedPng.readUInt32BE(20), 150);

  const legacy = await call({ controller_id: 'frame', include_metadata: false });
  assert.ok(!legacy.isError, text(legacy));
  assert.ok(text(legacy).endsWith('.png'));
  assert.ok(image(legacy), 'legacy path result also contains a native image block');

  const noisy = await call({ controller_id: 'noise' });
  assert.ok(!noisy.isError, text(noisy));
  assert.equal(image(noisy).mimeType, 'image/jpeg');
  assert.deepEqual(JSON.parse(text(noisy)).image_size, [1600, 900]);
  const original = fs.readFileSync(JSON.parse(text(noisy)).path);
  assert.ok(original.length > 1024 * 1024, 'large PNG remains available for template saving');
  assert.equal(original.readUInt32BE(16), 1600);
  assert.equal(original.readUInt32BE(20), 900);

  const missing = await call({ controller_id: 'missing' });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /截图失败/);
  const escaped = await call({ controller_id: 'outside' });
  assert.equal(escaped.isError, true);
  assert.match(text(escaped), /截图路径不在/);
  assert.equal(image(escaped), undefined);
  console.log(`PASS MaaMCP: ${tools.length} tools; inline images/coordinates, legacy and network ADB, explicit failures`);
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
