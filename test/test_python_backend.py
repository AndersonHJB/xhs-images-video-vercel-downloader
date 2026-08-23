from __future__ import annotations

import importlib.util
import json
import re
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

    def test_mobile_short_link_input_and_host_boundary(self) -> None:
        short_url = "https://xhslink.cn/o/2KYMK6MAHx9"
        desktop_url = (
            "https://www.xiaohongshu.com/discovery/item/"
            "6a657da9000000000f02b94a?source=webshare&xhsshare=pc_web"
            "&xsec_token=desktop-token="
        )
        escaped_desktop_url = re.sub(
            r"([_&=])", r"\\\1", desktop_url
        )
        self.assertEqual(
            python_parse.extract_input_url(
                f"从离职后，我开始做编程私教 {short_url} "
                "直达【小红书】看看这篇分享~"
            ),
            short_url,
        )
        self.assertEqual(
            python_parse.extract_input_url(f"[{short_url}]({short_url})"),
            short_url,
        )
        self.assertEqual(
            python_parse.extract_input_url(
                f"79 【Python一对一教学】 "
                f"[{escaped_desktop_url}]({escaped_desktop_url})"
            ),
            desktop_url,
        )
        self.assertEqual(
            python_parse.extract_input_url(
                f"先忽略 https://example.com/docs 再打开 {short_url}"
            ),
            short_url,
        )
        self.assertTrue(python_parse.is_allowed_page_host("xhslink.cn"))
        self.assertTrue(python_parse.is_allowed_page_host("www.xhslink.cn"))
        self.assertFalse(
            python_parse.is_allowed_page_host("xhslink.cn.example.com")
        )
        with self.assertRaisesRegex(python_parse.XhsError, "只支持小红书分享链接"):
            python_parse.extract_input_url(
                "https://xhslink.cn.example.com/o/fake"
            )
        for unsafe_url in (
            "https://user:password@xhslink.cn/o/fake",
            "https://xhslink.cn:8443/o/fake",
        ):
            with self.assertRaisesRegex(
                python_parse.XhsError,
                "只支持小红书分享链接",
            ):
                python_parse.extract_input_url(unsafe_url)

        self.assertTrue(python_parse.is_allowed_page_url(short_url))
        self.assertFalse(
            python_parse.is_allowed_page_url(
                "http://www.xiaohongshu.com/discovery/item/"
                "668d2967000000002500100a"
            )
        )
        redirect_handler = python_parse.SafeRedirectHandler()
        with self.assertRaisesRegex(
            python_parse.XhsError,
            "跳转到了不受支持的地址",
        ):
            redirect_handler.redirect_request(
                python_parse.Request(short_url),
                None,
                302,
                "Found",
                {},
                "http://www.xiaohongshu.com/discovery/item/"
                "668d2967000000002500100a",
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
                            "desc": "目标正文\r\n第二行 #目标",
                            "imageList": make_image_list("target", 7),
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "title": "相关推荐",
                            "desc": "推荐正文（禁止返回）",
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
        self.assertEqual(parsed["content"], "目标正文\n第二行 #目标")
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
            '<meta name="description" content="页面描述也不能作为当前文案">'
            f'<script>{{"noteId":"{target_id}","desc":"局部正文不可猜测",'
            f'BROKEN,"imageList":{target_list}}}</script>'
            + ("x" * 70000)
            + f'<script>{{"noteId":"bbbbbbbbbbbbbbbbbbbbbbbb","imageList":{other_list}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(parsed["content"], "")
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


    def test_only_target_note_video(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        other_id = "bbbbbbbbbbbbbbbbbbbbbbbb"

        def video_url(identifier: str) -> str:
            return f"https://sns-video-bd.xhscdn.com/stream/{identifier}.mp4"

        def stream(identifier: str, width: int, height: int) -> dict[str, object]:
            return {
                "masterUrl": video_url(identifier),
                "backupUrls": [video_url(identifier + "-backup")],
                "videoCodec": "h264",
                "width": width,
                "height": height,
                "videoBitrate": 4_000_000,
                "size": 12_000_000,
            }

        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "目标视频",
                            "desc": "目标视频正文",
                            "type": "video",
                            "imageList": make_image_list("video-cover", 1),
                            "video": {
                                "media": {
                                    "stream": {
                                        "h264": [
                                            stream("target-1080", 1920, 1080),
                                            stream("target-720", 1280, 720),
                                        ]
                                    }
                                }
                            },
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "title": "推荐视频",
                            "desc": "推荐视频正文（禁止返回）",
                            "video": {
                                "media": {
                                    "stream": {
                                        "h264": [stream("other-video", 3840, 2160)]
                                    }
                                }
                            },
                        }
                    },
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )
        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(parsed["title"], "目标视频")
        self.assertEqual(parsed["content"], "目标视频正文")
        self.assertEqual(len(parsed["images"]), 1)
        self.assertEqual(len(parsed["videos"]), 2)
        self.assertTrue(
            all("target-" in video["url"] for video in parsed["videos"])
        )
        self.assertFalse(
            any("other-video" in video["url"] for video in parsed["videos"])
        )
        self.assertEqual(len(parsed["videos"][0]["backupUrls"]), 1)

    def test_video_only_note_without_image_list(self) -> None:
        target_id = "cccccccccccccccccccccccc"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "纯视频",
                            "type": "video",
                            "video": {
                                "media": {
                                    "stream": {
                                        "h264": [
                                            {
                                                "masterUrl": (
                                                    "https://sns-video-bd.xhscdn.com/"
                                                    "stream/video-only.mp4"
                                                ),
                                                "videoCodec": "h264",
                                                "width": 1080,
                                                "height": 1920,
                                                "size": 10_000_000,
                                            }
                                        ]
                                    }
                                }
                            },
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, separators=(",", ":"))
            + "</script>"
        )
        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["images"], [])
        self.assertEqual(len(parsed["videos"]), 1)
        self.assertIn("video-only", parsed["videos"][0]["url"])

    def test_missing_target_content_does_not_use_recommendations(self) -> None:
        target_id = "dddddddddddddddddddddddd"
        other_id = "eeeeeeeeeeeeeeeeeeeeeeee"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "无正文目标帖",
                            "imageList": make_image_list("no-desc", 1),
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "desc": "推荐正文（禁止返回）",
                            "imageList": make_image_list("recommended-desc", 10),
                        }
                    },
                }
            }
        }
        page_html = (
            '<meta name="description" content="页面描述（禁止返回）">'
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(parsed["content"], "")

    def test_content_unicode_limit_and_description_alias(self) -> None:
        target_id = "ffffffffffffffffffffffff"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "Unicode 文案",
                            "desc": "   ",
                            "description": "  " + ("😀" * 10001) + "  ",
                            "imageList": make_image_list("unicode", 1),
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(len(parsed["content"]), 10000)
        self.assertTrue(parsed["content"].endswith("😀"))



if __name__ == "__main__":
    unittest.main()
