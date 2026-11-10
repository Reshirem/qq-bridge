"""Cache verified database keys per Windows user, QQ account and NTQQ key metadata."""
import hashlib
import os
from pathlib import Path
import re
import tempfile

import pywintypes
import win32crypt


def key_header(source):
    # SnowLuma 2.0.3 reads the 128 hex characters at bytes 47..174.
    with source.open("rb", buffering=0) as stream:
        header = stream.read(175)
    if (not header.startswith(b"SQLite header 3\0")
            or not re.fullmatch(b"[0-9a-fA-F]{128}", header[47:175])):
        raise ValueError("无法识别 NTQQ 文件头中的 key_meta")
    return header


def key_identity(account, header):
    return hashlib.sha256(account.encode("ascii") + b"\0" + header[47:175].lower()).digest()


def cached_key(folder, identity):
    path = folder / (identity.hex() + ".dpapi")
    try:
        protected = path.read_bytes()
    except FileNotFoundError:
        return None
    try:
        return win32crypt.CryptUnprotectData(protected, identity, None, None, 1)[1].decode("utf-8")
    except (pywintypes.error, UnicodeDecodeError):
        return None


def store_key(folder, identity, password):
    # DPAPI user scope (no machine-scope flag). Replace atomically across CLI processes.
    protected = win32crypt.CryptProtectData(password.encode("utf-8"), None, identity, None, None, 1)
    folder.mkdir(parents=True, exist_ok=True)
    temp = tempfile.NamedTemporaryFile(dir=folder, delete=False)
    path = Path(temp.name)
    try:
        with temp:
            temp.write(protected)
        os.replace(path, folder / (identity.hex() + ".dpapi"))
    finally:
        path.unlink(missing_ok=True)


def request_key(action, folder, header):
    # SnowLuma reads db_path in its entirety; only this fixed prefix is needed.
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=folder) as temp:
        path = Path(temp) / "ntqq-header.bin"
        path.write_bytes(header)
        password = action("request_decrypt_key", {"db_path": str(path)}).get("db_key")
    if not isinstance(password, str) or not password or "\0" in password:
        raise ValueError("SnowLuma 没有返回可用的数据库密钥")
    return password
