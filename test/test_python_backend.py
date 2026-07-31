from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "api" / "python_parse.py"
SPEC = importlib.util.spec_from_file_location("python_parse", MODULE_PATH)
assert SPEC and SPEC.loader
python_parse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(python_parse)


def image_url(identifier: str, variant: str = "!nd_dft_wlteh_webp_3") -> str:
    return (
        "https://sns-webpic-qc.xhscdn.com/"
        f"202607301856/signature/{identifier}{variant}"
    )


def make_image_list(prefix: str, count: int) -> list[dict[str, str]]:
    return [
        {
            "urlDefault": image_url(f"{prefix}{index:02d}"),
            "urlPre": image_url(
                f"{prefix}{index:02d}",
                "!nd_prv_wlteh_webp_3",
            ),
        }
        for index in range(1, count + 1)
    ]


class PythonBackendTests(unittest.TestCase):
    def test_extract_note_id(self) -> None:
        self.assertEqual(
            python_parse.extract_note_id(
                "https://www.xiaohongshu.com/discovery/item/"
                "6a68c6d3000000001303f099?source=webshare"
            ),
            "6a68c6d3000000001303f099",
        )
        self.assertEqual(
            python_parse.extract_note_id(
                "https://www.xiaohongshu.com/explore/1234567890abcdef12345678"
            ),
            "1234567890abcdef12345678",
        )

    def test_only_target_note_images(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        other_id = "aaaaaaaaaaaaaaaaaaaaaaaa"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "目标帖子",
                            "imageList": make_image_list("target", 7),
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "title": "相关推荐",
                            "imageList": make_image_list("other", 15),
                        }
                    },
                }
            },
            "recommendations": make_image_list("recommend", 20),
        }
        page_html = (
            "<!doctype html><html><head>"
            f'<meta property="og:image" content="{image_url("cover")}">'
            "</head><body><script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script></body></html>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(parsed["title"], "目标帖子")
        self.assertEqual(len(parsed["images"]), 7)
        self.assertTrue(
            all(image["token"].startswith("target") for image in parsed["images"])
        )
        self.assertFalse(
            any(image["token"].startswith("other") for image in parsed["images"])
        )

    def test_undefined_in_initial_state(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        image_list = json.dumps(make_image_list("undef", 3), separators=(",", ":"))
        page_html = (
            '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"'
            + target_id
            + '":{"note":{"noteId":"'
            + target_id
            + '","title":"带 undefined","extra":undefined,"imageList":'
            + image_list
            + "}}}}}</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["title"], "带 undefined")
        self.assertEqual(len(parsed["images"]), 3)

    def test_local_fallback_stays_near_target_id(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        target_list = json.dumps(make_image_list("local", 4), separators=(",", ":"))
        other_list = json.dumps(make_image_list("far", 12), separators=(",", ":"))
        page_html = (
            f'<script>{{"noteId":"{target_id}",BROKEN,"imageList":{target_list}}}</script>'
            + ("x" * 70000)
            + f'<script>{{"noteId":"bbbbbbbbbbbbbbbbbbbbbbbb","imageList":{other_list}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(len(parsed["images"]), 4)
        self.assertTrue(
            all(image["token"].startswith("local") for image in parsed["images"])
        )

    def test_no_watermark_conversion(self) -> None:
        source = (
            "https://sns-webpic-qc.xhscdn.com/202607301856/"
            "4660835de850fe69d5c6322b7bb9204c/"
            "0302aq01kizxyauaerw011cracc0u44f1g!nd_dft_wlteh_webp_3"
        )
        token = python_parse.extract_original_asset_token(source)
        self.assertEqual(token, "0302aq01kizxyauaerw011cracc0u44f1g")
        self.assertEqual(
            python_parse.build_no_watermark_url(token),
            "https://ci.xiaohongshu.com/"
            "0302aq01kizxyauaerw011cracc0u44f1g?imageView2/format/jpg",
        )


if __name__ == "__main__":
    unittest.main()
