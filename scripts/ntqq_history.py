"""Read committed messages directly from the logged-in Windows QQ account's live database."""
import argparse
from contextlib import closing, contextmanager
import json
from pathlib import Path
import re
import sys
import threading
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request

import sqlcipher3.dbapi2 as sqlcipher
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from google.protobuf.message import DecodeError
from ntqq_media import MediaCache, digest_hex
from ntqq_key import cached_key, key_header, key_identity, request_key, store_key


TABLES = {"group": "group_msg_table", "private": "c2c_msg_table"}
ROOT = Path(__file__).resolve().parents[1]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def local_action(config, action, params):
    base = config.get("httpUrl") or "http://127.0.0.1:3000"
    url = urlsplit(base)
    if url.scheme not in ("http", "https") or url.hostname not in ("127.0.0.1", "::1", "localhost"):
        raise ValueError("请配置本机 SnowLuma OneBot HTTP 地址")
    headers = {"Content-Type": "application/json"}
    if config.get("accessToken"):
        headers["Authorization"] = "Bearer " + config["accessToken"]
    request = Request(base.rstrip("/") + "/" + action, json.dumps(params).encode(), headers)
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=20) as response:
        result = json.load(response)
    if result.get("status") != "ok":
        raise ValueError(f"SnowLuma {action} 失败（retcode={result.get('retcode')}）")
    return result["data"]


def message_schema():
    schema = descriptor_pb2.FileDescriptorProto(name="ntqq_history.proto", syntax="proto2")
    content = schema.message_type.add(name="Content")
    content.field.add(name="kind", number=45002, type=5, label=1)  # int32
    content.field.add(name="text", number=45101, type=12, label=1)  # UTF-8 bytes
    for name, number, field_type in (
        ("at_type", 45102, 5), ("at_uin", 45103, 4), ("at_uid", 45105, 12),
        ("quote_uid", 40020, 12), ("quote_seq", 47402, 3), ("private_quote_seq", 47419, 3),
        ("subtype", 45003, 5), ("size", 45405, 3), ("md5", 45406, 12),
        ("face_id", 47601, 5), ("face_label", 47602, 12),
        ("package_id", 80810, 13), ("market_label", 80900, 12), ("emoji_id", 80903, 12),
    ):
        content.field.add(name=name, number=number, type=field_type, label=1)
    body = schema.message_type.add(name="Body")
    body.field.add(name="segments", number=40800, type=11, label=3, type_name=".Content")
    return message_factory.GetMessageClass(descriptor_pool.DescriptorPool().Add(schema).message_types_by_name["Body"])


MsgBody = message_schema()
SEGMENT_TYPES = {1: "text", 2: "image", 3: "file", 4: "voice", 5: "video", 6: "face",
                 7: "reply", 8: "notice", 9: "redPacket", 10: "card", 11: "marketFace",
                 14: "markdown", 16: "forward", 17: "button", 21: "call"}


def decode_segments(blob, cache=None):
    if not blob:
        return [{"type": "empty"}]
    try:
        segments = []
        for part in MsgBody.FromString(blob).segments:
            item = {"type": SEGMENT_TYPES.get(part.kind, "unknown")}
            if part.kind == 1 and part.HasField("text"):
                item["text"] = part.text.decode("utf-8")
            elif part.kind in (2, 5):
                if part.kind == 2 and part.HasField("subtype"):
                    item["subType"] = part.subtype
                    if part.subtype == 1:
                        item["type"] = "sticker"
                md5 = digest_hex(part.md5)
                if md5:
                    item["md5"] = md5
                if part.HasField("size"):
                    item["sizeBytes"] = part.size
            elif part.kind == 6:
                if part.HasField("face_id"):
                    item["faceId"] = str(part.face_id)
                if part.face_label:
                    item["label"] = part.face_label.decode("utf-8", errors="replace")
            elif part.kind == 11:
                ident = digest_hex(part.emoji_id)
                if ident:
                    item["emojiId"] = ident
                if part.HasField("package_id"):
                    item["packageId"] = str(part.package_id)
                if part.market_label:
                    item["label"] = part.market_label.decode("utf-8", errors="replace")
            if cache is not None and part.kind in (2, 5, 11):
                item["localFiles"] = cache.resolve(item)
            if item["type"] == "unknown":
                item["nativeType"] = part.kind
            segments.append(item)
        return segments or [{"type": "unsupported"}]
    except (DecodeError, UnicodeDecodeError):
        return [{"type": "undecodable"}]


_vfs_lock = threading.Lock()
_vfs_registered = False


def register_vfs():
    global _vfs_registered
    with _vfs_lock:
        if _vfs_registered:
            return
        dll = ROOT / "state/ntqq-reader/ntqq_vfs.dll"
        if not dll.is_file():
            raise RuntimeError("缺少 NTQQ 只读 VFS，请先运行 scripts/build_ntqq_vfs.py")
        with closing(sqlcipher.connect(":memory:")) as loader:
            loader.enable_load_extension(True)
            try:
                loader.load_extension(str(dll))
            finally:
                loader.enable_load_extension(False)
        _vfs_registered = True


def open_live(source, password):
    register_vfs()
    uri = source.as_uri() + "?mode=ro&readonly_shm=1&vfs=ntqq_readonly"
    db = sqlcipher.connect(uri, uri=True)
    try:
        db.execute("PRAGMA cipher_page_size=4096")
        db.execute("PRAGMA key='" + password.replace("'", "''") + "'")
        db.execute("PRAGMA kdf_iter=4000")
        db.execute("PRAGMA cipher_hmac_algorithm=HMAC_SHA1")
        db.execute("PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512")
        db.execute("PRAGMA temp_store=MEMORY")
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        if db.execute("PRAGMA journal_mode").fetchone() != ("wal",):
            raise ValueError("源库未处于支持的 WAL 模式")
        for table in TABLES.values():
            required = {"40001", "40030", "40033", "40050", "40800"}
            actual = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
            if not required <= actual:
                raise ValueError(f"不支持的 NTQQ 消息表结构：{table}")
        return db
    except BaseException:
        db.close()
        raise


@contextmanager
def verified_connection(source, account, folder, action):
    for suffix in ("-wal", "-shm"):
        if not Path(str(source) + suffix).is_file():
            raise ValueError("当前实现需要 QQ 在线打开消息库，并提供 WAL 和共享内存索引")
    header = key_header(source)
    identity = key_identity(account, header)
    password = cached_key(folder, identity)
    if password:
        try:
            db = open_live(source, password)
        except sqlcipher.DatabaseError as exc:
            if getattr(exc, "sqlite_errorcode", None) != sqlcipher.SQLITE_NOTADB:
                raise
        else:
            with closing(db):
                yield db, "cached"
            return
    password = request_key(action, folder, header)
    with closing(open_live(source, password)) as db:
        store_key(folder, identity, password)
        yield db, "fetched"


def history_rows(db, source, limit, before_id=None):
    match = re.fullmatch(r"(group|private):([1-9][0-9]{0,18})", source)
    if not match:
        raise ValueError("来源格式应为 group:群号 或 private:QQ号")
    table = TABLES[match[1]]
    peer = int(match[2])
    params = [peer]
    before = ""
    if before_id is not None:
        cursor = db.execute(f"SELECT [40050], [40001] FROM {table} WHERE [40030]=? AND [40001]=?",
                            (peer, before_id)).fetchone()
        if not cursor:
            raise ValueError("该来源中没有这个 NT 消息 ID")
        before = " AND ([40050], [40001]) < (?, ?)"
        params.extend(cursor)
    return db.execute(f"SELECT [40001], [40033], [40050], [40800] FROM {table} WHERE [40030]=?{before} "
                      f"ORDER BY [40050] DESC, [40001] DESC LIMIT ?", [*params, limit]).fetchall()


def decode_history(rows, cache=None):
    return [{"nativeId": str(key), "senderQQ": str(sender) if sender else None, "unixSeconds": stamp,
             "segments": decode_segments(body, cache)} for key, sender, stamp, body in rows]


def run(args):
    sys.path.insert(0, str(ROOT / "scripts/ntqq-probe"))
    from account import active_account, main_pid
    account = active_account(args.tencent_files, main_pid())
    if not account:
        raise ValueError("未能从桌面 QQ 定位登录账号和消息库")
    source = (args.tencent_files / account / "nt_qq" / "nt_db" / "nt_msg.db").resolve(strict=True)
    key_dir = ROOT / "state/ntqq-reader/keys"
    identity = key_identity(account, key_header(source))
    if args.import_key:
        from getpass import getpass
        key = getpass("输入当前账号的数据库密钥（不回显）: ")
        with closing(open_live(source, key)):
            store_key(key_dir, identity, key)
        return {"keyStatus": "imported"}
    key = cached_key(key_dir, identity)
    if not key:
        raise ValueError("请使用 --import-key 导入本账号的数据库密钥")
    with closing(open_live(source, key)) as db:
        key_status = "cached"

        info = {"readMode": "live-readonly", "keyStatus": key_status}
        if args.check:
            if db.execute("PRAGMA quick_check(1)").fetchone() != ("ok",):
                raise ValueError("原库未通过 SQLite 完整性检查")
            info["quickCheck"] = "ok"
        if not args.source:
            return {**info, "rows": {
                kind: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for kind, table in TABLES.items()
            }}
        rows = history_rows(db, args.source, args.limit, args.before_id)
    # Release QQ's WAL read transaction before walking or hashing media files.
    cache = MediaCache(source.parent.parent / "nt_data")
    return {**info, "source": args.source, "messages": decode_history(rows, cache)}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tencent-files", type=Path, default=Path.home() / "Documents" / "Tencent Files")
    parser.add_argument("--source", help="group:群号 或 private:QQ号；省略时仅输出统计")
    parser.add_argument("--before-id", type=int, help="读取比这个同来源 NT 消息 ID 更早的一页")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--import-key", action="store_true", help="验证并由 DPAPI 保存当前账号的数据库密钥")
    parser.add_argument("--check", action="store_true", help="额外运行全库 quick_check")
    args = parser.parse_args()
    if not 1 <= args.limit <= 100 or args.before_id is not None and not args.source:
        parser.error("--limit 须在 1 到 100 之间，--before-id 须与 --source 一起使用")
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError, OverflowError, sqlcipher.Error, KeyError) as exc:
        sys.exit("读取失败：" + str(exc))
