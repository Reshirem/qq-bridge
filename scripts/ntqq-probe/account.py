"""Match QQ's PID to an open account database via the Windows Restart Manager."""
import subprocess
import ctypes as c
from ctypes import wintypes as w


class UniqueProcess(c.Structure):
    _fields_ = [("pid", w.DWORD), ("started", w.FILETIME)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", UniqueProcess), ("application", w.WCHAR * 256),
                ("service", w.WCHAR * 64), ("app_type", w.DWORD), ("status", w.DWORD),
                ("session", w.DWORD), ("restartable", w.BOOL)]


def users_of(path):
    rm = c.WinDLL("rstrtmgr")
    handle = w.DWORD()
    key = c.create_unicode_buffer(33)
    if rm.RmStartSession(c.byref(handle), 0, key):
        return set()
    try:
        files = (w.LPCWSTR * 1)(str(path))
        if rm.RmRegisterResources(handle, 1, files, 0, None, 0, None):
            return set()
        count, needed, reason = w.UINT(), w.UINT(), w.DWORD()
        rows = None
        for _ in range(3):
            code = rm.RmGetList(handle, c.byref(needed), c.byref(count), rows, c.byref(reason))
            if code == 0:
                return {rows[i].process.pid for i in range(count.value)}
            if code != 234:  # ERROR_MORE_DATA
                break
            rows = (ProcessInfo * needed.value)()
            count.value = needed.value
        return set()
    finally:
        rm.RmEndSession(handle)


def active_account(root, pid):
    matches = []
    if not root.is_dir():
        return None
    for account in root.iterdir():
        if not (account.name.isascii() and account.name.isdecimal()):
            continue
        db = account / "nt_qq" / "nt_db" / "nt_msg.db"
        if db.is_file() and pid in users_of(db):
            matches.append(account.name)
    return matches[0] if len(matches) == 1 else None


def main_pid():
    command = ("$p = Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | "
               "Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^| )--type=' }; "
               "$p | ForEach-Object { $_.ProcessId }")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", command],
                            check=True, capture_output=True, text=True)
    pids = result.stdout.split()
    if len(pids) != 1:
        raise ValueError("expected one QQ main process; supply --pid for the logged-in QQ")
    return int(pids[0])
