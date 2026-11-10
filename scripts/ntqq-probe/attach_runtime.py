"""Attach the bridge-owned local IPC channel to the currently logged-in QQ."""
import json
import sys
import tempfile
from pathlib import Path

from probe import HERE, attach_guest, main_pid


def main():
    endpoint = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="qq-bridge-attach-") as tmp:
        # Reuse the observer's idle-client bootstrap until the message service is found.
        bootstrap = (HERE / "observe.cjs").read_text("utf-8")
        runtime = (HERE / "runtime.cjs").read_text("utf-8")
        guest = ("(function(receiver){const module={exports:{}};\n"
                 "if(typeof receiver.getMsgService!=='function' && typeof receiver.fetchFavEmojiList!=='function'){\n"
                 + bootstrap + "\nreturn module.exports(receiver," + json.dumps(tmp) + ",0);}\n"
                 + runtime + "\nmodule.exports(receiver," + json.dumps(endpoint) + ");})")
        attach_guest(main_pid(), guest, Path(tmp), 25)


if __name__ == "__main__":
    main()
