"""Run the standard MaaMCP server with inline screenshots for DSH.

Use a Python environment containing MaaMCP. QQ_MAAMCP_DATA_DIR optionally
selects its data directory before MaaFramework initializes.
"""

import asyncio
import base64
import ipaddress
import json
import os
import re
import shutil
from pathlib import Path
from typing import Optional, Tuple

from mcp.types import CallToolResult, ImageContent, TextContent


def dsh_instructions(instructions: str) -> str:
    """Describe the standard entry and its inline images without changing tools."""
    instructions = re.sub(
        r"    ⭐ 双模式运行支持：\n.*?(?=    ========================)",
        "    本入口使用标准工具调用方式执行自动化。\n\n",
        instructions,
        flags=re.DOTALL,
    )
    instructions = re.sub(
        r"    3\. 流水线自动化执行.*?(?=    ========================\n    屏幕识别策略)",
        "",
        instructions,
        flags=re.DOTALL,
    )
    instructions = instructions.replace("（必选，两种模式通用）", "（必选）")
    instructions = instructions.replace(
        "调用 find_adb_device_list() 扫描可用的 ADB 设备",
        "用户已给出 IP:端口时直接调用 connect_adb_device(device_name=该地址)；否则调用 find_adb_device_list() 选择已有设备",
    )
    instructions = instructions.replace(
        "（流程 1 之后选择此流程进入串行模式）", "（连接目标之后执行）"
    )
    instructions = instructions.replace(
        "调用 screencap() 获取截图，再通过 read_file 读取图片进行视觉识别",
        "调用 screencap() 获取截图，直接查看工具返回的图片进行视觉识别",
    )
    instructions = instructions.replace(
        "当用户要求生成 Pipeline 时，可以将执行过的自动化操作转换为 MaaFramework Pipeline JSON 格式，\n"
        "    以便后续直接运行而无需再次调用 AI。",
        "在已授权任务中发现稳定、会重复使用的操作流程时，可以主动考虑将已验证的有效操作\n"
        "    转换为 MaaFramework Pipeline JSON，验证后复用，减少逐步看图和调用工具的开销。",
    )
    return instructions.rstrip() + "\n\nDSH 接入约定：\n" + (
        "- screencap 直接返回图片，默认附带坐标元数据；裁剪或缩放后的图片按 image_to_controller 换算坐标。\n"
        "- connect_adb_device 的 device_name 支持已发现的设备名及明确指定的 IP:端口；网络设备无需先出现在设备列表中，MaaFramework 会内部建立 ADB 连接，无需模型在终端执行 adb connect。\n"
        "- MaaMCP 是由 DSH 托管的可复用工具服务，随 DSH 关闭；普通回合结束或 agent_rest 不要求关闭服务进程。\n"
        "- 控制器可以跨回合复用；需要清理指定控制器的任务资源时使用 stop_pipeline(controller_id)，它会注销该控制器，后续操作须重新连接。\n"
        "- WebUI 停止和 computer-use 的 Esc 不调用 Maa 清理接口；Pipeline 应设置有限的 timeout_seconds，避免长时间占用工具调用。\n"
    )


def network_adb_address(value: str) -> Optional[str]:
    """Recognize an explicit numeric IP endpoint, never an adb argument string."""
    if ":" not in value:
        return None
    host, _, port = value.rpartition(":")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    elif ":" in host:
        raise ValueError("IPv6 地址请使用 [IP]:端口 格式")
    address = ipaddress.ip_address(host)
    if not port.isascii() or not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise ValueError("ADB 端口必须是 1 至 65535 的整数")
    host = f"[{address}]" if address.version == 6 else str(address)
    return f"{host}:{int(port)}"


def configured_adb_path() -> Optional[Path]:
    """The executable is selected by host configuration, never by a tool argument."""
    configured = os.environ.get("QQ_MAAMCP_ADB_PATH", "").strip()
    executable = configured or shutil.which("adb")
    if not executable:
        return None
    candidate = Path(executable).expanduser()
    if not candidate.is_absolute() or not candidate.is_file():
        raise ValueError("QQ_MAAMCP_ADB_PATH 必须指向已安装 adb 的绝对文件路径")
    return candidate.resolve()


async def configure_adb_tools(mcp):
    """Keep both upstream tool names and route explicit addresses through Maa."""
    from maa.define import MaaAdbInputMethodEnum, MaaAdbScreencapMethodEnum
    from maa.toolkit import AdbDevice, Toolkit
    from maa_mcp import adb
    from maa_mcp.core import object_registry

    find_tool = await mcp.get_tool("find_adb_device_list")
    connect_tool = await mcp.get_tool("connect_adb_device")

    def find_adb_device_list() -> list[str]:
        executable = configured_adb_path()
        devices = Toolkit.find_adb_devices(executable) if executable else Toolkit.find_adb_devices()
        for device in devices:
            object_registry.register_by_name(device.name, device)
        return [device.name for device in devices]

    def connect_adb_device(device_name: str, target_short_side: Optional[int] = 720) -> str:
        if target_short_side is not None and (type(target_short_side) is not int or target_short_side <= 0):
            raise ValueError("target_short_side must be a positive integer or None")
        if object_registry.get(device_name) is None:
            address = network_adb_address(device_name)
            if address is None:
                raise ValueError("设备名未发现：请先调用 find_adb_device_list，或直接传入 IP:端口")
            executable = configured_adb_path()
            if executable is None:
                raise FileNotFoundError("网络 ADB 需要本机 adb：请在 MaaMCP 服务配置中设置 QQ_MAAMCP_ADB_PATH，或将 adb 加入 PATH")
            object_registry.register_by_name(device_name, AdbDevice(
                name=device_name, adb_path=executable, address=address,
                screencap_methods=MaaAdbScreencapMethodEnum.Default,
                input_methods=MaaAdbInputMethodEnum.Default, config={},
            ))
        controller_id = adb.connect_adb_device(device_name, target_short_side)
        if controller_id is None:
            raise RuntimeError("ADB 连接失败：请检查设备地址、网络连通性及设备的调试授权/配对状态")
        return controller_id

    mcp.tool(name="find_adb_device_list", description=find_tool.description)(find_adb_device_list)
    mcp.tool(
        name="connect_adb_device",
        description=(connect_tool.description or "")
        .replace("目标设备名称，需通过 find_adb_device_list() 获取", "已发现的设备名，或用户明确指定的 IP:端口（IPv6 用 [IP]:端口）")
        .replace("- 失败：返回 None", "- 失败：返回明确的工具错误")
        + "\nDSH 适配：网络地址可直接连接，无需先枚举或在终端执行 adb connect；由 MaaFramework 内部建立连接。adb 路径来自服务配置 QQ_MAAMCP_ADB_PATH 或 PATH。",
    )(connect_adb_device)


def screenshot_content(capture, screenshots_dir: Path) -> CallToolResult:
    """Attach only a newly captured image; preserve its path and coordinates."""
    if capture is None:
        raise ValueError("截图失败：控制器可能已失效，请重新发现并连接目标")
    raw_path = capture["path"] if isinstance(capture, dict) else capture
    image_path = Path(raw_path).resolve(strict=True)
    if not image_path.is_relative_to(screenshots_dir.resolve()):
        raise ValueError("截图路径不在 MaaMCP 截图目录内")
    data = image_path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("MaaMCP 截图不是 PNG 图片")

    # Keep the original PNG for templates. Re-encoding changes no coordinates.
    mime_type = "image/png"
    if len(data) > 1024 * 1024:
        import cv2
        import numpy as np

        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("无法解码 MaaMCP 截图")
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            raise ValueError("无法编码 MaaMCP 截图")
        data = encoded.tobytes()
        mime_type = "image/jpeg"
    if len(data) > 3 * 1024 * 1024:
        raise ValueError("截图超过 3 MiB，请缩小 screencap 的 region 或 resolution 后重试")

    text = json.dumps(capture, ensure_ascii=False) if isinstance(capture, dict) else capture
    return CallToolResult(content=[
        TextContent(type="text", text=text),
        ImageContent(type="image", mimeType=mime_type, data=base64.b64encode(data).decode("ascii")),
    ])


async def create_server():
    """Adapt instructions and screenshot transport while retaining upstream tools."""
    from maa_mcp import paths

    data_dir = os.environ.get("QQ_MAAMCP_DATA_DIR", "").strip()
    if data_dir:
        configured_dir = Path(data_dir).expanduser()
        if not configured_dir.is_absolute():
            raise ValueError("QQ_MAAMCP_DATA_DIR 必须是绝对路径")
        resolved_dir = configured_dir.resolve()
        paths.get_data_dir = lambda: resolved_dir

    from maa_mcp.main import mcp
    from maa_mcp import vision

    mcp.instructions = dsh_instructions(mcp.instructions or "")
    await configure_adb_tools(mcp)
    original = await mcp.get_tool("screencap")

    def screencap(
        controller_id: str,
        region: Optional[Tuple[int, int, int, int]] = None,
        resolution: Optional[int] = None,
        include_metadata: bool = True,
    ) -> CallToolResult:
        # Metadata stays available for cropped/scaled images without read_image.
        capture = vision._screencap(controller_id, region, resolution, include_metadata)
        return screenshot_content(capture, paths.get_screenshots_dir())

    mcp.tool(
        name="screencap",
        output_schema=None,
        description=(original.description or "")
        .replace("include_metadata: 默认 False", "include_metadata: 默认 True")
        .replace("screencap(cid) → Read 源图", "screencap(cid) → 查看工具返回的图片")
        .replace("Read 裁剪结果", "查看工具返回的裁剪图片")
        + "\n\nDSH 适配：返回可直接查看的图片和原始路径，无需 read/read_image 工具；"
        "include_metadata 默认 True，保留坐标变换。大图可能转为同尺寸 JPEG，原 PNG 不变。",
    )(screencap)
    return mcp


if __name__ == "__main__":
    asyncio.run(create_server()).run()
