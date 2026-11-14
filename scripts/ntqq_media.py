"""Resolve NTQQ media references within the logged-in account's Windows cache."""
from collections import defaultdict
import hashlib
from pathlib import Path
import re


MAX_MEDIA_BYTES = 20 * 1024 * 1024
MAX_ORIGINAL_BYTES = 32 * 1024 * 1024
DEFAULT_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_HEADER_BYTES = 256 * 1024
MAX_PREVIEW_PIXELS = 64_000_000


def digest_hex(value):
    if len(value) == 16:
        return value.hex()
    if re.fullmatch(rb"[0-9a-fA-F]{32}", value):
        return value.decode("ascii").lower()
    return None


def media_header(header):
    if (header.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"BM"))
            or header[:4] == b"RIFF" and header[8:12] == b"WEBP"):
        return "image"
    if header[4:8] == b"ftyp":
        return "image" if header[8:12] in (b"avif", b"avis", b"heic", b"heix", b"mif1") else "video"
    return None


def image_dimensions(header):
    """Read dimensions from a bounded header, without decoding image pixels."""
    width = height = 0
    if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
        width, height = int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")
    elif header.startswith((b"GIF87a", b"GIF89a")) and len(header) >= 10:
        width, height = int.from_bytes(header[6:8], "little"), int.from_bytes(header[8:10], "little")
    elif header.startswith(b"BM") and len(header) >= 26:
        width = int.from_bytes(header[18:22], "little", signed=True)
        height = abs(int.from_bytes(header[22:26], "little", signed=True))
    elif header[:4] == b"RIFF" and header[8:12] == b"WEBP" and len(header) >= 30:
        if header[12:16] == b"VP8X":
            width, height = 1 + int.from_bytes(header[24:27], "little"), 1 + int.from_bytes(header[27:30], "little")
        elif header[12:16] == b"VP8L":
            bits = int.from_bytes(header[21:25], "little")
            width, height = 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)
        elif header[12:16] == b"VP8 ":
            width, height = int.from_bytes(header[26:28], "little") & 0x3fff, int.from_bytes(header[28:30], "little") & 0x3fff
    elif header.startswith(b"\xff\xd8\xff"):
        offset = 2
        while offset + 9 < len(header):
            if header[offset] != 0xff:
                offset += 1
                continue
            marker = header[offset + 1]
            if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
                offset += 2
                continue
            length = int.from_bytes(header[offset + 2:offset + 4], "big")
            if length < 2:
                break
            if 0xc0 <= marker <= 0xcf and marker not in (0xc4, 0xc8, 0xcc):
                width = int.from_bytes(header[offset + 7:offset + 9], "big")
                height = int.from_bytes(header[offset + 5:offset + 7], "big")
                break
            offset += 2 + length
    return (width, height) if width > 0 and height > 0 else (None, None)


def bounded_md5(stream, limit):
    stream.seek(0)
    digest = hashlib.md5()
    total = 0
    while total <= limit:
        block = stream.read(min(64 * 1024, limit + 1 - total))
        if not block:
            return digest.hexdigest(), total
        total += len(block)
        digest.update(block)
    return None, total


class MediaCache:
    def __init__(self, root):
        self.root = root.resolve()
        self.indexes = {}
        self.results = {}

    def index(self, video):
        if video in self.indexes:
            return self.indexes[video]
        roots = ("Video",) if video else ("Pic", "Emoji/emoji-recv")
        files = defaultdict(list)
        for name in roots:
            for role in ("Ori", "Thumb"):
                for folder in (self.root / name).glob("????-??/" + role):
                    try:
                        if not folder.resolve().is_relative_to(self.root):
                            continue
                        for path in folder.iterdir():
                            match = re.fullmatch(r"([0-9a-f]{32})(?:_\d+)?\.[a-z0-9]+", path.name, re.I)
                            if match:
                                files[match[1].lower()].append((role, path))
                    except OSError:
                        continue  # A cache folder can be locked or evicted by QQ.
        self.indexes[video] = files
        return files

    def resolve(self, item, max_bytes=None):
        kind = item["type"]
        market = kind == "marketFace"
        digest = item.get("emojiId" if market else "md5")
        if not digest:
            return {}
        package = item.get("packageId")
        if market and (not re.fullmatch(r"[0-9a-f]{16,64}", str(digest), re.I)
                       or not re.fullmatch(r"[1-9]\d{0,18}", str(package or ""))):
            return {}
        key = (kind, digest, package, max_bytes)
        if key in self.results:
            return self.results[key]
        if market:
            # The extensionless market payload is encoded. Only its PNG preview
            # is directly displayable in the Windows cache.
            candidates = [("Thumb", self.root / "Emoji/marketface" / str(package) / (digest + "_aio.png"))] if package else []
        else:
            candidates = self.index(kind == "video").get(digest, ())
        found = {}
        oversized = False
        for role, path in candidates:
            original = role == "Ori"
            field = "original" if original else "cover" if kind == "video" else "thumbnail"
            if field in found:
                continue
            try:
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(self.root) or not resolved.is_file():
                    continue
                if max_bytes is not None and resolved.stat().st_size > max_bytes:
                    # QQ may have several Thumb sizes. A large original or first
                    # preview must not hide a later preview that fits the limit.
                    oversized = True
                    continue
                with resolved.open("rb") as stream:
                    expected = "video" if original and kind == "video" else "image"
                    if media_header(stream.read(32)) != expected:
                        continue
                    if original:
                        stream.seek(0)
                        if hashlib.file_digest(stream, "md5").hexdigest() != digest:
                            continue
                found[field] = str(resolved)
            except OSError:
                continue
        if not found and oversized:
            # An existing oversized cache is not a cache miss: downloading the
            # same original again would not make it fit. Do not cache this error
            # as an empty result, which would make a repeated read redownload it.
            raise ValueError(f"QQ 本地图片缓存均超过读取大小上限（{max_bytes} 字节），未重复下载")
        self.results[key] = found
        return found

    def verified_preview(self, digest, path, max_bytes):
        """Only accept the exact account-cache identity checked by QQ runtime.

        QQ can store a re-encoded thumb:0 in Ori under the source MD5 name.
        It remains a preview, and the caller must decode the bytes before use.
        """
        candidate = Path(path)

        def valid_location(value):
            if not value.is_absolute():
                return False
            try:
                relative = value.relative_to(self.root).as_posix()
            except ValueError:
                return False
            return re.fullmatch(
                r"(?:Pic|Emoji/emoji-recv)/\d{4}-(?:0[1-9]|1[0-2])/(?:Ori|Thumb)/"
                + re.escape(digest) + r"(?:_\d+)?\.[a-z0-9]+", relative, re.I) is not None

        if not valid_location(candidate):
            raise ValueError("QQ 已核验预览路径不属于当前图片缓存")
        try:
            resolved = candidate.resolve(strict=True)
            if not valid_location(resolved):
                raise ValueError("QQ 已核验预览路径不属于当前图片缓存")
            if not resolved.is_file():
                return None
            size = resolved.stat().st_size
            if size > max_bytes:
                raise ValueError(f"QQ 本地图片缓存均超过读取大小上限（{max_bytes} 字节），未重复下载")
            with resolved.open("rb") as stream:
                header = stream.read(MAX_HEADER_BYTES)
            width, height = image_dimensions(header)
            if (media_header(header) != "image" or width is None or height is None
                    or width * height > MAX_PREVIEW_PIXELS):
                return None
            return {"file": str(resolved), "width": width, "height": height, "bytes": size}
        except (OSError, RuntimeError):
            return None  # QQ may evict the preview or leave an unresolved link.

    def resolve_quality(self, item, quality, max_bytes, verified_preview_path=None):
        """Quality reads return verified source metadata; legacy reads stay paths."""
        market = item["type"] == "marketFace"
        if market and quality == "original":
            raise ValueError("QQ 商城表情暂不支持读取原图")
        digest = item.get("emojiId" if market else "md5")
        package = item.get("packageId")
        key = ("quality", item["type"], digest, package, quality, max_bytes, verified_preview_path)
        if key in self.results:
            return self.results[key]
        candidates = ([("Thumb", self.root / "Emoji/marketface" / str(package) / (digest + "_aio.png"))]
                      if market else self.index(False).get(digest, ()))
        original = thumbnail = None
        original_dimensions = (None, None)
        unavailable = "unsupported" if market else "not_cached"
        oversized = False
        for role, path in candidates:
            is_original = role == "Ori"
            if quality == "original" and not is_original:
                continue  # A cached preview must not suppress an original download.
            if (is_original and original) or (not is_original and thumbnail):
                continue
            try:
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(self.root) or not resolved.is_file():
                    continue
                size = resolved.stat().st_size
                with resolved.open("rb") as stream:
                    header = stream.read(MAX_HEADER_BYTES)
                    if media_header(header) != "image":
                        if is_original and unavailable == "not_cached":
                            unavailable = "invalid_cache"
                        continue
                    width, height = image_dimensions(header)
                    if is_original:
                        # Preview metadata can describe a large original, but an
                        # unverified or >32 MiB source is never called available.
                        if size > MAX_ORIGINAL_BYTES:
                            if unavailable != "source_too_large":
                                original_dimensions = (width, height)
                            unavailable = "source_too_large"
                            oversized = True
                            continue
                        actual_digest, actual_size = bounded_md5(stream, MAX_ORIGINAL_BYTES)
                        if actual_digest is None:
                            original_dimensions = (width, height)
                            unavailable = "source_too_large"
                            oversized = True
                            continue
                        if actual_digest != digest or actual_size != size:
                            if unavailable == "not_cached":
                                unavailable = "invalid_cache"
                            continue
                        original = {"file": str(resolved), "width": width, "height": height, "bytes": size}
                        original_dimensions = (width, height)
                        unavailable = None
                    if size > max_bytes:
                        oversized = True
                        continue
                    if not is_original:
                        thumbnail = {"file": str(resolved), "width": width, "height": height, "bytes": size}
            except OSError:
                continue
        selected = (thumbnail if quality == "preview" else None) or (
            original if original and original["bytes"] <= max_bytes else None)
        verified_preview = None
        if not selected and quality == "preview" and verified_preview_path is not None:
            verified_preview = self.verified_preview(digest, verified_preview_path, max_bytes)
            selected = verified_preview
        if not selected and oversized:
            raise ValueError(f"QQ 本地图片缓存均超过读取大小上限（{max_bytes} 字节），未重复下载")
        result = {
            "file": selected["file"] if selected else None,
            "representation": "preview" if selected is not None and (selected is thumbnail or selected is verified_preview)
                              else "original" if selected else quality,
            "width": selected["width"] if selected else None,
            "height": selected["height"] if selected else None,
            "originalWidth": original_dimensions[0], "originalHeight": original_dimensions[1],
            "originalAvailable": original is not None,
            "originalUnavailableReason": unavailable,
        }
        if verified_preview is not None:
            result["requiresDecode"] = True
        self.results[key] = result
        return result


def resolve_media(cache, params):
    quality = params.get("quality")
    if "quality" in params and quality not in ("preview", "original"):
        raise ValueError("图片 quality 必须是 preview 或 original")
    verified_preview_path = params.get("verifiedPreviewPath")
    if "verifiedPreviewPath" in params and (
            quality != "preview" or params.get("type", "image") != "image"
            or not isinstance(verified_preview_path, str) or not verified_preview_path
            or "\x00" in verified_preview_path):
        raise ValueError("verifiedPreviewPath 仅用于已核验的普通图片预览")
    max_bytes = params.get("maxBytes")
    # Explicit preview reads may need a large source to generate the preview.
    # The bridge separately caps the normalized model output.
    maximum = MAX_ORIGINAL_BYTES if quality else MAX_MEDIA_BYTES
    if "maxBytes" in params and (type(max_bytes) is not int or not 0 < max_bytes <= maximum):
        raise ValueError(f"图片 maxBytes 必须是 1 至 {maximum} 之间的整数")
    if quality and "maxBytes" not in params:
        max_bytes = MAX_ORIGINAL_BYTES if quality == "original" else DEFAULT_PREVIEW_BYTES
    if params.get("type") == "marketFace":
        emoji_id = str(params.get("emojiId", "")).lower()
        package_id = str(params.get("packageId", ""))
        if not re.fullmatch(r"[0-9a-f]{16,64}", emoji_id) or not re.fullmatch(r"[1-9]\d{0,18}", package_id):
            raise ValueError("无效的商城表情标识")
        item = {"type": "marketFace", "emojiId": emoji_id, "packageId": package_id}
        if quality:
            return cache.resolve_quality(item, quality, max_bytes)
        files = cache.resolve(item, max_bytes)
        return files.get("thumbnail")
    if params.get("type", "image") != "image":
        raise ValueError("未知的媒体类型")
    digest = str(params.get("md5", "")).lower()
    if not re.fullmatch(r"[0-9a-f]{32}", digest):
        raise ValueError("无效的图片标识")
    item = {"type": "image", "md5": digest}
    if quality:
        return cache.resolve_quality(item, quality, max_bytes, verified_preview_path)
    files = cache.resolve(item, max_bytes)
    return files.get("original") or files.get("thumbnail")
