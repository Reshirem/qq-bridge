"""One account-scoped, read-only SQLCipher connection for the independent QQ transport."""
import json
import re
import sys
import time
from contextlib import closing
from pathlib import Path

from ntqq_history import ROOT, TABLES, MsgBody, decode_segments, open_live
from ntqq_key import cached_key, key_header, key_identity
from ntqq_media import MediaCache, resolve_media


def peer_column(table):
    if table == TABLES["group"]:
        return "COALESCE(NULLIF([40030],0),[40027])"
    return ("COALESCE(NULLIF([40030],0),"
            "(SELECT p.[40030] FROM c2c_msg_table p WHERE p.[40027]>0 AND p.[40027]=c2c_msg_table.[40027] AND p.[40030]>0 LIMIT 1),0)")


def format_row(db, table, peer, row, account, self_uid, resolve_reply=True, reply_cache=None):
    mid, sender, timestamp, blob, bucket = row
    decoded = decode_segments(blob)
    parts = [] if decoded[0]["type"] in ("empty", "undecodable") else MsgBody.FromString(blob).segments
    if reply_cache is None:
        reply_cache = {}
    segments = []
    for part, item in zip(parts, decoded):
        kind = item["type"]
        if kind == "text":
            if part.at_type:
                kind = "at"
                target = account if part.at_uid == self_uid else str(part.at_uin or "") or part.at_uid.decode(errors="replace")
                data = {"qq": "all" if part.at_type == 1 else target, "name": item.get("text", "").lstrip("@")}
            else:
                data = {"text": item.get("text", "")}
        elif kind == "reply":
            seq = part.quote_seq or part.private_quote_seq
            matched = None
            if seq:
                cache_key = (bucket, peer, seq)
                if cache_key in reply_cache:
                    matched = reply_cache[cache_key]
                else:
                    original = db.execute(
                        f"SELECT [40001],[40033],[40050],[40800],[40027] FROM {table} "
                        "WHERE [40027]=? AND [40003]=? AND [40030] IN (?,0) LIMIT 2",
                        (bucket, seq, peer)).fetchall()
                    if not original:
                        original = db.execute(
                            f"SELECT [40001],[40033],[40050],[40800],[40027] FROM {table} "
                            f"WHERE {peer_column(table)}=? AND [40003]=? LIMIT 2",
                            (peer, seq)).fetchall()
                    matched = original[0] if len(original) == 1 else None
                    reply_cache[cache_key] = matched
            data = {"id": str(matched[0]) if matched else None,
                    "nativeSelf": bool(self_uid and part.quote_uid == self_uid)}
            if matched and resolve_reply:
                data["source"] = format_row(db, table, peer, matched, account, self_uid, resolve_reply=False)
        elif kind in ("image", "sticker"):
            kind, data = "image", {"file": item.get("md5"), "sub_type": item.get("subType")}
        elif kind == "video":
            data = {
                **({"file": item["md5"]} if item.get("md5") else {}),
                **({"duration": item["durationSec"]} if item.get("durationSec") else {}),
                **({"size": item["sizeBytes"]} if item.get("sizeBytes") else {}),
                **({"width": item["width"]} if item.get("width") else {}),
                **({"height": item["height"]} if item.get("height") else {}),
            }
        elif kind == "face":
            data = {"id": item.get("faceId")}
        elif kind == "marketFace":
            kind, data = "mface", {"emoji_id": item.get("emojiId"), "emoji_package_id": item.get("packageId"),
                                   "summary": item.get("label", "")}
        elif kind == "card":
            data = {"data": item["data"]} if item.get("data") else {}
        elif kind == "forward":
            # Resolve through this source's original QQ message, not a guessed resource ID.
            data = {"id": "native:" + str(mid)}
        else:
            data = {}
        segments.append({"type": kind, "data": data})
    result = {"message_id": str(mid), "user_id": str(sender), "time": timestamp,
              "sender": {"user_id": str(sender)}, "message": segments}
    if table == TABLES["group"]:
        result["group_id"] = str(peer)
    return result


def read(db, action, params, account, self_uid):
    if action == "catchup":
        group = params["kind"] == "group"
        table = TABLES[params["kind"]]
        peer_expr = peer_column(table)
        cursor = params.get("cursor")
        extra = " AND ([40050],[40001]) > (?,?)" if cursor else ""
        args = [int(params["start"]), int(params["end"])]
        if cursor:
            args.extend(int(v) for v in cursor)
        rows = db.execute(f"SELECT [40001],[40033],[40050],[40800],[40027],{peer_expr} FROM {table} "
                          f"WHERE [40050] BETWEEN ? AND ? AND {peer_expr}>0"
                          + extra + " ORDER BY [40050],[40001] LIMIT 100", args).fetchall()
        events = []
        for mid, sender, stamp, blob, bucket, peer in rows:
            notice = any(part.get("type") == "notice" for part in decode_segments(blob))
            if (not sender or sender < 0 or str(sender) == account or (not group and peer != sender)) and not notice:
                continue
            item = format_row(db, table, peer, (mid,sender,stamp,blob,bucket), account, self_uid, resolve_reply=False)
            item.update(self_id=account, message_type=params["kind"], peer_id=str(peer), replay=True)
            events.append(item)
        return {"events": events, "next": [rows[-1][2],str(rows[-1][0])] if len(rows)==100 else None}
    if action == "uid":
        uin = int(params["uin"])
        for table, column, uin_col in (("c2c_msg_table", "40021", "40030"),
                                       ("group_msg_table", "40020", "40033"),
                                       ("c2c_msg_table", "40020", "40033")):
            row = db.execute(f"SELECT [{column}] FROM {table} WHERE [{uin_col}]=? AND substr([{column}],1,2)='u_' LIMIT 1",
                             (uin,)).fetchone()
            if row:
                return row[0]
        for query in ("SELECT [48902] FROM nt_uid_mapping_table WHERE [1002]=? AND substr([48902],1,2)='u_' LIMIT 1",
                      "SELECT [40021] FROM recent_contact_v3_table WHERE [40030]=? AND substr([40021],1,2)='u_' LIMIT 1"):
            try:
                row = db.execute(query, (uin,)).fetchone()
                if row:
                    return row[0]
            except Exception:
                pass
        return None
    if action in ("get_group_list", "get_friend_list"):
        group = action == "get_group_list"
        table = TABLES["group" if group else "private"]
        peer_expr = peer_column(table)
        return [{("group_id" if group else "user_id"): str(row[0])} for row in db.execute(
            f"SELECT DISTINCT {peer_expr} FROM {table} WHERE {peer_expr}>0")]
    if action == "group_invite_cards":
        days = max(1, min(30, int(params.get("days", 7))))
        limit = max(1, min(100, int(params.get("limit", 50))))
        scan_limit = max(limit * 10, 500)
        since = int(params["since"]) if params.get("since") is not None else int(time.time()) - days * 86400
        self_num = int(account) if re.fullmatch(r"[1-9]\d*", str(account)) else 0
        peer_expr = peer_column("c2c_msg_table")
        rows = db.execute(
            f"SELECT [40001],[40033],[40050],[40800],{peer_expr} FROM c2c_msg_table "
            "WHERE [40050]>=? AND [40033]>0 AND [40033]!=? AND [40800] IS NOT NULL "
            "ORDER BY [40050] DESC, [40001] DESC LIMIT ?",
            (since, self_num, scan_limit)).fetchall()
        cards = []
        for mid, sender, stamp, blob, peer in rows:
            for part in decode_segments(blob):
                data = part.get("data") or ""
                if part.get("type") == "card" and "mqqapi://group/invite_join" in data:
                    cards.append({
                        "message_id": str(mid),
                        "user_id": str(sender),
                        "peer_id": str(peer) if peer else str(sender),
                        "time": stamp,
                        "data": data,
                    })
                    break
            if len(cards) >= limit:
                break
        return cards
    if action != "history":
        raise ValueError("未知的 QQ 数据库查询")
    table = TABLES[params["kind"]]
    peer_expr = peer_column(table)
    peer = int(params["peer"])
    count = max(1, min(500, int(params["count"])))
    if count == 1 and params.get("anchor"):
        row = db.execute(f"SELECT [40001],[40033],[40050],[40800],[40027] FROM {table} WHERE [40001]=? AND {peer_expr}=?",
                         (int(params["anchor"]),peer)).fetchone()
        return [format_row(db, table, peer, row, account, self_uid, reply_cache={})] if row else []
    # Sort small metadata rows first. Read/decrypt bodies only on explicit QQ lookups.
    bind = [peer]
    clause = ""
    if params.get("anchor"):
        row = db.execute(f"SELECT [40050],[40001] FROM {table} WHERE {peer_expr}=? AND [40001]=?",
                         (peer, int(params["anchor"]))).fetchone()
        if not row:
            return []
        operator = "<=" if params["older"] else ">="
        clause = f" AND ([40050],[40001]) {operator} (?,?)"
        bind.extend(row)
    direction = "ASC" if clause and not params["older"] else "DESC"
    ids = [row[0] for row in db.execute(
        f"SELECT [40001] FROM {table} WHERE {peer_expr}=?{clause} ORDER BY [40050] {direction},[40001] {direction} LIMIT ?",
        [*bind, count])]
    rows = [db.execute(f"SELECT [40001],[40033],[40050],[40800],[40027] FROM {table} WHERE [40001]=? AND {peer_expr}=?",
                       (mid,peer)).fetchone() for mid in ids]
    reply_cache = {}
    return [format_row(db, table, peer, row, account, self_uid, reply_cache=reply_cache) for row in rows if row]


def main():
    account, pid, uid = sys.argv[1:4]
    if not re.fullmatch(r"[1-9]\d+", account):
        raise ValueError("QQ 登录账号无效")
    sys.path.insert(0, str(ROOT / "scripts/ntqq-probe"))
    from account import users_of
    base = Path.home() / "Documents" / "Tencent Files" / account / "nt_qq"
    source = base / "nt_db" / "nt_msg.db"
    if int(pid) not in users_of(source):
        raise ValueError("当前 QQ 进程未打开该账号的消息库")
    secret = cached_key(ROOT / "state/ntqq-reader/keys", key_identity(account, key_header(source)))
    if not secret:
        raise ValueError("本机没有当前账号的已验证数据库密钥")
    with closing(open_live(source, secret)) as db:
        db.execute("COMMIT")
        print(json.dumps({"ready": True}), flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            try:
                if request["action"] == "media":
                    result = resolve_media(MediaCache(base / "nt_data"), request["params"])
                else:
                    db.execute("BEGIN")
                    try:
                        result = read(db, request["action"], request["params"], account, uid.encode())
                    finally:
                        db.execute("COMMIT")
                reply = {"id": request["id"], "data": result}
            except Exception as exc:
                reply = {"id": request["id"], "error": str(exc)}
            print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
