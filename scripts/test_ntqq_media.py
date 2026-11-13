"""Offline tests for bounded NTQQ media-cache lookups."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ntqq_media import MAX_ORIGINAL_BYTES, MediaCache, bounded_md5, image_dimensions, resolve_media


PNG = bytes.fromhex("89504e470d0a1a0a0000000d494844520000000100000001080600000000")


def png_size(width, height, padding=0):
    data = bytearray(PNG)
    data[16:20] = width.to_bytes(4, "big")
    data[20:24] = height.to_bytes(4, "big")
    return bytes(data) + b"x" * padding


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

    def test_size_limit_skips_large_original_and_first_thumbnail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original_bytes = PNG + b"o" * 1000
            digest = hashlib.md5(original_bytes).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            first_thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            small_thumb = first_thumb.with_name(f"{digest}_720.png")
            original.parent.mkdir(parents=True)
            first_thumb.parent.mkdir(parents=True)
            original.write_bytes(original_bytes)
            first_thumb.write_bytes(PNG + b"t" * 600)
            small_thumb.write_bytes(PNG + b"t" * 100)
            cache = MediaCache(root)
            # Make the problematic candidate order explicit on every platform.
            self.assertEqual(len(cache.index(False)[digest]), 3)
            cache.indexes[False][digest] = [("Ori", original), ("Thumb", first_thumb), ("Thumb", small_thumb)]
            params = {"type":"image", "md5":digest}

            self.assertEqual(resolve_media(cache, params), str(original.resolve()))
            self.assertEqual(resolve_media(cache, {**params, "maxBytes":256}), str(small_thumb.resolve()))
            self.assertEqual(resolve_media(cache, {**params, "maxBytes":700}), str(first_thumb.resolve()))
            self.assertEqual(resolve_media(cache, {**params, "maxBytes":len(original_bytes)}), str(original.resolve()))
            self.assertEqual(resolve_media(cache, {**params, "maxBytes":256}), str(small_thumb.resolve()))
            self.assertEqual(resolve_media(cache, params), str(original.resolve()))

    def test_oversized_cache_is_not_returned_as_a_miss_even_on_repeated_reads(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            content = PNG + b"x" * 512
            digest = hashlib.md5(content).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            for target in (original, thumb):
                target.parent.mkdir(parents=True)
                target.write_bytes(content)
            cache = MediaCache(root)
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, "缓存均超过读取大小上限"):
                    resolve_media(cache, {"type":"image", "md5":digest, "maxBytes":256})
            self.assertEqual(resolve_media(cache, {"type":"image", "md5":digest}), str(original.resolve()))

    def test_size_limited_market_preview_and_missing_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            emoji_id = "a" * 32
            preview = root / "Emoji/marketface/42" / f"{emoji_id}_aio.png"
            preview.parent.mkdir(parents=True)
            preview.write_bytes(PNG)
            cache = MediaCache(root)
            params = {"type":"marketFace", "emojiId":emoji_id, "packageId":"42"}
            with self.assertRaisesRegex(ValueError, "缓存均超过读取大小上限"):
                resolve_media(cache, {**params, "maxBytes":1})
            self.assertEqual(resolve_media(cache, {**params, "maxBytes":len(PNG)}), str(preview.resolve()))
            self.assertIsNone(resolve_media(cache, {"type":"image", "md5":"b" * 32, "maxBytes":256}))

    def test_max_bytes_requires_a_bounded_positive_integer(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = MediaCache(Path(folder))
            for maximum in (None, True, False, 0, -1, 1.5, "256", 20 * 1024 * 1024 + 1):
                with self.subTest(maximum=maximum), self.assertRaisesRegex(ValueError, "maxBytes"):
                    resolve_media(cache, {"type":"image", "md5":"a" * 32, "maxBytes":maximum})
            for maximum in (1, 20 * 1024 * 1024):
                self.assertIsNone(resolve_media(cache, {"type":"image", "md5":"a" * 32, "maxBytes":maximum}))

    def test_size_limit_preserves_header_digest_and_cache_root_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "nt_data"
            digest = hashlib.md5(PNG).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            bad_thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            outside = Path(folder) / f"{digest}.png"
            original.parent.mkdir(parents=True)
            bad_thumb.parent.mkdir(parents=True)
            original.write_bytes(PNG + b"wrong digest")
            bad_thumb.write_bytes(b"not an image")
            outside.write_bytes(PNG)
            cache = MediaCache(root)
            cache.indexes[False] = {digest:[("Ori", original), ("Thumb", bad_thumb), ("Thumb", outside)]}
            self.assertIsNone(resolve_media(cache, {"type":"image", "md5":digest, "maxBytes":256}))

    def test_quality_preview_prefers_thumbnail_and_original_is_strict(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = png_size(3072, 4096, 1000)
            digest = hashlib.md5(data).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            original.parent.mkdir(parents=True)
            thumb.parent.mkdir(parents=True)
            original.write_bytes(data)
            thumb.write_bytes(png_size(485, 647))
            cache = MediaCache(root)
            params = {"type":"image", "md5":digest}
            preview = resolve_media(cache, {**params, "quality":"preview"})
            self.assertEqual(preview, {"file":str(thumb.resolve()), "representation":"preview", "width":485, "height":647,
                                      "originalWidth":3072, "originalHeight":4096, "originalAvailable":True,
                                      "originalUnavailableReason":None})
            full = resolve_media(cache, {**params, "quality":"original"})
            self.assertEqual(full["file"], str(original.resolve()))
            self.assertEqual((full["representation"], full["width"], full["height"]), ("original", 3072, 4096))
            self.assertEqual(resolve_media(cache, params), str(original.resolve()), "legacy calls keep their path contract")
            self.assertEqual(resolve_media(cache, {**params, "quality":"preview"}), preview)
            with self.assertRaisesRegex(ValueError, "大小上限"):
                resolve_media(cache, {**params, "quality":"original", "maxBytes":256})

    def test_original_missing_is_a_miss_even_when_a_thumbnail_is_cached(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            digest = "a" * 32
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            thumb.parent.mkdir(parents=True)
            thumb.write_bytes(png_size(480, 640, 300))
            cache = MediaCache(root)
            params = {"type":"image", "md5":digest}
            original = resolve_media(cache, {**params, "quality":"original", "maxBytes":256})
            self.assertIsNone(original["file"], "an oversized thumbnail must not prevent fetching a missing original")
            self.assertFalse(original["originalAvailable"])
            self.assertEqual(original["originalUnavailableReason"], "not_cached")
            preview = resolve_media(cache, {**params, "quality":"preview"})
            self.assertEqual(preview["file"], str(thumb.resolve()))
            self.assertFalse(preview["originalAvailable"])
            self.assertIsNone(preview["originalWidth"])

    def test_preview_can_use_a_verified_original_when_no_thumbnail_exists(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = png_size(640, 480)
            digest = hashlib.md5(data).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            original.parent.mkdir(parents=True)
            original.write_bytes(data)
            result = resolve_media(MediaCache(root), {"type":"image", "md5":digest, "quality":"preview"})
            self.assertEqual(result["file"], str(original.resolve()))
            self.assertEqual(result["representation"], "original")
            self.assertTrue(result["originalAvailable"])

    def test_original_mode_accepts_a_23mb_verified_source_and_preview_stays_small(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = png_size(3072, 4096, 23 * 1024 * 1024)
            digest = hashlib.md5(data).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            original.parent.mkdir(parents=True)
            thumb.parent.mkdir(parents=True)
            original.write_bytes(data)
            thumb.write_bytes(png_size(485, 647))
            cache = MediaCache(root)
            params = {"type":"image", "md5":digest}
            result = resolve_media(cache, {**params, "quality":"original", "maxBytes":MAX_ORIGINAL_BYTES})
            self.assertEqual(result["file"], str(original.resolve()))
            self.assertTrue(result["originalAvailable"])
            preview = resolve_media(cache, {**params, "quality":"preview", "maxBytes":256})
            self.assertEqual(preview["file"], str(thumb.resolve()))
            self.assertTrue(preview["originalAvailable"], "verified original availability is independent of the preview byte limit")
            thumb.unlink()
            source = resolve_media(MediaCache(root), {**params, "quality":"preview", "maxBytes":MAX_ORIGINAL_BYTES})
            self.assertEqual(source["file"], str(original.resolve()), "preview generation can use a >20 MiB original when no thumbnail exists")
            self.assertEqual(source["representation"], "original", "source bytes remain accurately labeled before bridge normalization")
            with self.assertRaisesRegex(ValueError, "大小上限"):
                resolve_media(MediaCache(root), {**params, "quality":"preview"})

    def test_oversized_original_is_not_hashed_or_advertised_as_available(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            digest = "a" * 32
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            original.parent.mkdir(parents=True)
            thumb.parent.mkdir(parents=True)
            with original.open("wb") as stream:
                stream.write(png_size(4000, 3000))
                stream.seek(MAX_ORIGINAL_BYTES)
                stream.write(b"x")
            thumb.write_bytes(png_size(400, 300))
            params = {"type":"image", "md5":digest}
            cache = MediaCache(root)
            with patch("ntqq_media.bounded_md5", side_effect=AssertionError("oversized source must not be hashed")):
                preview = resolve_media(cache, {**params, "quality":"preview"})
                self.assertEqual((preview["originalWidth"], preview["originalHeight"]), (4000, 3000))
                self.assertFalse(preview["originalAvailable"])
                self.assertEqual(preview["originalUnavailableReason"], "source_too_large")
                for _ in range(2):
                    with self.assertRaisesRegex(ValueError, "大小上限"):
                        resolve_media(cache, {**params, "quality":"original"})

    def test_quality_metadata_does_not_trust_bad_digest_or_escaped_original(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "nt_data"
            data = png_size(640, 480)
            digest = hashlib.md5(data).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_0.png"
            outside = Path(folder) / "outside.png"
            original.parent.mkdir(parents=True)
            thumb.parent.mkdir(parents=True)
            original.write_bytes(data + b"wrong digest")
            thumb.write_bytes(png_size(320, 240))
            outside.write_bytes(data)
            cache = MediaCache(root)
            cache.indexes[False] = {digest:[("Ori", original), ("Ori", outside), ("Thumb", thumb)]}
            result = resolve_media(cache, {"type":"image", "md5":digest, "quality":"preview"})
            self.assertEqual(result["file"], str(thumb.resolve()))
            self.assertFalse(result["originalAvailable"])
            self.assertIsNone(result["originalWidth"])
            self.assertEqual(result["originalUnavailableReason"], "invalid_cache")
            self.assertIsNone(resolve_media(cache, {"type":"image", "md5":digest, "quality":"original"})["file"])

    def test_quality_and_limits_are_strict_and_market_previews_have_no_original(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = MediaCache(Path(folder))
            params = {"type":"image", "md5":"a" * 32}
            for quality in (None, True, 1, "", "full", [], {}):
                with self.subTest(quality=quality), self.assertRaisesRegex(ValueError, "quality"):
                    resolve_media(cache, {**params, "quality":quality})
            for maximum in (None, True, 0, -1, 1.5, "33554432", MAX_ORIGINAL_BYTES + 1):
                with self.subTest(maximum=maximum), self.assertRaisesRegex(ValueError, "maxBytes"):
                    resolve_media(cache, {**params, "quality":"original", "maxBytes":maximum})
                with self.subTest(maximum=maximum, quality="preview"), self.assertRaisesRegex(ValueError, "maxBytes"):
                    resolve_media(cache, {**params, "quality":"preview", "maxBytes":maximum})
            market = {"type":"marketFace", "emojiId":"a" * 32, "packageId":"42"}
            preview = resolve_media(cache, {**market, "quality":"preview"})
            self.assertEqual(preview["originalUnavailableReason"], "unsupported")
            self.assertFalse(preview["originalAvailable"])
            with self.assertRaisesRegex(ValueError, "不支持读取原图"):
                resolve_media(cache, {**market, "quality":"original"})

    def test_dimension_headers_and_digest_reads_are_bounded(self):
        self.assertEqual(image_dimensions(png_size(3072, 4096)), (3072, 4096))
        self.assertEqual(image_dimensions(b"GIF89a" + b"\x80\x02\xe0\x01"), (640, 480))
        self.assertEqual(image_dimensions(bytes.fromhex("ffd8ffc000110801e0028003011100021100031100")), (640, 480))
        self.assertEqual(image_dimensions(b"invalid"), (None, None))
        self.assertEqual(bounded_md5(io.BytesIO(b"a" * 1000), 10), (None, 11))
        self.assertEqual(bounded_md5(io.BytesIO(b"abc"), 10), (hashlib.md5(b"abc").hexdigest(), 3))


if __name__ == "__main__":
    unittest.main()
