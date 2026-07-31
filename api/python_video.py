"""Vercel Python Function：分段代理下载小红书视频。"""

from __future__ import annotations

import json
import re
import socket
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


MAX_CHUNK_BYTES = 3_500_000
MAX_VIDEO_BYTES = 512 * 1024 * 1024


class XhsError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def normalize_url(value: str) -> str:
    url = str(value or "").strip().replace("\\/", "/")
    if url.startswith("http://"):
        url = "https://" + url[len("http://") :]
    return url


def is_xhs_video_url(value: str) -> bool:
    try:
        parsed = urlparse(normalize_url(value))
    except ValueError:
        return False
    host = parsed.netloc.lower()
    return bool(
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and (host == "xhscdn.com" or host.endswith(".xhscdn.com"))
        and len(parsed.path) > 1
    )


def parse_nonnegative_integer(value: str, name: str) -> int:
    if not re.fullmatch(r"\d+", str(value or "")):
        raise XhsError(f"{name} 参数无效。")
    number = int(value)
    if number < 0:
        raise XhsError(f"{name} 参数无效。")
    return number


def parse_content_range(value: str | None) -> dict[str, int] | None:
    match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", str(value or ""), re.I)
    if not match:
        return None
    return {
        "start": int(match.group(1)),
        "end": int(match.group(2)),
        "total": 0 if match.group(3) == "*" else int(match.group(3)),
    }


def open_video(source_url: str, range_header: str):
    request = Request(
        source_url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
            "Referer": "https://www.xiaohongshu.com/",
            "Range": range_header,
        },
        method="GET",
    )
    try:
        response = urlopen(request, timeout=18)
        if not is_xhs_video_url(response.geturl()):
            response.close()
            raise XhsError("视频 CDN 跳转到了不受支持的地址。", 502)
        return response
    except HTTPError as error:
        # urllib 会把 4xx/5xx 转成异常；206 不会。
        raise XhsError(f"视频服务器返回 HTTP {error.code}。", 502) from error
    except (URLError, TimeoutError, socket.timeout) as error:
        reason = getattr(error, "reason", error)
        raise XhsError(f"读取视频失败：{reason}", 502) from error


def read_limited(response, limit: int) -> bytes:  # noqa: ANN001
    declared = response.headers.get("Content-Length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise XhsError("视频分段超过服务器单次响应限制。", 413)

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(256 * 1024, limit - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise XhsError("视频分段超过服务器单次响应限制。", 413)
        chunks.append(chunk)
    return b"".join(chunks)


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-XHS-Engine", "python")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Allow", "GET, OPTIONS")
        self.end_headers()

    def do_POST(self) -> None:
        self._send_json(405, {"success": False, "message": "只支持 GET 请求。"})

    def do_GET(self) -> None:
        try:
            query = parse_qs(urlparse(self.path).query)
            source_url = normalize_url((query.get("url") or [""])[0])
            action = (query.get("action") or ["meta"])[0]

            if not is_xhs_video_url(source_url):
                raise XhsError("视频地址无效或不属于小红书 CDN。")

            if action == "meta":
                with open_video(source_url, "bytes=0-0") as response:
                    status = getattr(response, "status", response.getcode())
                    if status not in (200, 206):
                        raise XhsError(f"视频服务器返回 HTTP {status}。", 502)
                    content_range = parse_content_range(
                        response.headers.get("Content-Range")
                    )
                    content_length = int(
                        response.headers.get("Content-Length", "0") or 0
                    )
                    size = (
                        content_range["total"]
                        if content_range and content_range["total"]
                        else content_length if status == 200 else 0
                    )
                    content_type = (
                        response.headers.get_content_type() or "video/mp4"
                    )
                    accept_ranges = bool(
                        status == 206
                        or response.headers.get("Accept-Ranges", "").lower() == "bytes"
                    )

                if size > MAX_VIDEO_BYTES:
                    raise XhsError(
                        "视频超过 512 MB，浏览器本地合并可能占用过多内存。",
                        413,
                    )

                self._send_json(
                    200,
                    {
                        "success": True,
                        "engine": "python",
                        "size": size,
                        "contentType": content_type,
                        "acceptRanges": accept_ranges,
                        "chunkSize": MAX_CHUNK_BYTES,
                    },
                )
                return

            if action != "chunk":
                raise XhsError("不支持的视频操作。")

            start = parse_nonnegative_integer((query.get("start") or [""])[0], "start")
            end = parse_nonnegative_integer((query.get("end") or [""])[0], "end")
            if end < start:
                raise XhsError("视频分段范围无效。")
            if end - start + 1 > MAX_CHUNK_BYTES:
                raise XhsError(
                    f"单个视频分段不能超过 {MAX_CHUNK_BYTES} 字节。", 413
                )

            with open_video(source_url, f"bytes={start}-{end}") as response:
                status = getattr(response, "status", response.getcode())
                if status not in (200, 206):
                    raise XhsError(f"视频服务器返回 HTTP {status}。", 502)

                declared = int(response.headers.get("Content-Length", "0") or 0)
                if status == 200 and start > 0:
                    raise XhsError(
                        "视频源不支持 Range 分段下载，请使用“打开视频”。", 409
                    )
                if status == 200 and declared > MAX_CHUNK_BYTES:
                    raise XhsError(
                        "视频源不支持 Range 分段下载，请使用“打开视频”。", 409
                    )

                content_range = parse_content_range(
                    response.headers.get("Content-Range")
                )
                content_type = (
                    response.headers.get_content_type() or "application/octet-stream"
                )
                body = read_limited(response, MAX_CHUNK_BYTES)

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "private, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-XHS-Engine", "python")
            if content_range:
                total = content_range["total"] or "*"
                self.send_header(
                    "Content-Range",
                    f'bytes {content_range["start"]}-{content_range["end"]}/{total}',
                )
                if content_range["total"]:
                    self.send_header("X-Video-Total", str(content_range["total"]))
            self.end_headers()
            self.wfile.write(body)
        except XhsError as error:
            self._send_json(error.status_code, {"success": False, "message": str(error)})
        except Exception as error:  # noqa: BLE001
            print("python video error", repr(error))
            self._send_json(
                500,
                {"success": False, "message": "Python 视频下载失败。"},
            )
