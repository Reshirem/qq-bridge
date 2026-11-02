"""Serve synthetic frames through the real MaaMCP screenshot implementation."""

import asyncio
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from maa_mcp_server import create_server

if not os.environ.get("QQ_MAAMCP_DATA_DIR"):
    raise RuntimeError("The fixture requires an isolated QQ_MAAMCP_DATA_DIR")
server = asyncio.run(create_server())

from maa_mcp import vision
from maa_mcp import adb
from maa_mcp.core import object_registry
from maa_mcp.paths import get_data_dir
from maa.toolkit import AdbDevice, Toolkit


class Frame:
    def __init__(self, image):
        self.image = image

    def wait(self):
        return self

    def get(self):
        return self.image


class SyntheticController:
    def __init__(self, image):
        self.image = image

    def post_screencap(self):
        return Frame(self.image)


object_registry.register_by_name("frame", SyntheticController(np.zeros((1080, 1920, 3), np.uint8)))
noise = np.random.default_rng(42).integers(0, 256, (900, 1600, 3), dtype=np.uint8)
object_registry.register_by_name("noise", SyntheticController(noise))

# Never connect real devices during the protocol regression. Record what the
# real adapter passes into the upstream connection function instead.
adb_executable = get_data_dir() / "fixture-adb.exe"
adb_executable.write_text("fixture only", encoding="utf-8")
os.environ["QQ_MAAMCP_ADB_PATH"] = str(adb_executable)


class SyntheticAdbController:
    def __init__(self, executable, address, screencap_methods, input_methods, config):
        self.address = address
        self.request = {"executable": str(executable), "address": address}

    def set_screenshot_use_raw_size(self, enabled):
        self.request["raw_size"] = enabled
        return True

    def set_screenshot_target_short_side(self, size):
        self.request["short_side"] = size
        return True

    def post_connection(self):
        with (get_data_dir() / "adb-calls.jsonl").open("a", encoding="utf-8") as output:
            output.write(json.dumps(self.request) + "\n")
        return self

    def wait(self):
        return self

    @property
    def succeeded(self):
        return self.address != "192.0.2.254:5555"


def find_devices(specified_adb=None):
    if specified_adb != adb_executable:
        raise AssertionError("Discovery must use the configured adb executable")
    return [AdbDevice("fixture-usb", adb_executable, "fixture-serial", 1, 1, {})]


adb.AdbController = SyntheticAdbController
Toolkit.find_adb_devices = staticmethod(find_devices)

# Exercise the image path check without exposing a file path as a tool argument.
original_capture = vision._screencap
outside = get_data_dir() / "outside.png"
outside.write_bytes(b"not-a-screenshot")


def capture(controller_id, region=None, resolution=None, include_metadata=False):
    if controller_id == "outside":
        return {"path": str(outside)}
    return original_capture(controller_id, region, resolution, include_metadata)


vision._screencap = capture
server.run()
