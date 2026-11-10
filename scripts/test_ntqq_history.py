"""Offline regression for reading committed, encrypted NTQQ history."""
from contextlib import closing
import base64
import hashlib
import mmap
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import ntqq_history as nt


def history(reader, source, limit, before_id=None):
    return nt.decode_history(nt.history_rows(reader, source, limit, before_id))


def body(*parts):
    msg = nt.MsgBody()
    for kind, text in parts:
        part = msg.segments.add(kind=kind)
        if text is not None:
            part.text = text.encode("utf-8")
    return msg.SerializeToString()


class NativeHistoryTest(unittest.TestCase):
    def test_media_segments_and_local_cache_roles(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
        digest = hashlib.md5(png).digest()
        video = bytes.fromhex("12" * 16)
        text = "再来一张"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def put(relative, data):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                return str(path.resolve())
            original = put(f"Emoji/emoji-recv/2026-11/Ori/{digest.hex()}.png", png)
            cover = put(f"Video/2026-11/Thumb/{video.hex()}_0.png", png)
            preview = put(f"Emoji/marketface/42/{digest.hex()}_aio.png", png)
            # A cached file with the expected name but the wrong bytes is not an original.
            put(f"Pic/2026-11/Ori/{video.hex()}.png", png)
            msg = nt.MsgBody()
            msg.segments.add(kind=1, text=text.encode())
            msg.segments.add(kind=2, subtype=1, md5=digest, size=len(png))
            msg.segments.add(kind=2, subtype=0, md5=video)
            msg.segments.add(kind=2, subtype=7)
            msg.segments.add(kind=5, md5=video)
            msg.segments.add(kind=6, face_id=0, face_label="/微笑".encode())
            msg.segments.add(kind=11, package_id=42, emoji_id=digest.hex().upper().encode())
            parts = nt.decode_segments(msg.SerializeToString(), nt.MediaCache(root))
            self.assertEqual([p["type"] for p in parts], ["text", "sticker", "image", "image", "video", "face", "marketFace"])
            self.assertEqual(parts[0]["text"], text)
            self.assertEqual(parts[1]["localFiles"], {"original": original})
            self.assertEqual(parts[1]["sizeBytes"], len(png))
            self.assertEqual(parts[2]["localFiles"], {})
            self.assertEqual(parts[3]["subType"], 7)
            self.assertEqual(parts[4]["localFiles"], {"cover": cover})
            self.assertEqual(parts[5], {"type": "face", "faceId": "0", "label": "/微笑"})
            self.assertEqual((parts[6]["packageId"], parts[6]["emojiId"]), ("42", digest.hex()))
            self.assertEqual(parts[6]["localFiles"], {"thumbnail": preview})

    def test_wal_only_messages_and_source_scoped_pagination(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            cipher = root / "writer.db"
            source = root / "nt_msg.db"
            with closing(nt.sqlcipher.connect(str(cipher), isolation_level=None)) as writer:
                for pragma in ("cipher_page_size=4096", "key='fixture'", "kdf_iter=4000",
                               "cipher_hmac_algorithm=HMAC_SHA1", "cipher_kdf_algorithm=PBKDF2_HMAC_SHA512",
                               "journal_mode=WAL", "wal_autocheckpoint=0"):
                    writer.execute("PRAGMA " + pragma)
                for table in nt.TABLES.values():
                    writer.execute(f"CREATE TABLE {table} ([40001] INTEGER PRIMARY KEY, "
                                   "[40030] INTEGER, [40033] INTEGER, [40050] INTEGER, [40800] BLOB)")
                writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                # Build a prefixed fixture. The hardlinks share the live writer's
                # WAL, SHM reader marks and Windows file locks until the test ends.
                header = bytearray(1024)
                header[:16] = b"SQLite header 3\0"
                header[47:175] = b"0" * 128
                with source.open("wb") as wrapped, cipher.open("rb") as encrypted:
                    wrapped.write(header)
                    shutil.copyfileobj(encrypted, wrapped)
                for suffix in ("-wal", "-shm"):
                    os.link(str(cipher) + suffix, str(source) + suffix)
                for key, peer in [(11, 123), (12, 123), (14, 456)]:
                    writer.execute("INSERT INTO group_msg_table VALUES (?, ?, 77, 100, ?)",
                                   (key, peer, body((1, "你好"), (2, None), (1, "👋"))))
                writer.execute("INSERT INTO c2c_msg_table VALUES (31, 123, 77, 100, ?)", (b"\xff",))
                writer.execute("BEGIN")
                writer.execute("INSERT INTO group_msg_table VALUES (15, 123, 77, 100, NULL)")
                def digest():
                    result = []
                    for suffix in ("", "-wal", "-shm"):
                        with Path(str(source) + suffix).open("rb") as stream:
                            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
                                result.append(hashlib.sha256(data).digest())
                    return result

                calls = []
                def fetch(action, params):
                    calls.append(action)
                    self.assertEqual(Path(params["db_path"]).read_bytes(), bytes(header[:175]))
                    return {"db_key": "fixture"}

                keys = root / "key-cache"
                before = digest()
                with nt.verified_connection(source, "123", keys, fetch) as (reader, status):
                    self.assertEqual(status, "fetched")
                    page = history(reader, "group:123", 1)
                    self.assertEqual(page[0]["segments"], [{"type": "text", "text": "你好"}, {"type": "image"},
                                                           {"type": "text", "text": "👋"}])
                    self.assertEqual(page[0]["nativeId"], "12")
                    self.assertEqual([r["nativeId"] for r in history(reader, "group:123", 3, 12)], ["11"])
                    self.assertEqual(history(reader, "private:123", 1)[0]["segments"], [{"type": "undecodable"}])
                    with self.assertRaises(ValueError):
                        history(reader, "group:123", 3, 14)
                    reader.execute("PRAGMA query_only=OFF")  # The VFS must also enforce read-only.
                    with self.assertRaises(nt.sqlcipher.Error):
                        reader.execute("DELETE FROM group_msg_table")
                    self.assertEqual(digest(), before)
                    writer.execute("COMMIT")
                    self.assertEqual(history(reader, "group:123", 1)[0]["nativeId"], "12")
                after_commit = digest()
                with nt.verified_connection(source, "123", keys, fetch) as (reader, status):
                    self.assertEqual(status, "cached")
                    self.assertEqual(history(reader, "group:123", 1)[0]["nativeId"], "15")
                self.assertEqual(digest(), after_commit)
                self.assertEqual(calls, ["request_decrypt_key"])
                with nt.verified_connection(source, "456", keys, fetch) as (_, status):
                    self.assertEqual(status, "fetched")
                marker = nt.key_identity("123", header)
                self.assertNotEqual(marker, nt.key_identity("123", header[:47] + b"1" * 128))
                nt.store_key(keys, marker, "obsolete-password")
                with nt.verified_connection(source, "123", keys, fetch) as (_, status):
                    self.assertEqual(status, "fetched")
                self.assertEqual(calls, ["request_decrypt_key"] * 3)
                self.assertEqual(nt.cached_key(keys, marker), "fixture")
                with self.assertRaises(nt.sqlcipher.Error):
                    nt.sqlcipher.connect(source.as_uri() + "?mode=rw&readonly_shm=1&vfs=ntqq_readonly", uri=True)
                missing = root / "missing.db"
                missing.write_bytes(header)
                with self.assertRaisesRegex(ValueError, "WAL"):
                    with nt.verified_connection(missing, "123", keys, fetch):
                        self.fail("missing source WAL must not be opened")
                self.assertEqual(calls, ["request_decrypt_key"] * 3)
                self.assertFalse(Path(str(missing) + "-wal").exists())


if __name__ == "__main__":
    unittest.main()
