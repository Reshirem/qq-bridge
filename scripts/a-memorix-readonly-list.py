#!/usr/bin/env python3
"""Read-only, paginated view of active A_Memorix paragraph records."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
import sqlite3
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


NAMESPACE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
REQUIRED_COLUMNS = {
    "hash",
    "content",
    "created_at",
    "updated_at",
    "metadata",
    "source",
    "event_time",
    "event_time_start",
    "event_time_end",
    "knowledge_type",
    "is_deleted",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(2)


def epoch(value: Any, label: str) -> float | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > 80:
        fail(f"{label} 时间格式无效")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except (OverflowError, OSError, ValueError):
        fail(f"{label} 时间格式无效")
    try:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        fail(f"{label} 时间格式无效")


def optional_metadata_epoch(value: Any) -> float | None:
    if not isinstance(value, str) or not value or len(value) > 80:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    try:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None


def iso_time(value: Any) -> str | None:
    if value in (None, ""):
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def open_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA query_only=ON")
    return connection


def decode_cursor(token: str, fingerprint: str) -> tuple[float, str] | None:
    if not token:
        return None
    if len(token) > 1024:
        fail("分页游标无效，请重新加载")
    try:
        padded = token + "=" * (-len(token) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        sort_time = float(payload["t"])
        memory_id = str(payload["h"])
        if not math.isfinite(sort_time) or not memory_id or len(memory_id) > 256 or payload.get("f") != fingerprint:
            raise ValueError("invalid cursor")
        return sort_time, memory_id
    except (binascii.Error, ValueError, TypeError, KeyError, UnicodeError, json.JSONDecodeError):
        fail("分页条件已变化或游标无效，请重新加载")
    return None


def encode_cursor(sort_time: float, memory_id: str, fingerprint: str) -> str:
    payload = json.dumps({"t": sort_time, "h": memory_id, "f": fingerprint}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def main() -> None:
    if len(sys.argv) != 2:
        fail("只读账本读取参数无效")
    try:
        request = json.loads(sys.argv[1])
    except (json.JSONDecodeError, TypeError):
        fail("只读账本读取参数无效")
    if not isinstance(request, dict):
        fail("只读账本读取参数无效")

    namespace = str(request.get("namespace") or "")
    if not NAMESPACE_RE.fullmatch(namespace):
        fail("长期记忆 namespace 无效")
    query = str(request.get("query") or "").strip()
    origin = str(request.get("origin") or "all").strip().lower()
    if len(query) > 2000:
        fail("关键词不能超过 2000 个字符")
    if origin not in {"all", "qq", "assistant"}:
        fail("来源筛选值无效")
    try:
        limit = max(1, min(100, int(request.get("limit", 50))))
    except (TypeError, ValueError):
        limit = 50

    time_start = epoch(request.get("timeStart"), "起始")
    time_end = epoch(request.get("timeEnd"), "结束")
    if time_start is not None and time_end is not None and time_start > time_end:
        fail("起始时间不能晚于结束时间")

    filter_fingerprint = hashlib.sha256(
        json.dumps(
            {
                "namespace": namespace,
                "query": query,
                "origin": origin,
                "timeStart": time_start,
                "timeEnd": time_end,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    cursor = decode_cursor(str(request.get("cursor") or ""), filter_fingerprint)

    state_dir = Path(str(request.get("stateDir") or "")).resolve()
    config_path = state_dir / "config.toml"
    if not config_path.is_file():
        fail("找不到 A_Memorix 本机配置")
    try:
        with config_path.open("rb") as stream:
            config = tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError):
        fail("无法读取 A_Memorix 本机配置")

    configured_data_dir = Path(str(config.get("data_dir") or "./data"))
    data_dir = configured_data_dir if configured_data_dir.is_absolute() else (config_path.parent / configured_data_dir)
    data_dir = data_dir.resolve()
    control_db = data_dir / "control" / "namespaces.db"
    if not control_db.is_file():
        fail("找不到 A_Memorix namespace 索引")

    try:
        control = open_readonly(control_db)
        try:
            namespace_row = control.execute(
                "SELECT storage_key FROM namespaces WHERE namespace_id = ?",
                (namespace,),
            ).fetchone()
        finally:
            control.close()
    except sqlite3.Error:
        fail("无法读取 A_Memorix namespace 索引")
    if namespace_row is None:
        fail("A_Memorix 中找不到当前 namespace")

    storage_key = str(namespace_row["storage_key"] or "")
    namespace_root = (data_dir / "namespaces").resolve()
    namespace_dir = (namespace_root / storage_key).resolve()
    if not storage_key or Path(storage_key).name != storage_key or namespace_dir.parent != namespace_root:
        fail("A_Memorix namespace 存储路径无效")
    metadata_db = namespace_dir / "metadata" / "metadata.db"
    if not metadata_db.is_file():
        fail("当前 namespace 尚无可读取的记忆账本")

    try:
        connection = open_readonly(metadata_db)
    except sqlite3.Error:
        fail("无法以只读方式打开当前 namespace 的记忆账本")
    try:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paragraphs'"
        ).fetchone()
        if table is None:
            fail("当前 A_Memorix 数据结构尚不支持全量记录浏览")
        columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(paragraphs)")}
        if not REQUIRED_COLUMNS.issubset(columns):
            fail("A_Memorix 记忆账本结构已变化；请先检查程序更新兼容性")

        has_external_refs = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_memory_refs'"
        ).fetchone() is not None
        try:
            connection.execute("SELECT json_valid('{}')").fetchone()
            has_json = True
        except sqlite3.Error:
            has_json = False

        if has_external_refs:
            external_join = """
                LEFT JOIN (
                    SELECT paragraph_hash, MIN(external_id) AS external_id,
                           MIN(source_type) AS source_type
                    FROM external_memory_refs GROUP BY paragraph_hash
                ) r ON r.paragraph_hash = p.hash
            """
            external_id_expr = "r.external_id"
            external_source_expr = "r.source_type"
        else:
            external_join = ""
            external_id_expr = "''"
            external_source_expr = "''"

        if has_json:
            metadata_origin_expr = """CASE WHEN json_valid(p.metadata) THEN
                COALESCE(NULLIF(json_extract(p.metadata, '$.origin'), ''),
                         NULLIF(json_extract(p.metadata, '$.source_type'), '')) END"""
        else:
            metadata_origin_expr = "NULL"
        origin_expr = (
            f"LOWER(COALESCE({metadata_origin_expr}, NULLIF({external_source_expr}, ''), "
            "NULLIF(p.source, ''), ''))"
        )
        sort_expr = "COALESCE(p.event_time, p.created_at, 0)"
        base_where = ["COALESCE(p.is_deleted, 0) = 0"]
        base_params: list[Any] = []

        if query:
            escaped = query.replace("!", "!!").replace("%", "!%").replace("_", "!_")
            base_where.append("p.content LIKE ? ESCAPE '!'")
            base_params.append(f"%{escaped}%")
        if origin != "all":
            base_where.append(f"{origin_expr} = ?")
            base_params.append(origin)
        if time_start is not None:
            base_where.append(f"{sort_expr} >= ?")
            base_params.append(time_start)
        if time_end is not None:
            base_where.append(f"{sort_expr} <= ?")
            base_params.append(time_end)

        joins = f"FROM paragraphs p {external_join}"
        base_clause = " AND ".join(base_where)
        total = int(connection.execute(
            f"SELECT COUNT(*) {joins} WHERE {base_clause}", base_params
        ).fetchone()[0])
        page_where = list(base_where)
        page_params = list(base_params)
        if cursor is not None:
            page_where.append(f"({sort_expr} < ? OR ({sort_expr} = ? AND p.hash < ?))")
            page_params.extend((cursor[0], cursor[0], cursor[1]))

        rows = connection.execute(
            f"""
            SELECT p.hash, p.content, p.created_at, p.updated_at, p.metadata, p.source,
                   p.event_time, p.event_time_start, p.event_time_end, p.knowledge_type,
                   {external_id_expr} AS external_id, {external_source_expr} AS external_source_type,
                   {sort_expr} AS sort_time
            {joins}
            WHERE {' AND '.join(page_where)}
            ORDER BY sort_time DESC, p.hash DESC
            LIMIT ?
            """,
            [*page_params, limit + 1],
        ).fetchall()
    except sqlite3.Error:
        fail("查询 A_Memorix 记忆账本失败；请检查程序版本与本地数据结构")
    finally:
        connection.close()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    hits = []
    for row in page_rows:
        try:
            metadata = json.loads(row["metadata"] or "{}")
        except (json.JSONDecodeError, TypeError):
            metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}
        source_type = str(metadata.get("source_type") or row["external_source_type"] or row["source"] or "")
        source = str(row["source"] or "")
        display_origin = str(metadata.get("origin") or source_type or source or "unknown").lower()
        display_metadata = dict(metadata)
        display_metadata.setdefault("origin", display_origin)
        event_time = row["event_time"]
        if event_time is None and has_json:
            event_time = metadata.get("observedAt") or metadata.get("observed_at")
        if isinstance(event_time, str):
            event_time = optional_metadata_epoch(event_time)
        hits.append({
            "memoryId": str(row["hash"] or ""),
            "externalId": str(metadata.get("external_id") or row["external_id"] or ""),
            "kind": str(row["knowledge_type"] or "paragraph"),
            "title": str(metadata.get("title") or ""),
            "content": str(row["content"] or ""),
            "score": 0,
            "source": source,
            "sourceType": source_type,
            "metadata": display_metadata,
            "createdAt": iso_time(row["created_at"]),
            "updatedAt": iso_time(row["updated_at"]),
            "observedAt": iso_time(event_time),
            "validFrom": iso_time(row["event_time_start"]),
            "validTo": iso_time(row["event_time_end"]),
            "sortTime": float(row["sort_time"]),
        })

    next_cursor = ""
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = encode_cursor(float(last["sort_time"]), str(last["hash"]), filter_fingerprint)
    for hit in hits:
        hit.pop("sortTime", None)
    print(json.dumps({"hits": hits, "total": total, "nextCursor": next_cursor}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail("读取本机 A_Memorix 记忆账本失败")
