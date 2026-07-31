"""Vercel Python Function：代理下载无水印原图。"""

from __future__ import annotations

import json
import re
import socket
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen


MAX_IMAGE_BYTES = 4_200_000


class XhsError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def validate_asset_token(token: object) -> bool:
    return bool(
        isinstance(token, str)
        and 1 <= len(token) <= 400
        and not token.startswith("/")
        and ".." not in token
        and "\\" not in token
        and re.fullmatch(r"[A-Za-z0-9/_~.\-]+", token)
    )


def build_no_watermark_url(token: str) -> str:
    if not validate_asset_token(token):
        raise XhsError("图片资源标识无效。")
    encoded = "/".join(quote(part, safe="-_.~") for part in token.split("/"))
    return f"https://ci.xiaohongshu.com/{encoded}?imageView2/format/jpg"


def safe_filename(value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "image.jpg"))[:80]
    return name or "image.jpg"


def read_limited(response) -> bytes:  # noqa: ANN001
    declared = response.headers.get("Content-Length")
    if declared and declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
        raise XhsError("原图超过 Vercel 单次响应限制，请使用原图直链下载。", 413)

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(256 * 1024, MAX_IMAGE_BYTES - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_IMAGE_BYTES:
            raise XhsError("原图超过 Vercel 单次响应限制，请使用原图直链下载。", 413)
        chunks.append(chunk)
    return b"".join(chunks)


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
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
            token = (query.get("token") or [""])[0]
            filename = safe_filename((query.get("name") or ["image.jpg"])[0])
            if not validate_asset_token(token):
                raise XhsError("图片资源标识无效。")

            request = Request(
                build_no_watermark_url(token),
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": "https://www.xiaohongshu.com/",
                },
                method="GET",
            )

            try:
                with urlopen(request, timeout=15) as response:
                    content_type = response.headers.get_content_type() or "image/jpeg"
                    if not content_type.startswith("image/") and content_type != "application/octet-stream":
                        raise XhsError("原图服务器返回的不是图片。", 502)
                    body = read_limited(response)
            except XhsError:
                raise
            except HTTPError as error:
                raise XhsError(f"原图服务器返回 HTTP {error.code}。", 502) from error
            except (URLError, TimeoutError, socket.timeout) as error:
                reason = getattr(error, "reason", error)
                raise XhsError(f"下载原图失败：{reason}", 502) from error

            response_type = "image/jpeg" if content_type == "application/octet-stream" else content_type
            self.send_response(200)
            self.send_header("Content-Type", response_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "private, max-age=300")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-XHS-Engine", "python")
            self.end_headers()
            self.wfile.write(body)
        except XhsError as error:
            self._send_json(error.status_code, {"success": False, "message": str(error)})
        except Exception as error:  # noqa: BLE001
            print("python image error", repr(error))
            self._send_json(500, {"success": False, "message": "Python 图片下载失败。"})
