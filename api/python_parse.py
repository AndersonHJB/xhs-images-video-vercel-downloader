"""Vercel Python Function：抓取并解析当前小红书图文笔记。

仅使用 Python 标准库，避免额外依赖和更大的冷启动体积。
"""

from __future__ import annotations

import html as html_lib
import json
import re
import socket
from http.server import BaseHTTPRequestHandler
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


URL_PATTERN = re.compile(r"https?://[^\s<>'\"，。！？、]+", re.I)
XHS_IMAGE_PATTERN = re.compile(
    r"https?:(?:(?:\\u002[fF])|(?:\\/)|/){2}"
    r"[^\"'<>\\\s]+?(?:xhscdn\.com|ci\.xiaohongshu\.com)"
    r"[^\"'<>\\\s]*",
    re.I,
)
HIGH_QUALITY_PATTERN = re.compile(
    r"!nd_dft_wlteh_(?:webp|jpg|jpeg|png)_3(?:$|[?#])",
    re.I,
)
NOTE_ID_PATTERN = re.compile(
    r"/(?:discovery/item|explore|item)/([A-Za-z0-9_-]{12,64})(?:/|$)",
    re.I,
)
IMAGE_LIST_KEY_PATTERN = re.compile(r'["\']imageList["\']\s*:\s*\[')
INITIAL_STATE_PATTERN = re.compile(r"(?:window\.)?__INITIAL_STATE__\s*=\s*")
INITIAL_STATE_SCRIPT_PATTERN = re.compile(
    r"<script\b[^>]*\bid=[\"']__INITIAL_STATE__[\"'][^>]*>"
    r"([\s\S]*?)</script>",
    re.I,
)

PAGE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
        "Mobile/15E148 Safari/604.1"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}
DIRECT_IMAGE_HOSTS = {
    "sns-webpic-qc.xhscdn.com",
    "sns-webpic.xhscdn.com",
    "sns-img-hw.xhscdn.com",
    "sns-img-bd.xhscdn.com",
    "sns-img-al.xhscdn.com",
    "ci.xiaohongshu.com",
}
IMAGE_LIST_KEYS = ("imageList", "image_list", "images")
NOTE_WRAPPER_KEYS = ("note", "noteData", "note_data", "data")
MAX_HTML_BYTES = 6 * 1024 * 1024
MAX_INPUT_LENGTH = 3000


class XhsError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def normalize_image_url(raw: Any) -> str:
    value = html_lib.unescape(str(raw or "").strip().strip("\"'"))
    replacements = {
        "\\u002F": "/",
        "\\u002f": "/",
        "\\u0026": "&",
        "\\u003D": "=",
        "\\u003d": "=",
        "\\x26": "&",
        "\\/": "/",
    }
    for old, new in replacements.items():
        value = value.replace(old, new)
    value = value.rstrip("\\")
    if value.startswith("//"):
        value = "https:" + value
    if value.startswith("http://"):
        value = "https://" + value[len("http://") :]
    return value


def is_xhs_image_url(value: Any) -> bool:
    try:
        parsed = urlparse(normalize_image_url(value))
    except ValueError:
        return False
    host = parsed.netloc.lower()
    return parsed.scheme == "https" and (
        host.endswith("xhscdn.com") or host == "ci.xiaohongshu.com"
    )


def is_direct_image_url(value: str) -> bool:
    parsed = urlparse(normalize_image_url(value))
    return parsed.netloc.lower() in DIRECT_IMAGE_HOSTS


def is_allowed_page_host(hostname: str) -> bool:
    host = hostname.lower()
    return (
        host == "xhslink.com"
        or host.endswith(".xhslink.com")
        or host == "xiaohongshu.com"
        or host.endswith(".xiaohongshu.com")
    )


def extract_input_url(text: str) -> str:
    match = URL_PATTERN.search(text.strip())
    if not match:
        raise XhsError("没有检测到有效链接，请粘贴小红书分享文案或链接。")

    value = normalize_image_url(
        match.group(0).rstrip(".,;:!?)]}，。！？；：）】》")
    )
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc:
        raise XhsError("链接格式无效。")

    host = parsed.netloc.lower()
    if not is_allowed_page_host(host) and not is_xhs_image_url(value):
        raise XhsError("只支持小红书分享链接或小红书图片链接。")
    return value


def extract_note_id(value: str) -> str | None:
    try:
        path = urlparse(value).path
    except ValueError:
        return None
    match = NOTE_ID_PATTERN.search(path)
    return match.group(1) if match else None


def unique_keep_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        normalized = normalize_image_url(item).split("#", 1)[0]
        if not is_xhs_image_url(normalized) or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def image_quality_score(url: str) -> int:
    lower = normalize_image_url(url).lower()
    score = 0
    if HIGH_QUALITY_PATTERN.search(lower):
        score += 10000
    if "!nd_dft_" in lower:
        score += 5000
    if "_wlteh_webp_3" in lower:
        score += 3000
    if re.search(r"_(?:webp|jpg|jpeg|png)_3(?:$|[?#])", lower):
        score += 1500
    if "sns-webpic-qc.xhscdn.com" in lower:
        score += 600
    if "sns-img-" in lower or "ci.xiaohongshu.com" in lower:
        score += 500

    penalties = {
        "!nd_prv_": 7000,
        "preview": 5000,
        "thumbnail": 5000,
        "thumb": 4000,
        "_mw_1": 4500,
        "_webp_1": 3500,
        "_webp_2": 2500,
        "/avatar/": 10000,
        "avatar": 8000,
        "/head/": 8000,
    }
    for token, penalty in penalties.items():
        if token in lower:
            score -= penalty
    return score


def collect_urls(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, str):
        if is_xhs_image_url(value):
            found.append(value)
    elif isinstance(value, list):
        for item in value:
            found.extend(collect_urls(item))
    elif isinstance(value, dict):
        for item in value.values():
            found.extend(collect_urls(item))
    return found


def collect_urls_for_keys(value: Any, keys: set[str]) -> list[str]:
    found: list[str] = []
    if isinstance(value, list):
        for item in value:
            found.extend(collect_urls_for_keys(item, keys))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in keys:
                found.extend(collect_urls(item))
        for item in value.values():
            if isinstance(item, (list, dict)):
                found.extend(collect_urls_for_keys(item, keys))
    return found


def choose_one_url_per_image(image_list: Any) -> list[str]:
    if not isinstance(image_list, list):
        return []

    default_keys = {
        "urlDefault",
        "url_default",
        "defaultUrl",
        "default_url",
        "originUrl",
        "origin_url",
        "original",
        "originalUrl",
        "original_url",
    }
    normal_keys = {"url", "imageUrl", "image_url", "fileUrl", "file_url"}
    preview_keys = {
        "urlPre",
        "url_pre",
        "previewUrl",
        "preview_url",
        "thumbnail",
        "thumbnailUrl",
        "thumbnail_url",
    }

    selected: list[str] = []
    for item in image_list:
        defaults = unique_keep_order(collect_urls_for_keys(item, default_keys))
        normals = unique_keep_order(collect_urls_for_keys(item, normal_keys))
        previews = unique_keep_order(collect_urls_for_keys(item, preview_keys))
        all_urls = unique_keep_order(collect_urls(item))
        candidates = unique_keep_order(defaults + normals + all_urls + previews)
        if candidates:
            selected.append(max(candidates, key=image_quality_score))
    return unique_keep_order(selected)


def extract_balanced_structure(
    text: str, start: int, open_char: str, close_char: str
) -> tuple[str, int] | None:
    if start >= len(text) or text[start] != open_char:
        return None

    depth = 0
    in_string = False
    quote_char = ""
    escape = False

    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote_char:
                in_string = False
                quote_char = ""
            continue

        if char in {'"', "'"}:
            in_string = True
            quote_char = char
        elif char == open_char:
            depth += 1
        elif char == close_char:
            depth -= 1
            if depth == 0:
                return text[start : index + 1], index + 1
    return None


def replace_bare_js_values(text: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    quote_char = ""
    escape = False
    token_pattern = re.compile(r"^(?:undefined|NaN|-?Infinity)\b")

    while index < len(text):
        char = text[index]
        if in_string:
            output.append(char)
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote_char:
                in_string = False
                quote_char = ""
            index += 1
            continue

        if char in {'"', "'"}:
            in_string = True
            quote_char = char
            output.append(char)
            index += 1
            continue

        match = token_pattern.match(text[index:])
        if match:
            output.append("null")
            index += len(match.group(0))
            continue

        output.append(char)
        index += 1
    return "".join(output)


def parse_json_like(text: str) -> Any | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return json.loads(replace_bare_js_values(text))
        except json.JSONDecodeError:
            return None


def extract_initial_states(page_html: str) -> list[dict[str, Any]]:
    states: list[dict[str, Any]] = []
    seen_ranges: set[tuple[int, int]] = set()

    for match in INITIAL_STATE_PATTERN.finditer(page_html):
        start = page_html.find("{", match.end())
        if start < 0:
            continue
        balanced = extract_balanced_structure(page_html, start, "{", "}")
        if not balanced:
            continue
        structure, end = balanced
        range_key = (start, end)
        if range_key in seen_ranges:
            continue
        seen_ranges.add(range_key)
        parsed = parse_json_like(structure)
        if isinstance(parsed, dict):
            states.append(parsed)

    for match in INITIAL_STATE_SCRIPT_PATTERN.finditer(page_html):
        parsed = parse_json_like(html_lib.unescape(match.group(1).strip()))
        if isinstance(parsed, dict):
            states.append(parsed)
    return states


def object_has_target_id(value: Any, note_id: str) -> bool:
    if not isinstance(value, dict):
        return False
    identifiers = (
        value.get("noteId"),
        value.get("note_id"),
        value.get("id"),
        value.get("itemId"),
        value.get("item_id"),
    )
    return any(str(identifier or "") == note_id for identifier in identifiers)


def direct_image_list(value: Any) -> list[Any] | None:
    if not isinstance(value, dict):
        return None
    for key in IMAGE_LIST_KEYS:
        item = value.get(key)
        if isinstance(item, list):
            return item
    return None


def unwrap_note_candidates(
    value: Any, note_id: str, from_exact_map_key: bool = False
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if not isinstance(value, dict):
        return candidates

    if from_exact_map_key or object_has_target_id(value, note_id):
        candidates.append(value)

    for key in NOTE_WRAPPER_KEYS:
        wrapped = value.get(key)
        if not isinstance(wrapped, dict):
            continue
        if from_exact_map_key or object_has_target_id(wrapped, note_id):
            candidates.append(wrapped)
    return candidates


def get_path(root: Any, path: tuple[str, ...]) -> Any:
    current = root
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def find_exact_note_candidates(state: dict[str, Any], note_id: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    maps = (
        get_path(state, ("note", "noteDetailMap")),
        get_path(state, ("note", "noteDetailMapV2")),
        get_path(state, ("noteDetailMap",)),
        get_path(state, ("data", "noteDetailMap")),
    )

    for note_map in maps:
        if isinstance(note_map, dict) and note_id in note_map:
            candidates.extend(
                unwrap_note_candidates(note_map[note_id], note_id, True)
            )

    visited: set[int] = set()
    stack: list[tuple[Any, int]] = [(state, 0)]
    max_visited = 120000

    while stack and len(visited) < max_visited:
        value, depth = stack.pop()
        if not isinstance(value, (dict, list)) or depth > 24:
            continue
        identity = id(value)
        if identity in visited:
            continue
        visited.add(identity)

        if isinstance(value, dict):
            if object_has_target_id(value, note_id):
                candidates.extend(unwrap_note_candidates(value, note_id, False))
            if note_id in value:
                candidates.extend(
                    unwrap_note_candidates(value[note_id], note_id, True)
                )
            children = value.values()
        else:
            children = value

        for child in children:
            if isinstance(child, (dict, list)):
                stack.append((child, depth + 1))
    return candidates


def extract_title_from_note_object(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    title = value.get("title") or value.get("displayTitle") or value.get("display_title")
    return str(title).strip()[:120] if isinstance(title, str) else ""


def select_exact_note_from_states(
    page_html: str, note_id: str
) -> dict[str, Any] | None:
    matches: list[dict[str, Any]] = []
    for state in extract_initial_states(page_html):
        for candidate in find_exact_note_candidates(state, note_id):
            image_list = direct_image_list(candidate)
            if image_list is None:
                continue
            urls = choose_one_url_per_image(image_list)
            if not urls:
                continue
            matches.append(
                {
                    "urls": urls,
                    "title": extract_title_from_note_object(candidate),
                    "exact_id": object_has_target_id(candidate, note_id),
                }
            )
    if not matches:
        return None
    matches.sort(
        key=lambda item: (int(bool(item["exact_id"])), len(item["urls"])),
        reverse=True,
    )
    return matches[0]


def find_image_list_arrays_with_positions(text: str) -> list[dict[str, Any]]:
    arrays: list[dict[str, Any]] = []
    for match in IMAGE_LIST_KEY_PATTERN.finditer(text):
        start = text.find("[", match.start())
        if start < 0:
            continue
        balanced = extract_balanced_structure(text, start, "[", "]")
        if balanced:
            array_text, end = balanced
            arrays.append({"start": start, "end": end, "text": array_text})
    return arrays


def all_indexes_of(text: str, needle: str) -> list[int]:
    indexes: list[int] = []
    offset = 0
    while offset < len(text):
        index = text.find(needle, offset)
        if index < 0:
            break
        indexes.append(index)
        offset = index + len(needle)
    return indexes


def extract_target_local_image_list(
    page_html: str, note_id: str
) -> dict[str, Any] | None:
    note_indexes = all_indexes_of(page_html, note_id)
    if not note_indexes:
        return None

    candidates: list[dict[str, Any]] = []
    for array in find_image_list_arrays_with_positions(page_html):
        distance = min(abs(array["start"] - index) for index in note_indexes)
        if distance > 60000:
            continue
        parsed = parse_json_like(array["text"])
        if isinstance(parsed, list):
            urls = choose_one_url_per_image(parsed)
        else:
            urls = unique_keep_order(XHS_IMAGE_PATTERN.findall(array["text"]))
        if urls:
            candidates.append({"distance": distance, "urls": urls})

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item["distance"], -len(item["urls"])))
    return {"urls": candidates[0]["urls"], "title": ""}


def extract_primary_meta_image(page_html: str) -> str | None:
    meta_pattern = re.compile(r"<meta\b[^>]*>", re.I)
    content_pattern = re.compile(r"\bcontent\s*=\s*([\"'])(.*?)\1", re.I)
    key_pattern = re.compile(r"\b(?:property|name)\s*=\s*([\"'])(.*?)\1", re.I)
    allowed_keys = {"og:image", "twitter:image", "twitter:image:src"}

    for tag_match in meta_pattern.finditer(page_html):
        tag = tag_match.group(0)
        content_match = content_pattern.search(tag)
        key_match = key_pattern.search(tag)
        content = content_match.group(2) if content_match else ""
        key = key_match.group(2).lower() if key_match else ""
        if key not in allowed_keys:
            continue
        normalized = normalize_image_url(content)
        if is_xhs_image_url(normalized):
            return normalized
    return None


def extract_original_asset_token(url: str) -> str | None:
    normalized = normalize_image_url(url)
    parsed = urlparse(normalized)
    if not is_xhs_image_url(normalized):
        return None

    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if not parts:
        return None

    if parsed.netloc.lower() == "ci.xiaohongshu.com":
        parts[-1] = parts[-1].split("!", 1)[0]
        return "/".join(parts).strip("/") or None

    if len(parts) >= 3 and re.fullmatch(r"\d{10,14}", parts[0]):
        parts = parts[2:]
    if not parts:
        return None
    parts[-1] = parts[-1].split("!", 1)[0]
    return "/".join(parts).strip("/") or None


def validate_asset_token(token: Any) -> bool:
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


def extract_page_title(page_html: str) -> str:
    patterns = (
        re.compile(
            r"<meta\b[^>]*(?:property|name)=[\"']og:title[\"'][^>]*"
            r"content=[\"'](.*?)[\"'][^>]*>",
            re.I,
        ),
        re.compile(
            r"<meta\b[^>]*content=[\"'](.*?)[\"'][^>]*"
            r"(?:property|name)=[\"']og:title[\"'][^>]*>",
            re.I,
        ),
        re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S),
    )
    for pattern in patterns:
        match = pattern.search(page_html)
        if match and match.group(1):
            value = re.sub(r"<[^>]+>", "", match.group(1).strip())
            return html_lib.unescape(value)[:120]
    return "小红书图片"


def convert_source_urls(source_urls: Iterable[str]) -> list[dict[str, str]]:
    seen_tokens: set[str] = set()
    images: list[dict[str, str]] = []
    for source_url in source_urls:
        token = extract_original_asset_token(source_url)
        if not token or not validate_asset_token(token) or token in seen_tokens:
            continue
        seen_tokens.add(token)
        images.append({"token": token, "url": build_no_watermark_url(token)})
    return images


def parse_note_html(page_html: str, note_id: str) -> dict[str, Any]:
    if not note_id:
        return {
            "title": extract_page_title(page_html),
            "images": [],
            "strategy": "missing-note-id",
        }

    exact = select_exact_note_from_states(page_html, note_id)
    if exact:
        return {
            "title": exact["title"] or extract_page_title(page_html),
            "images": convert_source_urls(exact["urls"])[:50],
            "strategy": "exact-initial-state",
        }

    local = extract_target_local_image_list(page_html, note_id)
    if local:
        return {
            "title": local["title"] or extract_page_title(page_html),
            "images": convert_source_urls(local["urls"])[:50],
            "strategy": "note-id-local-image-list",
        }

    primary = extract_primary_meta_image(page_html)
    return {
        "title": extract_page_title(page_html),
        "images": convert_source_urls([primary]) if primary else [],
        "strategy": "primary-meta-cover" if primary else "not-found",
    }


class SafeRedirectHandler(HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        target = urljoin(req.full_url, newurl)
        parsed = urlparse(target)
        if not is_allowed_page_host(parsed.netloc):
            raise XhsError("分享链接跳转到了不受支持的地址。")
        return super().redirect_request(req, fp, code, msg, headers, target)


def read_limited(response, max_bytes: int = MAX_HTML_BYTES) -> bytes:
    declared = response.headers.get("Content-Length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise XhsError("页面内容过大，已停止解析。", 413)

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(256 * 1024, max_bytes - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise XhsError("页面内容过大，已停止解析。", 413)
        chunks.append(chunk)
    return b"".join(chunks)


def fetch_note_page(input_url: str) -> tuple[str, str]:
    parsed = urlparse(input_url)
    if not is_allowed_page_host(parsed.netloc):
        raise XhsError("分享链接地址不受支持。")

    opener = build_opener(SafeRedirectHandler())
    request = Request(input_url, headers=PAGE_HEADERS, method="GET")

    try:
        with opener.open(request, timeout=15) as response:
            final_url = response.geturl()
            final_host = urlparse(final_url).netloc
            if not is_allowed_page_host(final_host):
                raise XhsError("分享链接跳转到了不受支持的地址。")
            raw = read_limited(response)
            charset = response.headers.get_content_charset() or "utf-8"
    except XhsError:
        raise
    except HTTPError as error:
        if error.code in (403, 461):
            raise XhsError(
                "小红书拒绝了 Python 服务器访问，可能触发了风控，请切换 Node.js 或稍后重试。",
                400,
            ) from error
        raise XhsError(f"小红书页面返回 HTTP {error.code}。", 502 if error.code >= 500 else 400) from error
    except (URLError, TimeoutError, socket.timeout) as error:
        reason = getattr(error, "reason", error)
        raise XhsError(f"访问小红书页面失败：{reason}", 502) from error

    page_html = raw.decode(charset, errors="replace")
    if not page_html.strip():
        raise XhsError("小红书页面返回内容为空。", 502)
    return final_url, page_html


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
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
        self.send_header("Allow", "POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        self._send_json(405, {"success": False, "message": "只支持 POST 请求。"})

    def do_POST(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0") or 0)
            if content_length <= 0:
                raise XhsError("请求内容为空。")
            if content_length > 16 * 1024:
                raise XhsError("请求内容过大。", 413)

            raw_body = self.rfile.read(content_length)
            try:
                body = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise XhsError("请求 JSON 格式无效。") from error

            raw_text = str(body.get("text", "")).strip() if isinstance(body, dict) else ""
            if not raw_text:
                raise XhsError("请粘贴小红书分享文案或链接。")
            if len(raw_text) > MAX_INPUT_LENGTH:
                raise XhsError("输入内容过长。", 413)

            input_url = extract_input_url(raw_text)
            if is_direct_image_url(input_url):
                token = extract_original_asset_token(input_url)
                if not token or not validate_asset_token(token):
                    raise XhsError("无法从图片地址中提取原始资源标识。")
                self._send_json(
                    200,
                    {
                        "success": True,
                        "engine": "python",
                        "title": "小红书图片",
                        "count": 1,
                        "images": [
                            {
                                "index": 1,
                                "token": token,
                                "url": build_no_watermark_url(token),
                            }
                        ],
                    },
                )
                return

            final_url, page_html = fetch_note_page(input_url)
            note_id = extract_note_id(final_url) or extract_note_id(input_url)
            if not note_id:
                raise XhsError("无法从分享链接中识别当前笔记 ID。", 422)

            parsed = parse_note_html(page_html, note_id)
            if not parsed["images"]:
                raise XhsError(
                    "没有解析到图片。笔记可能已删除、需要登录，或者小红书页面结构已更新。",
                    422,
                )

            images = [
                {
                    "index": index,
                    "token": image["token"],
                    "url": image["url"],
                }
                for index, image in enumerate(parsed["images"], start=1)
            ]
            self._send_json(
                200,
                {
                    "success": True,
                    "engine": "python",
                    "title": parsed["title"],
                    "noteId": note_id,
                    "strategy": parsed["strategy"],
                    "count": len(images),
                    "images": images,
                },
            )
        except XhsError as error:
            self._send_json(
                error.status_code,
                {"success": False, "engine": "python", "message": str(error)},
            )
        except Exception as error:  # noqa: BLE001
            print("python parse error", repr(error))
            self._send_json(
                500,
                {
                    "success": False,
                    "engine": "python",
                    "message": "Python 服务器解析失败，请切换 Node.js 或稍后重试。",
                },
            )
