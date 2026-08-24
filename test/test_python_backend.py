from __future__ import annotations

import importlib.util
import io
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "api" / "python_parse.py"
SPEC = importlib.util.spec_from_file_location("python_parse", MODULE_PATH)
assert SPEC and SPEC.loader
python_parse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(python_parse)

VIDEO_MODULE_PATH = ROOT / "api" / "python_video.py"
VIDEO_SPEC = importlib.util.spec_from_file_location("python_video", VIDEO_MODULE_PATH)
assert VIDEO_SPEC and VIDEO_SPEC.loader
python_video = importlib.util.module_from_spec(VIDEO_SPEC)
VIDEO_SPEC.loader.exec_module(python_video)


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


def live_photo_video_url(host: str, identifier: str) -> str:
    return f"http://{host}/stream/{identifier}.mp4"


def make_live_photo_image(
    identifier: str,
    *,
    live_photo: bool | None = True,
    stream: bool = True,
    stream_key: str = "h264",
    stream_field: str = "stream",
) -> dict[str, object]:
    image: dict[str, object] = {
        "urlDefault": image_url(identifier),
        "urlPre": image_url(identifier, "!nd_prv_wlteh_webp_3"),
    }
    if live_photo is not None:
        image["livePhoto"] = live_photo
    if stream:
        image[stream_field] = {
            stream_key: [
                {
                    "masterUrl": live_photo_video_url(
                        "sns-video-zl.xhscdn.com", identifier
                    ),
                    "backupUrls": [
                        live_photo_video_url(
                            "sns-bak-v8.xhscdn.com", identifier
                        ),
                        live_photo_video_url(
                            "sns-bak-v10.xhscdn.com", identifier
                        ),
                    ],
                    "videoCodec": stream_key,
                    "width": 1080,
                    "height": 1920,
                    "videoBitrate": 2_300_000,
                    "size": 800_000,
                    "duration": 2800,
                    "videoDuration": 2750,
                    "qualityType": "HD",
                }
            ]
        }
    return image


class PythonBackendTests(unittest.TestCase):
    def test_video_url_port_and_malformed_image_token_safety(self) -> None:
        self.assertFalse(
            python_parse.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:8443/stream/live.mp4"
            )
        )
        self.assertTrue(
            python_parse.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:443/stream/live.mp4"
            )
        )
        self.assertFalse(
            python_video.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:8443/stream/live.mp4"
            )
        )
        self.assertTrue(
            python_video.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:443/stream/live.mp4"
            )
        )
        self.assertIsNone(
            python_parse.extract_original_asset_token(
                "https://sns-webpic-qc.xhscdn.com/%E0%A4%A"
            )
        )
        self.assertFalse(
            python_parse.is_xhs_image_url("https://evilxhscdn.com/image.jpg")
        )
        self.assertFalse(
            python_parse.is_direct_image_url(
                "https://user:pass@sns-webpic-qc.xhscdn.com:8443/image.jpg"
            )
        )

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

    def test_live_photos_stay_paired_and_exclude_recommendations(self) -> None:
        target_id = "6a81c37e0000000025016000"
        other_id = "bbbbbbbbbbbbbbbbbbbbbbbb"
        state = {
            "noteData": {
                "data": {
                    "noteData": {
                        "noteId": target_id,
                        "type": "normal",
                        "title": "混合实况帖子",
                        "imageList": [
                            make_image_list("static", 1)[0],
                            make_live_photo_image("live-flagged"),
                            make_live_photo_image(
                                "live-inferred",
                                live_photo=None,
                            ),
                        ],
                    },
                    "relatedNotes": [
                        {
                            "noteId": other_id,
                            "title": "推荐实况帖子",
                            "imageList": [
                                make_live_photo_image("recommend-live")
                            ],
                        }
                    ],
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
        self.assertEqual(
            [image["token"] for image in parsed["images"]],
            ["static01", "live-flagged", "live-inferred"],
        )
        self.assertEqual(
            [bool(image["livePhoto"]) for image in parsed["images"]],
            [False, True, True],
        )
        self.assertIsNone(parsed["images"][0]["liveVideo"])
        self.assertEqual(
            parsed["images"][1]["liveVideo"]["url"],
            "https://sns-video-zl.xhscdn.com/stream/live-flagged.mp4",
        )
        self.assertEqual(
            parsed["images"][1]["liveVideo"]["backupUrls"],
            [
                "https://sns-bak-v8.xhscdn.com/stream/live-flagged.mp4",
                "https://sns-bak-v10.xhscdn.com/stream/live-flagged.mp4",
            ],
        )
        self.assertEqual(parsed["images"][1]["liveVideo"]["duration"], 2750)
        self.assertNotIn("recommend-live", json.dumps(parsed["images"]))
        self.assertEqual(parsed["videos"], [])

    def test_all_live_photo_codecs_and_stream_aliases(self) -> None:
        target_id = "live-codecs-stream-aliases"
        codecs_and_fields = (
            ("h264", "stream"),
            ("h265", "livePhotoStream"),
            ("h266", "live_photo_stream"),
            ("av1", "stream"),
        )
        image_list = [
            make_live_photo_image(
                f"live-{codec}",
                live_photo=None,
                stream_key=codec,
                stream_field=stream_field,
            )
            for codec, stream_field in codecs_and_fields
        ]
        image_list[1]["stream"] = {}
        h266_root = image_list[2]["live_photo_stream"]
        h266_root["h266"] = h266_root["h266"][0]
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "imageList": image_list,
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

        self.assertEqual(
            [image["liveVideo"]["codec"] for image in parsed["images"]],
            ["h264", "h265", "h266", "av1"],
        )
        self.assertTrue(all(image["livePhoto"] for image in parsed["images"]))
        self.assertEqual(parsed["videos"], [])

    def test_live_photo_string_flags_are_parsed_strictly(self) -> None:
        self.assertFalse(
            python_parse.is_live_photo_item({"livePhoto": "false"})
        )
        self.assertFalse(
            python_parse.is_live_photo_item({"live_photo": " 0 "})
        )
        self.assertTrue(
            python_parse.is_live_photo_item({"isLivePhoto": " TRUE "})
        )
        self.assertTrue(
            python_parse.is_live_photo_item({"is_live_photo": "1"})
        )

    def test_duplicate_static_image_keeps_each_live_stream(self) -> None:
        target_id = "duplicate-static-live-001"
        first = make_live_photo_image("shared-static-first-live")
        second = make_live_photo_image("second-live")
        second["urlDefault"] = first["urlDefault"]
        second["urlPre"] = first["urlPre"]
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "重复静态图实况帖子",
                            "imageList": [first, second],
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

        self.assertEqual(
            [image["token"] for image in parsed["images"]],
            ["shared-static-first-live", "shared-static-first-live"],
        )
        self.assertEqual(
            [image["liveVideo"]["url"] for image in parsed["images"]],
            [
                "https://sns-video-zl.xhscdn.com/stream/"
                "shared-static-first-live.mp4",
                "https://sns-video-zl.xhscdn.com/stream/second-live.mp4",
            ],
        )

    def test_live_photo_flag_without_stream_keeps_only_the_flag(self) -> None:
        target_id = "liveflagwithoutstream0001"
        flagged = make_live_photo_image("flag-only", stream=False)
        flagged["livePhoto"] = False
        flagged["is_live_photo"] = True
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "只有实况标记",
                            "imageList": [flagged],
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

        self.assertEqual(len(parsed["images"]), 1)
        self.assertTrue(parsed["images"][0]["livePhoto"])
        self.assertIsNone(parsed["images"][0]["liveVideo"])
        self.assertEqual(parsed["videos"], [])

    def test_live_photo_api_output_includes_pair_metadata(self) -> None:
        target_id = "api-live-photo-00000001"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "API 实况帖子",
                            "imageList": [make_live_photo_image("api-live")],
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
        source_url = (
            "https://www.xiaohongshu.com/discovery/item/" + target_id
        )
        request_body = json.dumps({"text": source_url}).encode("utf-8")
        sent: list[tuple[int, dict[str, object]]] = []
        request_handler = python_parse.handler.__new__(python_parse.handler)
        request_handler.headers = {"Content-Length": str(len(request_body))}
        request_handler.rfile = io.BytesIO(request_body)
        request_handler._send_json = (  # type: ignore[method-assign]
            lambda status_code, payload: sent.append((status_code, payload))
        )

        with patch.object(
            python_parse,
            "fetch_note_page",
            return_value=(source_url, page_html),
        ):
            request_handler.do_POST()

        self.assertEqual(len(sent), 1)
        status_code, payload = sent[0]
        self.assertEqual(status_code, 200)
        self.assertEqual(payload["livePhotoCount"], 1)
        self.assertEqual(payload["videoCount"], 0)
        self.assertEqual(payload["videos"], [])
        image = payload["images"][0]
        self.assertTrue(image["livePhoto"])
        self.assertEqual(image["liveVideo"]["codec"], "h264")
        self.assertEqual(image["liveVideo"]["duration"], 2750)
        self.assertNotIn("source", image["liveVideo"])

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

    def test_local_fallback_is_object_bound_and_excludes_live_video_urls(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        target_list = (
            '[{"urlDefault":"'
            + image_url("fallback-static")
            + '"},BROKEN,{"masterUrl":"'
            + live_photo_video_url(
                "sns-video-zl.xhscdn.com", "fallback-live"
            )
            + '"}]'
        )
        recommended_list = json.dumps(
            make_image_list("recommended", 1), separators=(",", ":")
        )
        recommended_video = json.dumps(
            {
                "media": {
                    "stream": {
                        "h264": [
                            {
                                "masterUrl": live_photo_video_url(
                                    "sns-video-zl.xhscdn.com",
                                    "recommended-video",
                                )
                            }
                        ]
                    }
                }
            },
            separators=(",", ":"),
        )
        page_html = (
            f'<script>{{"noteId":"{target_id}","padding":"'
            + ("x" * 1200)
            + f'",BROKEN,"imageList":{target_list}}}</script>'
            + f'<script>{{"trackingCurrentId":"{target_id}",'
            + f'"imageList":{recommended_list},"video":{recommended_video}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(
            [image["token"] for image in parsed["images"]],
            ["fallback-static"],
        )
        self.assertIsNone(parsed["images"][0]["liveVideo"])
        self.assertEqual(parsed["videos"], [])

    def test_local_fallback_ignores_nested_recommended_media(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        recommended_list = json.dumps(
            make_image_list("nested-recommended", 1), separators=(",", ":")
        )
        recommended_video = json.dumps(
            {
                "media": {
                    "stream": {
                        "h264": [
                            {
                                "masterUrl": live_photo_video_url(
                                    "sns-video-zl.xhscdn.com",
                                    "nested-recommended-video",
                                )
                            }
                        ]
                    }
                }
            },
            separators=(",", ":"),
        )
        target_list = json.dumps(
            make_image_list("nested-target", 2), separators=(",", ":")
        )
        page_html = (
            f'<script>{{"noteId":"{target_id}","related":'
            f'[{{"imageList":{recommended_list},"video":{recommended_video}}}],'
            '"padding":"'
            + ("x" * 1200)
            + f'",BROKEN,"imageList":{target_list}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(len(parsed["images"]), 2)
        self.assertTrue(
            all(
                image["token"].startswith("nested-target")
                for image in parsed["images"]
            )
        )
        self.assertTrue(
            all(
                "recommended" not in image["token"]
                for image in parsed["images"]
            )
        )
        self.assertEqual(parsed["videos"], [])

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
