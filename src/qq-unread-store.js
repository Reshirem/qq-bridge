import { DatabaseSync } from 'node:sqlite';

export const QQ_UNREAD_LIMIT = 500;

// The bridge keeps each active queue in memory. On disk, append new sequence
// numbers and delete acknowledged/evicted rows in the same transaction as its cursor.
export function openQQUnreadStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS buffer (id INTEGER PRIMARY KEY CHECK(id=1), uuid TEXT NOT NULL, paused INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (source TEXT PRIMARY KEY, metadata TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS unread (source TEXT, seq INTEGER, message TEXT NOT NULL, PRIMARY KEY(source, seq)) WITHOUT ROWID;`);
  const saveMeta = db.prepare('INSERT OR REPLACE INTO sources VALUES (?, ?)');
  const newest = db.prepare('SELECT max(seq) AS seq FROM unread WHERE source=?');
  const prune = db.prepare('DELETE FROM unread WHERE source=? AND seq < ?');
  const remove = db.prepare('DELETE FROM unread WHERE source=? AND seq=?');
  const append = db.prepare('INSERT INTO unread VALUES (?, ?, ?)');
  const header = db.prepare('INSERT OR REPLACE INTO buffer VALUES (1, ?, ?)');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { fn(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function writeSource(key, metadata, messages) {
    saveMeta.run(key, JSON.stringify(metadata));
    prune.run(key, messages[0]?.seq ?? Number.MAX_SAFE_INTEGER);
    const saved = newest.get(key).seq ?? 0;
    let first = messages.length;
    while (first && messages[first - 1].seq > saved) first--;
    for (let i = first; i < messages.length; i++) {
      append.run(key, messages[i].seq, JSON.stringify(messages[i]));
    }
  }
  return {
    load() {
      const row = db.prepare('SELECT uuid, paused FROM buffer WHERE id=1').get();
      if (!row) return null;
      const conversations = Object.create(null);
      for (const { source, metadata } of db.prepare('SELECT * FROM sources').iterate()) {
        conversations[source] = { ...JSON.parse(metadata), unread: [] };
      }
      for (const { source, message } of db.prepare('SELECT source,message FROM unread ORDER BY source,seq').iterate()) {
        conversations[source].unread.push(JSON.parse(message));
      }
      return { bufferId: row.uuid, paused: Boolean(row.paused), conversations };
    },
    save(key, metadata, messages) { transaction(() => writeSource(key, metadata, messages)); },
    acknowledge(key, metadata, sequences) {
      transaction(() => {
        for (const seq of sequences) remove.run(key, seq);
        saveMeta.run(key, JSON.stringify(metadata));
      });
    },
    replace(uuid, paused, sources) {
      transaction(() => {
        db.exec('DELETE FROM unread; DELETE FROM sources;');
        for (const [key, metadata, messages] of sources) writeSource(key, metadata, messages);
        header.run(uuid, Number(paused));
      });
    },
    close() { db.close(); },
  };
}
