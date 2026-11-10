"""Observe an already logged-in Windows desktop QQ without restarting it."""
import argparse
import json
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

import frida

from account import active_account, main_pid

HERE = Path(__file__).resolve().parent


def observe(pid, directory, seconds, wait, send_test=None):
    body = (HERE / "observe.cjs").read_text(encoding="utf-8")
    if send_test is not None:
        send_body = (HERE / "send-test.cjs").read_text(encoding="utf-8")
        body += ("\nif (typeof receiver.fetchFavEmojiList === 'function' || "
                 "typeof receiver.getMsgService === 'function') {\n" + send_body +
                 f"\nmodule.exports(receiver,{json.dumps(str(directory))},{json.dumps(send_test)}); return; }}")
    guest = ("(function(receiver){ const module = {exports:{}};\n" + body +
             f"\nmodule.exports(receiver,{json.dumps(str(directory))},{seconds}); }})")
    wrapper = attach_guest(pid, guest, directory, wait)
    deadline = time.monotonic() + seconds + 4
    result = directory / "result.json"
    while time.monotonic() < deadline:
        if result.is_file():
            data = json.loads(result.read_text(encoding="utf-8"))
            if data.get("done"):
                data["build"] = next((part for part in wrapper.parts if re.fullmatch(r"[\d.]+-\d+", part)), None)
                return data
        time.sleep(0.25)
    raise ValueError("QQ did not finish the observation within the time limit")


def attach_guest(pid, guest, directory, wait):
    session = frida.attach(pid)
    arrived = threading.Event()
    status = {}

    def message(packet, _data):
        if packet["type"] == "send":
            status.update(packet["payload"])
        elif packet["type"] == "error":
            status.update(stage="failed", reason=packet.get("description"))
        arrived.set()

    try:
        script = session.create_script((HERE / "attach.js").read_text(encoding="utf-8"))
        script.on("message", message)
        script.load()
        wrapper = Path(script.exports_sync.start(guest, len(guest.encode("utf-8"))))
        if not arrived.wait(wait):
            lookup = directory / "lookup.json"
            detail = json.loads(lookup.read_text()) if lookup.is_file() else "no renderer request"
            raise ValueError(f"no live QQ message-service receiver observed ({detail}): {script.exports_sync.counts()}")
        if status.get("stage") != "attached":
            raise ValueError(f"could not enter QQ: {status.get('reason')}")
    finally:
        session.detach()
    return wrapper


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--seconds", type=int, choices=range(1, 301), metavar="1..300", default=30)
    parser.add_argument("--wait", type=int, choices=range(1, 301), metavar="1..300", default=30)
    parser.add_argument("--tencent-files", type=Path, default=Path.home() / "Documents" / "Tencent Files")
    args = parser.parse_args()
    pid = args.pid or main_pid()
    owner = active_account(args.tencent_files, pid)
    with tempfile.TemporaryDirectory(prefix="ntqq-observe-") as tmp:
        result = observe(pid, Path(tmp), args.seconds, args.wait)
    if owner and result.get("account") and owner != result["account"]:
        raise ValueError("QQ session identity differs from the open QQ database")
    result["accountSource"] = "QQ authData" if result.get("account") else ("open QQ database" if owner else None)
    result["account"] = result.get("account") or owner
    print(json.dumps(result, ensure_ascii=True))
    return 0 if (result["account"] and result["listener"] == "removed" and
                 result["favorites"]["status"] == "ok" and result["incoming"] > 0) else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.exit(str(exc))
