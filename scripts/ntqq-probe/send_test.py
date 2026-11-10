"""Exercise one private desktop QQ send and record its native receipt."""
import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

from account import active_account
from probe import HERE, main_pid, observe


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "text", "sticker"))
    parser.add_argument("--peer", required=True, help="target QQ number")
    parser.add_argument("--uid", required=True, help="NT UID from the target private conversation")
    parser.add_argument("--sample-id", required=True, help="existing native message ID in that conversation")
    parser.add_argument("--run", required=True, help="use the same run name for both messages and any rechecks")
    parser.add_argument("--original", type=Path, help="local original matching an active QQ favorite by MD5")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--tencent-files", type=Path, default=Path.home() / "Documents" / "Tencent Files")
    args = parser.parse_args()
    if not (re.fullmatch(r"[1-9][0-9]{4,18}", args.peer) and re.fullmatch(r"u_[\w-]+", args.uid)
            and re.fullmatch(r"-?[0-9]{1,20}", args.sample_id)):
        parser.error("invalid private target or sample ID")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", args.run):
        parser.error("invalid run name")
    journal = HERE.parents[1] / "state" / "ntqq-probe" / "send-tests" / args.run
    journal.mkdir(parents=True, exist_ok=True)
    pid = args.pid or main_pid()
    operation = dict(action=args.action, uin=args.peer, uid=args.uid, sampleId=args.sample_id,
                     owner=active_account(args.tencent_files, pid), journal=str(journal),
                     original=str(args.original.resolve(strict=True)) if args.original else None)
    if args.action != "check" and (journal / (args.action + ".attempt.json")).exists():
        sys.exit("This action already has an attempt. Reconcile its receipt or QQ history before any new run.")
    with tempfile.TemporaryDirectory(prefix="ntqq-send-test-") as tmp:
        result = observe(pid, Path(tmp), 45, 45, operation)
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["status"] in ("ready", "confirmed") else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.exit(str(exc))
