"""Offline tests for bounded NTQQ media-cache lookups."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from ntqq_media import MediaCache, resolve_media


PNG = bytes.fromhex("89504e470d0a1a0a0000000d494844520000000100000001080600000000")


class NativeMediaCacheTest(unittest.TestCase):
    def test_image_original_and_market_preview_resolution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            digest = hashlib.md5(PNG).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            original.parent.mkdir(parents=True)
            original.write_bytes(PNG)
            emoji_id = "a" * 32
            preview = root / "Emoji/marketface/42" / f"{emoji_id}_aio.png"
            preview.parent.mkdir(parents=True)
            preview.write_bytes(PNG)
            cache = MediaCache(root)

            self.assertEqual(resolve_media(cache, {"type":"image", "md5":digest.upper()}), str(original.resolve()))
            self.assertEqual(resolve_media(cache, {"type":"marketFace", "emojiId":emoji_id, "packageId":"42"}),
                             str(preview.resolve()))

    def test_market_face_lookup_rejects_path_components(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = MediaCache(Path(folder))
            for item in (
                {"type":"marketFace", "emojiId":"../escape", "packageId":"42"},
                {"type":"marketFace", "emojiId":"a" * 32, "packageId":"../../escape"},
            ):
                with self.subTest(item=item), self.assertRaises(ValueError):
                    resolve_media(cache, item)


if __name__ == "__main__":
    unittest.main()
