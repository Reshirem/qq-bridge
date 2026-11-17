import { DatabaseSync } from 'node:sqlite';

// Only attention references, acknowledgements and the last covered interval live
// here. The schema deliberately has no column for chat bodies or attachments.
export function openNativeReminders(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS positions (source TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reminders (source TEXT, id TEXT, seq INTEGER NOT NULL, reason TEXT NOT NULL,
      time INTEGER NOT NULL, sender TEXT NOT NULL, stage INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(source,id), UNIQUE(source,seq));`);
  const setting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const set = (key,value) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,String(value));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return {
    load() {
      if (!setting('uuid')) return null;
      const conversations = Object.fromEntries(db.prepare('SELECT * FROM positions').all().map(r =>
        [r.source,{ lastUnreadSeq:r.seq, unread:[] }]));
      for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'meta:%'").all()) {
        const source = r.key.slice(5);
        try {
          const meta = JSON.parse(r.value);
          conversations[source] = { ...(conversations[source] || { lastUnreadSeq: 0, unread: [] }), ...meta, unread: conversations[source]?.unread || [] };
        } catch {}
      }
      for (const r of db.prepare('SELECT * FROM reminders WHERE stage < 3 ORDER BY source,seq').iterate()) {
        if (!conversations[r.source]) conversations[r.source] = { lastUnreadSeq: r.seq, unread: [] };
        conversations[r.source].unread.push({messageId:r.id,seq:r.seq,reason:r.reason,time:r.time,userId:r.sender,stage:r.stage});
      }
      return { bufferId:setting('uuid'), conversations };
    },
    save(key, metadata) {
      if (metadata && typeof metadata === 'object') set('meta:' + key, JSON.stringify(metadata));
    },
    seen(key,id) { return !!db.prepare('SELECT 1 FROM reminders WHERE source=? AND id=?').get(key,String(id)); },
    add(key, ref) {
      transaction(() => {
        db.prepare('INSERT INTO reminders(source,id,seq,reason,time,sender) VALUES(?,?,?,?,?,?)')
          .run(key,ref.messageId,ref.seq,ref.reason,ref.time,ref.userId);
        db.prepare('INSERT OR REPLACE INTO positions VALUES (?,?)').run(key,ref.seq);
      });
    },
    get coverage() { return Number(setting('coverage')) || 0; },
    cover(time) {
      set('coverage',time);
      db.prepare('DELETE FROM reminders WHERE stage=3 AND time < ?').run(time - 120000);
    },
    delivered(key, seq, followup) {
      db.prepare('UPDATE reminders SET stage=max(stage,?) WHERE source=? AND seq<=? AND stage<3')
        .run(followup ? 2 : 1,key,seq);
    },
    acknowledge(key, metadata, seqs) {
      transaction(() => {
        for (const seq of seqs) db.prepare('UPDATE reminders SET stage=3 WHERE source=? AND seq=?').run(key,seq);
        if (metadata && typeof metadata === 'object' && Object.keys(metadata).length) set('meta:' + key, JSON.stringify(metadata));
      });
    },
    replace(uuid) {
      transaction(() => {
        db.exec("DELETE FROM reminders; DELETE FROM positions; DELETE FROM settings WHERE key LIKE 'meta:%'");
        set('uuid',uuid);
        set('coverage',Date.now());
      });
    },
    close() { db.close(); },
  };
}
