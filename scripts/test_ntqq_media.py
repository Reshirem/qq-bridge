"""Offline tests for bounded NTQQ media-cache lookups."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ntqq_media import MAX_ORIGINAL_BYTES, MAX_PREVIEW_PIXELS, MediaCache, bounded_md5, image_dimensions, resolve_media


PNG = bytes.fromhex("89504e470d0a1a0a0000000d494844520000000100000001080600000000")
# Complete 4x4 JPEG, deliberately stored with a PNG filename in fallback tests.
JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010200000100010000fffe00104c61766336332e32352e31303000"
    "ffdb0043000804040404040505050505050606060606060606060606060606060607070708"
    "080807070706060707080808080909090808080809090a0a0a0c0c0b0b0e0e0e111114"
    "ffc4004b0001010000000000000000000000000000000701010000000000000000000000"
    "0000000000100100000000000000000000000000000000110100000000000000000000"
    "000000000000ffc00011080004000403012200021100031100ffda000c03010002110311"
    "003f00bf800fffd9")


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

    def test_verified_preview_accepts_qq_reencoded_ori_only_as_preview(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "nt_data"
            digest = "a" * 32
            preview = root / "Pic/2026-11/Ori" / f"{digest}.png"
            preview.parent.mkdir(parents=True)
            preview.write_bytes(JPEG)
            self.assertNotEqual(hashlib.md5(JPEG).hexdigest(), digest)
            cache = MediaCache(root)
            params = {"type":"image", "md5":digest}
            self.assertIsNone(resolve_media(cache, {**params, "quality":"preview"})["file"])
            result = resolve_media(cache, {**params, "quality":"preview", "verifiedPreviewPath":str(preview)})
            self.assertEqual(result["file"], str(preview.resolve()))
            self.assertEqual((result["representation"], result["width"], result["height"]), ("preview", 4, 4))
            self.assertTrue(result["requiresDecode"], "header validation does not establish full decodability")
            self.assertFalse(result["originalAvailable"])
            self.assertIsNone(result["originalWidth"])
            self.assertEqual(result["originalUnavailableReason"], "invalid_cache")
            self.assertIsNone(resolve_media(cache, {**params, "quality":"original"})["file"])
            self.assertIsNone(resolve_media(cache, params), "the legacy contract still rejects a mismatched Ori digest")

    def test_verified_preview_preserves_existing_cache_priority_and_original_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = png_size(640, 480, 1000)
            digest = hashlib.md5(data).hexdigest()
            original = root / "Pic/2026-11/Ori" / f"{digest}.png"
            fallback = original.with_name(f"{digest}_0.png")
            thumb = root / "Pic/2026-11/Thumb" / f"{digest}_720.png"
            original.parent.mkdir(parents=True)
            thumb.parent.mkdir(parents=True)
            original.write_bytes(data)
            fallback.write_bytes(JPEG)
            params = {"type":"image", "md5":digest, "quality":"preview", "verifiedPreviewPath":str(fallback)}
            result = resolve_media(MediaCache(root), params)
            self.assertEqual(result["file"], str(original.resolve()))
            self.assertEqual(result["representation"], "original")
            self.assertNotIn("requiresDecode", result)
            # A verified original can remain available while only the smaller
            # native preview fits this particular request's byte budget.
            result = resolve_media(MediaCache(root), {**params, "maxBytes":len(JPEG)})
            self.assertEqual(result["file"], str(fallback.resolve()))
            self.assertEqual(result["representation"], "preview")
            self.assertTrue(result["requiresDecode"])
            self.assertTrue(result["originalAvailable"])
            self.assertEqual((result["originalWidth"], result["originalHeight"]), (640, 480))
            self.assertIsNone(result["originalUnavailableReason"])
            thumb.write_bytes(png_size(320, 240))
            result = resolve_media(MediaCache(root), params)
            self.assertEqual(result["file"], str(thumb.resolve()))
            self.assertNotIn("requiresDecode", result)

    def test_verified_preview_cache_keys_include_the_exact_native_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            digest = "a" * 32
            first = root / "Pic/2026-11/Ori" / f"{digest}.png"
            second = root / "Emoji/emoji-recv/2026-11/Ori" / f"{digest}_0.png"
            first.parent.mkdir(parents=True)
            second.parent.mkdir(parents=True)
            first.write_bytes(JPEG)
            second.write_bytes(png_size(32, 24))
            cache = MediaCache(root)
            params = {"type":"image", "md5":digest, "quality":"preview"}
            self.assertIsNone(resolve_media(cache, params)["file"])
            first_result = resolve_media(cache, {**params, "verifiedPreviewPath":str(first)})
            second_result = resolve_media(cache, {**params, "verifiedPreviewPath":str(second)})
            self.assertEqual(first_result["file"], str(first.resolve()))
            self.assertEqual(second_result["file"], str(second.resolve()))
            self.assertEqual((second_result["width"], second_result["height"]), (32, 24))
            self.assertIsNone(resolve_media(cache, params)["file"])
            self.assertEqual(resolve_media(cache, {**params, "verifiedPreviewPath":str(first)}), first_result)

    def test_verified_preview_parameter_is_internal_preview_only(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = MediaCache(Path(folder))
            params = {"type":"image", "md5":"a" * 32}
            path = str(Path(folder) / "Pic/2026-11/Ori" / ("a" * 32 + ".png"))
            for request in (
                    {**params, "verifiedPreviewPath":path},
                    {**params, "quality":"original", "verifiedPreviewPath":path},
                    {"type":"marketFace", "emojiId":"a" * 32, "packageId":"42", "quality":"preview", "verifiedPreviewPath":path}):
                with self.subTest(request=request), self.assertRaisesRegex(ValueError, "verifiedPreviewPath"):
                    resolve_media(cache, request)
            for invalid in (None, True, False, 1, [], {}, "", "a\x00b"):
                with self.subTest(value=invalid), self.assertRaisesRegex(ValueError, "verifiedPreviewPath"):
                    resolve_media(cache, {**params, "quality":"preview", "verifiedPreviewPath":invalid})

    def test_verified_preview_rejects_wrong_account_identity_and_cache_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "account-a/nt_data"
            digest = "a" * 32
            paths = (
                root / "Pic/2026-11/Ori" / ("b" * 32 + ".png"),
                root / "Pic/2026-11/Ori" / f"{digest}_other.png",
                root / "Pic/2026-11/Ori" / f"{digest}.png.extra",
                root / "Pic/2026-13/Ori" / f"{digest}.png",
                root / "Video/2026-11/Ori" / f"{digest}.png",
                root / "Emoji/marketface/42" / f"{digest}.png",
                root / "Pic/2026-11/Other" / f"{digest}.png",
                root / "Pic/2026-11/Ori/nested" / f"{digest}.png",
                root / "Pic/2026-11/Ori/../Ori" / f"{digest}.png",
                Path(folder) / "account-b/nt_data/Pic/2026-11/Ori" / f"{digest}.png",
                Path("Pic/2026-11/Ori") / f"{digest}.png",
            )
            for candidate in paths:
                cache = MediaCache(root)
                cache.indexes[False] = {}  # Exercise the independent native-path checks.
                with self.subTest(path=str(candidate)), self.assertRaisesRegex(ValueError, "当前图片缓存"):
                    resolve_media(cache, {"type":"image", "md5":digest, "quality":"preview", "verifiedPreviewPath":str(candidate)})

    def test_verified_preview_checks_symlink_target_identity_and_account(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "account-a/nt_data"
            digest = "a" * 32
            targets = (
                root / "Pic/2026-12/Ori" / ("b" * 32 + ".png"),
                Path(folder) / "account-b/nt_data/Pic/2026-11/Ori" / f"{digest}.png",
                root / "Other/2026-11/Ori" / f"{digest}.png",
            )
            for index, target in enumerate(targets):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(JPEG)
                link = root / "Pic/2026-11/Ori" / f"{digest}_{index}.png"
                link.parent.mkdir(parents=True, exist_ok=True)
                try:
                    link.symlink_to(target)
                except OSError as error:
                    self.skipTest(f"symlinks unavailable: {error.errno}")
                cache = MediaCache(root)
                cache.indexes[False] = {}
                with self.subTest(target=index), self.assertRaisesRegex(ValueError, "当前图片缓存"):
                    resolve_media(cache, {"type":"image", "md5":digest, "quality":"preview", "verifiedPreviewPath":str(link)})
            # Checking only realpath would also allow an alias from outside the
            # account to point inward. The original path must be in bounds too.
            valid = root / "Pic/2026-11/Ori" / f"{digest}.png"
            valid.write_bytes(JPEG)
            outside = Path(folder) / f"{digest}.png"
            outside.symlink_to(valid)
            with self.assertRaisesRegex(ValueError, "当前图片缓存"):
                resolve_media(MediaCache(root), {"type":"image", "md5":digest, "quality":"preview", "verifiedPreviewPath":str(outside)})

    def test_verified_preview_rechecks_resolved_paths_without_symlink_privileges(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "account-a/nt_data"
            digest = "a" * 32
            candidate = root / "Pic/2026-11/Ori" / f"{digest}.png"
            cache = MediaCache(root)
            cache.indexes[False] = {}
            params = {"type":"image", "md5":digest, "quality":"preview", "verifiedPreviewPath":str(candidate)}
            for target in (
                    root / "Pic/2026-11/Ori" / ("b" * 32 + ".png"),
                    root / "Other/2026-11/Ori" / f"{digest}.png",
                    Path(folder) / "account-b/nt_data/Pic/2026-11/Ori" / f"{digest}.png"):
                with self.subTest(target=str(target)), patch.object(Path, "resolve", return_value=target) as resolve:
                    with self.assertRaisesRegex(ValueError, "当前图片缓存"):
                        resolve_media(cache, params)
                    resolve.assert_called_once_with(strict=True)
            # A symlink that preserves both the account and exact media identity
            # is acceptable. Authorization is not inferred from the alias alone.
            target = root / "Emoji/emoji-recv/2026-12/Ori" / f"{digest}_0.png"
            target.parent.mkdir(parents=True)
            target.write_bytes(JPEG)
            with patch.object(Path, "resolve", return_value=target):
                result = resolve_media(cache, params)
            self.assertEqual(result["file"], str(target))
            self.assertTrue(result["requiresDecode"])

    def test_verified_preview_rejects_bad_headers_dimensions_and_byte_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            digest = "a" * 32
            preview = root / "Pic/2026-11/Ori" / f"{digest}.png"
            preview.parent.mkdir(parents=True)
            params = {"type":"image", "md5":digest, "quality":"preview", "verifiedPreviewPath":str(preview)}
            for data in (b"not an image", b"\xff\xd8\xff", png_size(0, 1), png_size(1, 0), png_size(8001, 8000)):
                preview.write_bytes(data)
                with self.subTest(data=data[:32]):
                    result = resolve_media(MediaCache(root), params)
                    self.assertIsNone(result["file"])
                    self.assertNotIn("requiresDecode", result)
                    self.assertFalse(result["originalAvailable"])
            preview.write_bytes(JPEG)
            with self.assertRaisesRegex(ValueError, "大小上限"):
                resolve_media(MediaCache(root), {**params, "maxBytes":len(JPEG) - 1})
            self.assertTrue(resolve_media(MediaCache(root), {**params, "maxBytes":len(JPEG)})["requiresDecode"])
            self.assertEqual(MAX_PREVIEW_PIXELS, 8000 * 8000)
            preview.write_bytes(png_size(8000, 8000))
            self.assertTrue(resolve_media(MediaCache(root), params)["requiresDecode"])
            preview.unlink()
            self.assertIsNone(resolve_media(MediaCache(root), params)["file"])

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
