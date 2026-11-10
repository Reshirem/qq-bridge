"""Build the SQLCipher read-only VFS for Windows x64 using Zig's C compiler."""
from pathlib import Path
import hashlib
import io
import subprocess
import sys
import tempfile
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
URL = "https://www.sqlite.org/2025/sqlite-amalgamation-3500400.zip"
SHA256 = "1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032"


def main():
    with urlopen(URL, timeout=60) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != SHA256:
        raise ValueError("SQLite header download checksum mismatch")
    dest = ROOT / "state/ntqq-reader/ntqq_vfs.dll"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as folder:
        build = Path(folder)
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            for name in ("sqlite3ext.h", "sqlite3.h"):
                (build / name).write_bytes(bundle.read("sqlite-amalgamation-3500400/" + name))
        subprocess.run([sys.executable, "-m", "ziglang", "cc", "-target", "x86_64-windows-gnu",
                        "-shared", "-Os", "-Wall", "-Wextra", "-Werror", "-s", "-I", str(build),
                        str(ROOT / "scripts/ntqq_vfs.c"), "-o", "ntqq_vfs.dll"], cwd=build, check=True)
        (build / "ntqq_vfs.dll").replace(dest)
    print(dest)


if __name__ == "__main__":
    main()
