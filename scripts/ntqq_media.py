"""Resolve NTQQ media references within the logged-in account's Windows cache."""
from collections import defaultdict
import hashlib
import re


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

    def resolve(self, item):
        kind = item["type"]
        market = kind == "marketFace"
        digest = item.get("emojiId" if market else "md5")
        if not digest:
            return {}
        package = item.get("packageId")
        key = (kind, digest, package)
        if key in self.results:
            return self.results[key]
        if market:
            # The extensionless market payload is encoded. Only its PNG preview
            # is directly displayable in the Windows cache.
            candidates = [("Thumb", self.root / "Emoji/marketface" / str(package) / (digest + "_aio.png"))] if package else []
        else:
            candidates = self.index(kind == "video").get(digest, ())
        found = {}
        for role, path in candidates:
            original = role == "Ori"
            field = "original" if original else "cover" if kind == "video" else "thumbnail"
            if field in found:
                continue
            try:
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(self.root) or not resolved.is_file():
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
        self.results[key] = found
        return found
