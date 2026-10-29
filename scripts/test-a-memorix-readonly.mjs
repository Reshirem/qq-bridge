import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PYTHON = path.join(ROOT, 'state', 'a-memorix', 'venv', 'Scripts', 'python.exe');
const READER = path.join(ROOT, 'scripts', 'a-memorix-readonly-list.py');
if (!fs.existsSync(PYTHON)) {
  console.log('SKIP A_Memorix SQLite fixture: repository-local Python runtime is not installed');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memorix-readonly-audit-'));
const setup = String.raw`
import json, pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1])
state = root / 'memorix-state'
data = state / 'data'
(data / 'control').mkdir(parents=True)
(data / 'namespaces' / 'tenant-a' / 'metadata').mkdir(parents=True)
(state / 'config.toml').write_text('data_dir = "./data"\n', encoding='utf-8')
control = sqlite3.connect(data / 'control' / 'namespaces.db')
control.execute('CREATE TABLE namespaces (namespace_id TEXT PRIMARY KEY, storage_key TEXT NOT NULL)')
control.executemany('INSERT INTO namespaces VALUES (?, ?)', [('fixture-space', 'tenant-a'), ('bad-space', '../outside')])
control.commit(); control.close()
db = sqlite3.connect(data / 'namespaces' / 'tenant-a' / 'metadata' / 'metadata.db')
db.execute('''CREATE TABLE paragraphs (
  hash TEXT PRIMARY KEY, content TEXT, created_at REAL, updated_at REAL, metadata TEXT,
  source TEXT, event_time REAL, event_time_start REAL, event_time_end REAL,
  knowledge_type TEXT, is_deleted INTEGER
)''')
db.execute('''CREATE TABLE external_memory_refs (
  paragraph_hash TEXT, external_id TEXT, source_type TEXT
)''')
rows = [
  ('a', 'QQ 百分比 % 字符', 100, 300, {'origin':'qq','title':'最新'}, 'qq', 300, 'paragraph', 0),
  ('b', '助手记忆', 90, 200, {'origin':'assistant'}, 'assistant', 200, 'fact', 0),
  ('c', '较早 QQ 记忆', 80, 100, {'origin':'qq'}, 'qq', 100, 'paragraph', 0),
  ('d', '已删除记录', 70, 400, {'origin':'qq'}, 'qq', 400, 'paragraph', 1),
]
for h, content, created, updated, metadata, source, event_time, kind, deleted in rows:
  db.execute('INSERT INTO paragraphs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
    (h, content, created, updated, json.dumps(metadata, ensure_ascii=False), source, event_time, kind, deleted))
db.execute('INSERT INTO external_memory_refs VALUES (?, ?, ?)', ('a', 'external-a', 'qq'))
db.commit(); db.close()
`;

function runPython(args) {
  const result = spawnSync(PYTHON, ['-X', 'utf8', ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function read(request) {
  const result = runPython([READER, JSON.stringify(request)]);
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    value: result.status === 0 ? JSON.parse(String(result.stdout || '')) : null,
  };
}

function databaseDigests() {
  const root = path.join(temp, 'memorix-state', 'data');
  const files = [
    path.join(root, 'control', 'namespaces.db'),
    path.join(root, 'namespaces', 'tenant-a', 'metadata', 'metadata.db'),
  ];
  return files.map((file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
}

try {
  const built = runPython(['-c', setup, temp]);
  assert.equal(built.status, 0, built.stderr || 'failed to create local SQLite fixture');
  const stateDir = path.join(temp, 'memorix-state');
  const base = { stateDir, namespace: 'fixture-space', origin: 'qq', limit: 1 };
  const before = databaseDigests();

  const first = read(base);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.value.total, 2, 'deleted and assistant records must not count toward the QQ filter');
  assert.equal(first.value.hits.length, 1);
  assert.equal(first.value.hits[0].memoryId, 'a');
  assert.equal(first.value.hits[0].externalId, 'external-a');
  assert.equal(first.value.nextCursor.length > 0, true);

  const second = read({ ...base, cursor: first.value.nextCursor });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.value.hits.length, 1);
  assert.equal(second.value.hits[0].memoryId, 'c');
  assert.equal(second.value.nextCursor, '');

  const escapedWildcard = read({ stateDir, namespace: 'fixture-space', query: '%', limit: 10 });
  assert.equal(escapedWildcard.status, 0, escapedWildcard.stderr);
  assert.deepEqual(escapedWildcard.value.hits.map((hit) => hit.memoryId), ['a'], 'LIKE metacharacters must be escaped as literal text');

  const timeFilter = read({
    stateDir, namespace: 'fixture-space', timeStart: '1970-01-01T00:03:20Z', limit: 10,
  });
  assert.equal(timeFilter.status, 0, timeFilter.stderr);
  assert.deepEqual(timeFilter.value.hits.map((hit) => hit.memoryId), ['a', 'b']);
  assert.deepEqual(databaseDigests(), before, 'record browsing must not modify either SQLite database');

  const traversal = read({ stateDir, namespace: 'bad-space' });
  assert.notEqual(traversal.status, 0, 'namespace storage keys that escape the namespace directory must be rejected');
  assert.match(traversal.stderr, /存储路径无效/);
  console.log('PASS A_Memorix readonly reader paginates and filters fixture records without writes or path escape');
} finally {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('qq-memorix-readonly-audit-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
