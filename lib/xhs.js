const URL_PATTERN = /https?:\/\/[^\s<>'"，。！？、]+/i;

const XHS_IMAGE_PATTERN = /https?:(?:\\u002[fF]|\\\/|\/){2}[^"'<>\\\s]+?(?:xhscdn\.com|ci\.xiaohongshu\.com)[^"'<>\\\s]*/gi;

const HIGH_QUALITY_PATTERN = /!nd_dft_wlteh_(?:webp|jpg|jpeg|png)_3(?:$|[?#])/i;

const PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
    "Mobile/15E148 Safari/604.1",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache"
};

const DIRECT_IMAGE_HOSTS = new Set([
  "sns-webpic-qc.xhscdn.com",
  "sns-webpic.xhscdn.com",
  "sns-img-hw.xhscdn.com",
  "sns-img-bd.xhscdn.com",
  "sns-img-al.xhscdn.com",
  "ci.xiaohongshu.com"
]);

const VIDEO_STREAM_KEYS = ["h264", "h265", "av1"];
const VIDEO_META_KEYS = new Set([
  "og:video",
  "og:video:url",
  "og:video:secure_url",
  "twitter:player:stream"
]);

const IMAGE_LIST_KEYS = ["imageList", "image_list", "images"];
const NOTE_WRAPPER_KEYS = ["note", "noteData", "note_data", "data"];

export class XhsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "XhsError";
    this.statusCode = statusCode;
  }
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeImageUrl(raw) {
  let value = decodeHtmlEntities(String(raw ?? "").trim().replace(/^["']|["']$/g, ""));

  value = value
    .replace(/\\u002F/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003D/gi, "=")
    .replace(/\\x26/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\+$/g, "");

  if (value.startsWith("//")) value = `https:${value}`;
  if (value.startsWith("http://")) value = `https://${value.slice("http://".length)}`;

  return value;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isXhsImageUrl(value) {
  const parsed = parseUrl(normalizeImageUrl(value));
  if (!parsed) return false;

  const host = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    (host.endsWith("xhscdn.com") || host === "ci.xiaohongshu.com")
  );
}

export function isDirectImageUrl(value) {
  const parsed = parseUrl(normalizeImageUrl(value));
  return Boolean(parsed && DIRECT_IMAGE_HOSTS.has(parsed.hostname.toLowerCase()));
}

export function isXhsVideoUrl(value) {
  const parsed = parseUrl(normalizeImageUrl(value));
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return (host === "xhscdn.com" || host.endsWith(".xhscdn.com")) && parsed.pathname.length > 1;
}

function isAllowedPageHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "xhslink.com" ||
    host.endsWith(".xhslink.com") ||
    host === "xiaohongshu.com" ||
    host.endsWith(".xiaohongshu.com")
  );
}

export function extractInputUrl(text) {
  const match = String(text ?? "").trim().match(URL_PATTERN);
  if (!match) {
    throw new XhsError("没有检测到有效链接，请粘贴小红书分享文案或链接。");
  }

  const value = normalizeImageUrl(
    match[0].replace(/[.,;:!?\])}，。！？；：）】》]+$/g, "")
  );
  const parsed = parseUrl(value);

  if (!parsed) throw new XhsError("链接格式无效。");

  const host = parsed.hostname.toLowerCase();
  if (!isAllowedPageHost(host) && !isXhsImageUrl(value)) {
    throw new XhsError("只支持小红书分享链接或小红书图片链接。");
  }

  return value;
}

/**
 * 从小红书页面 URL 中提取当前笔记 ID。
 * 支持 /discovery/item/<id>、/explore/<id>、/item/<id>。
 */
export function extractNoteId(value) {
  const parsed = parseUrl(value);
  if (!parsed) return null;

  const match = parsed.pathname.match(
    /\/(?:discovery\/item|explore|item)\/([A-Za-z0-9_-]{12,64})(?:\/|$)/i
  );
  return match?.[1] ?? null;
}

function uniqueKeepOrder(values) {
  const result = [];
  const seen = new Set();

  for (const item of values) {
    const normalized = normalizeImageUrl(item).split("#", 1)[0];
    if (!isXhsImageUrl(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function imageQualityScore(url) {
  const lower = normalizeImageUrl(url).toLowerCase();
  let score = 0;

  if (HIGH_QUALITY_PATTERN.test(lower)) score += 10000;
  if (lower.includes("!nd_dft_")) score += 5000;
  if (lower.includes("_wlteh_webp_3")) score += 3000;
  if (/_(?:webp|jpg|jpeg|png)_3(?:$|[?#])/.test(lower)) score += 1500;
  if (lower.includes("sns-webpic-qc.xhscdn.com")) score += 600;
  if (lower.includes("sns-img-") || lower.includes("ci.xiaohongshu.com")) score += 500;

  const penalties = new Map([
    ["!nd_prv_", 7000],
    ["preview", 5000],
    ["thumbnail", 5000],
    ["thumb", 4000],
    ["_mw_1", 4500],
    ["_webp_1", 3500],
    ["_webp_2", 2500],
    ["/avatar/", 10000],
    ["avatar", 8000],
    ["/head/", 8000]
  ]);

  for (const [token, penalty] of penalties) {
    if (lower.includes(token)) score -= penalty;
  }

  return score;
}

function collectUrls(value) {
  const found = [];

  if (typeof value === "string") {
    if (isXhsImageUrl(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) found.push(...collectUrls(item));
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) found.push(...collectUrls(item));
  }

  return found;
}

function collectUrlsForKeys(value, keys) {
  const found = [];

  if (Array.isArray(value)) {
    for (const item of value) found.push(...collectUrlsForKeys(item, keys));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key)) found.push(...collectUrls(item));
    }

    for (const item of Object.values(value)) {
      if (item && typeof item === "object") {
        found.push(...collectUrlsForKeys(item, keys));
      }
    }
  }

  return found;
}

function chooseOneUrlPerImage(imageList) {
  if (!Array.isArray(imageList)) return [];

  const defaultKeys = new Set([
    "urlDefault",
    "url_default",
    "defaultUrl",
    "default_url",
    "originUrl",
    "origin_url",
    "original",
    "originalUrl",
    "original_url"
  ]);
  const normalKeys = new Set(["url", "imageUrl", "image_url", "fileUrl", "file_url"]);
  const previewKeys = new Set([
    "urlPre",
    "url_pre",
    "previewUrl",
    "preview_url",
    "thumbnail",
    "thumbnailUrl",
    "thumbnail_url"
  ]);

  const selected = [];

  for (const item of imageList) {
    const defaults = uniqueKeepOrder(collectUrlsForKeys(item, defaultKeys));
    const normals = uniqueKeepOrder(collectUrlsForKeys(item, normalKeys));
    const previews = uniqueKeepOrder(collectUrlsForKeys(item, previewKeys));
    const all = uniqueKeepOrder(collectUrls(item));
    const candidates = uniqueKeepOrder([...defaults, ...normals, ...all, ...previews]);

    if (candidates.length > 0) {
      candidates.sort((a, b) => imageQualityScore(b) - imageQualityScore(a));
      selected.push(candidates[0]);
    }
  }

  // imageList 的每个元素本身就代表一张图，只做 URL 级去重，保持原帖顺序。
  return uniqueKeepOrder(selected);
}


function normalizeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function collectVideoUrlsFromStream(stream) {
  if (!stream || typeof stream !== "object") return [];

  const values = [
    stream.masterUrl,
    stream.master_url,
    stream.url,
    ...(Array.isArray(stream.masterUrls) ? stream.masterUrls : []),
    ...(Array.isArray(stream.master_urls) ? stream.master_urls : []),
    ...(Array.isArray(stream.backupUrls) ? stream.backupUrls : []),
    ...(Array.isArray(stream.backup_urls) ? stream.backup_urls : [])
  ];

  const urls = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeImageUrl(value).split("#", 1)[0];
    if (!isXhsVideoUrl(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

function codecPriority(codec) {
  const normalized = String(codec ?? "").toLowerCase();
  if (normalized.includes("264") || normalized === "avc") return 3;
  if (normalized.includes("265") || normalized.includes("hevc")) return 2;
  if (normalized.includes("av1")) return 1;
  return 0;
}

function videoQualityScore(video) {
  return (
    codecPriority(video.codec) * 10 ** 15 +
    normalizeNumber(video.width) * normalizeNumber(video.height) * 10 ** 6 +
    normalizeNumber(video.bitrate) * 10 +
    normalizeNumber(video.size)
  );
}

/**
 * 只从“当前笔记对象”读取视频流。
 * 支持 video.media.stream.h264/h265/av1 以及旧版 originVideoKey。
 */
function extractVideoStreamsFromNote(note) {
  if (!note || typeof note !== "object") return [];

  const streams = [];
  const streamRoot = note.video?.media?.stream;

  if (streamRoot && typeof streamRoot === "object") {
    for (const streamKey of VIDEO_STREAM_KEYS) {
      const list = Array.isArray(streamRoot[streamKey]) ? streamRoot[streamKey] : [];
      for (const item of list) {
        const codec = item?.videoCodec ?? item?.video_codec ?? item?.codec ?? streamKey;
        const urls = collectVideoUrlsFromStream(item);
        if (urls.length > 0) {
          streams.push({
            url: urls[0],
            backupUrls: urls.slice(1),
            codec: String(codec || streamKey).toLowerCase(),
            width: normalizeNumber(item?.width),
            height: normalizeNumber(item?.height),
            bitrate: normalizeNumber(item?.videoBitrate ?? item?.video_bitrate ?? item?.bitrate),
            size: normalizeNumber(item?.size ?? item?.fileSize ?? item?.file_size),
            qualityType: String(item?.qualityType ?? item?.quality_type ?? ""),
            source: "media-stream"
          });
        }
      }
    }
  }

  // 旧版页面只提供 originVideoKey。
  if (streams.length === 0) {
    const key = note.video?.consumer?.originVideoKey
      ?? note.video?.consumer?.origin_video_key
      ?? note.video?.originVideoKey
      ?? note.video?.origin_video_key;

    if (typeof key === "string" && key.trim()) {
      const cleanKey = key.trim().replace(/^\/+/, "");
      const url = normalizeImageUrl(`https://sns-video-bd.xhscdn.com/${cleanKey}`);
      if (isXhsVideoUrl(url)) {
        streams.push({
          url,
          backupUrls: [],
          codec: "h264",
          width: 0,
          height: 0,
          bitrate: 0,
          size: 0,
          qualityType: "origin",
          source: "origin-video-key"
        });
      }
    }
  }

  const deduped = new Map();
  for (const stream of streams) {
    const existing = deduped.get(stream.url);
    if (!existing || videoQualityScore(stream) > videoQualityScore(existing)) {
      deduped.set(stream.url, stream);
    }
  }

  return [...deduped.values()].sort((a, b) => videoQualityScore(b) - videoQualityScore(a));
}

function formatVideoLabel(video, index) {
  const resolution = video.width && video.height ? `${video.width}×${video.height}` : "原始清晰度";
  const codec = String(video.codec || "video").toUpperCase();
  const bitrate = video.bitrate ? ` · ${Math.round(video.bitrate / 1000)} kbps` : "";
  return `${resolution} · ${codec}${bitrate} · 线路 ${index + 1}`;
}

function prepareVideoResults(videos) {
  const sorted = [...videos].sort((a, b) => videoQualityScore(b) - videoQualityScore(a));
  return sorted.slice(0, 12).map((video, index) => ({
    ...video,
    label: formatVideoLabel(video, index),
    isDefault: index === 0
  }));
}

function extractBalancedStructure(text, start, openChar, closeChar) {
  if (text[start] !== openChar) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          text: text.slice(start, index + 1),
          end: index + 1
        };
      }
    }
  }

  return null;
}

function replaceBareJsValues(text) {
  // 只替换字符串外的 undefined / NaN / Infinity，避免破坏正文。
  let output = "";
  let index = 0;
  let inString = false;
  let quote = "";
  let escape = false;

  while (index < text.length) {
    const char = text[index];

    if (inString) {
      output += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    const rest = text.slice(index);
    const match = rest.match(/^(?:undefined|NaN|-?Infinity)\b/);
    if (match) {
      output += "null";
      index += match[0].length;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function parseJsonLike(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(replaceBareJsValues(text));
    } catch {
      return null;
    }
  }
}

function extractInitialStates(html) {
  const states = [];
  const seenRanges = new Set();

  // 常见形式：window.__INITIAL_STATE__ = {...}
  const assignmentPattern = /(?:window\.)?__INITIAL_STATE__\s*=\s*/g;
  for (const match of html.matchAll(assignmentPattern)) {
    const start = html.indexOf("{", match.index + match[0].length);
    if (start < 0) continue;

    const balanced = extractBalancedStructure(html, start, "{", "}");
    if (!balanced) continue;

    const rangeKey = `${start}:${balanced.end}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);

    const parsed = parseJsonLike(balanced.text);
    if (parsed && typeof parsed === "object") states.push(parsed);
  }

  // 兼容 <script id="__INITIAL_STATE__" type="application/json">...</script>
  const scriptPattern = /<script\b[^>]*\bid=["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const parsed = parseJsonLike(decodeHtmlEntities(match[1].trim()));
    if (parsed && typeof parsed === "object") states.push(parsed);
  }

  return states;
}

function objectHasTargetId(value, noteId) {
  if (!value || typeof value !== "object") return false;
  const identifiers = [
    value.noteId,
    value.note_id,
    value.id,
    value.itemId,
    value.item_id
  ];
  return identifiers.some((identifier) => String(identifier ?? "") === noteId);
}

function directImageList(value) {
  if (!value || typeof value !== "object") return null;

  for (const key of IMAGE_LIST_KEYS) {
    if (Array.isArray(value[key])) return value[key];
  }

  return null;
}

function unwrapNoteCandidates(value, noteId, fromExactMapKey = false) {
  const candidates = [];
  if (!value || typeof value !== "object") return candidates;

  if (fromExactMapKey || objectHasTargetId(value, noteId)) candidates.push(value);

  for (const key of NOTE_WRAPPER_KEYS) {
    const wrapped = value[key];
    if (!wrapped || typeof wrapped !== "object") continue;
    if (fromExactMapKey || objectHasTargetId(wrapped, noteId)) candidates.push(wrapped);
  }

  return candidates;
}

function getPath(root, path) {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function findExactNoteCandidates(state, noteId) {
  const candidates = [];
  const maps = [
    getPath(state, ["note", "noteDetailMap"]),
    getPath(state, ["note", "noteDetailMapV2"]),
    getPath(state, ["noteDetailMap"]),
    getPath(state, ["data", "noteDetailMap"])
  ];

  // 最可靠路径：noteDetailMap[当前笔记 ID]
  for (const map of maps) {
    if (!map || typeof map !== "object" || !(noteId in map)) continue;
    candidates.push(...unwrapNoteCandidates(map[noteId], noteId, true));
  }

  // 兼容页面结构变化：递归查找 noteId 精确相等的对象，绝不按图片数量猜帖子。
  const visited = new WeakSet();
  let visitedCount = 0;
  const MAX_VISITED = 120000;

  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 24) return;
    if (visited.has(value) || visitedCount >= MAX_VISITED) return;

    visited.add(value);
    visitedCount += 1;

    if (objectHasTargetId(value, noteId)) {
      candidates.push(...unwrapNoteCandidates(value, noteId, false));
    }

    if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, noteId)) {
      candidates.push(...unwrapNoteCandidates(value[noteId], noteId, true));
    }

    for (const child of Object.values(value)) walk(child, depth + 1);
  }

  walk(state);

  return candidates;
}

function extractTitleFromNoteObject(value) {
  if (!value || typeof value !== "object") return "";
  const title = value.title ?? value.displayTitle ?? value.display_title ?? "";
  return typeof title === "string" ? title.trim().slice(0, 120) : "";
}

function extractContentFromNoteObject(value) {
  if (!value || typeof value !== "object") return "";

  // 文案必须和已经锁定的当前笔记对象同源，不能递归扫描相关推荐。
  for (const key of ["desc", "description"]) {
    const content = value[key];
    if (typeof content !== "string" || !content.trim()) continue;
    return content.replace(/\r\n?/g, "\n").trim().slice(0, 10000);
  }

  return "";
}

function selectExactNoteFromStates(html, noteId) {
  const matches = [];

  for (const state of extractInitialStates(html)) {
    for (const candidate of findExactNoteCandidates(state, noteId)) {
      const imageList = directImageList(candidate);
      const urls = imageList ? chooseOneUrlPerImage(imageList) : [];
      const videos = extractVideoStreamsFromNote(candidate);
      if (urls.length === 0 && videos.length === 0) continue;

      matches.push({
        urls,
        videos,
        title: extractTitleFromNoteObject(candidate),
        content: extractContentFromNoteObject(candidate),
        exactId: objectHasTargetId(candidate, noteId)
      });
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    // 保持旧版图片选择逻辑：优先对象自身包含 noteId，再选媒体信息更完整的副本。
    const aMedia = a.urls.length + a.videos.length;
    const bMedia = b.urls.length + b.videos.length;
    return Number(b.exactId) - Number(a.exactId) || bMedia - aMedia || b.urls.length - a.urls.length;
  });

  return matches[0];
}

function findImageListArraysWithPositions(text) {
  const arrays = [];
  const pattern = /["']imageList["']\s*:\s*\[/g;

  for (const match of text.matchAll(pattern)) {
    const start = text.indexOf("[", match.index);
    if (start < 0) continue;
    const balanced = extractBalancedStructure(text, start, "[", "]");
    if (balanced) arrays.push({ start, end: balanced.end, text: balanced.text });
  }

  return arrays;
}

function allIndexesOf(text, needle) {
  const indexes = [];
  let offset = 0;

  while (offset < text.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + needle.length;
  }

  return indexes;
}

function nearestDistance(position, indexes) {
  let best = Number.POSITIVE_INFINITY;
  for (const index of indexes) {
    const distance = Math.abs(position - index);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * 初始状态解析失败时的保守降级方案：
 * 只选择距离“当前 noteId”最近的 imageList，绝不扫描整页后按数量选最大图集。
 */
function extractTargetLocalImageList(html, noteId) {
  const noteIndexes = allIndexesOf(html, noteId);
  if (noteIndexes.length === 0) return null;

  const candidates = [];
  for (const array of findImageListArraysWithPositions(html)) {
    const distance = nearestDistance(array.start, noteIndexes);
    if (distance > 60000) continue;

    const parsed = parseJsonLike(array.text);
    let urls = [];

    if (Array.isArray(parsed)) {
      urls = chooseOneUrlPerImage(parsed);
    } else {
      // 只对这个局部 imageList 做 URL 兜底，不扫描整个 HTML。
      urls = uniqueKeepOrder(array.text.match(XHS_IMAGE_PATTERN) ?? []);
    }

    if (urls.length > 0) candidates.push({ distance, urls });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.distance - b.distance || b.urls.length - a.urls.length);
  return { urls: candidates[0].urls, title: "" };
}


function findVideoObjectsWithPositions(text) {
  const objects = [];
  const pattern = /["']video["']\s*:\s*\{/g;

  for (const match of text.matchAll(pattern)) {
    const start = text.indexOf("{", match.index);
    if (start < 0) continue;
    const balanced = extractBalancedStructure(text, start, "{", "}");
    if (balanced) objects.push({ start, end: balanced.end, text: balanced.text });
  }
  return objects;
}

function extractTargetLocalVideoStreams(html, noteId) {
  const noteIndexes = allIndexesOf(html, noteId);
  if (noteIndexes.length === 0) return [];

  const candidates = [];
  for (const object of findVideoObjectsWithPositions(html)) {
    const distance = nearestDistance(object.start, noteIndexes);
    if (distance > 60000) continue;

    const parsed = parseJsonLike(object.text);
    if (!parsed || typeof parsed !== "object") continue;
    const videos = extractVideoStreamsFromNote({ video: parsed });
    if (videos.length > 0) candidates.push({ distance, videos });
  }

  if (candidates.length === 0) return [];
  candidates.sort((a, b) => a.distance - b.distance || b.videos.length - a.videos.length);
  return candidates[0].videos;
}

function extractPrimaryMetaVideo(html) {
  const metaPattern = /<meta\b[^>]*>/gi;
  const contentPattern = /\bcontent\s*=\s*(["'])(.*?)\1/i;
  const keyPattern = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i;

  for (const tagMatch of html.matchAll(metaPattern)) {
    const tag = tagMatch[0];
    const content = tag.match(contentPattern)?.[2] ?? "";
    const key = (tag.match(keyPattern)?.[2] ?? "").toLowerCase();
    if (!VIDEO_META_KEYS.has(key)) continue;

    const normalized = normalizeImageUrl(content);
    if (isXhsVideoUrl(normalized)) {
      return {
        url: normalized,
        backupUrls: [],
        codec: "h264",
        width: 0,
        height: 0,
        bitrate: 0,
        size: 0,
        qualityType: "meta",
        source: "primary-meta"
      };
    }
  }
  return null;
}

function extractPrimaryMetaImage(html) {
  const metaPattern = /<meta\b[^>]*>/gi;
  const contentPattern = /\bcontent\s*=\s*(["'])(.*?)\1/i;
  const keyPattern = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i;

  for (const tagMatch of html.matchAll(metaPattern)) {
    const tag = tagMatch[0];
    const content = tag.match(contentPattern)?.[2] ?? "";
    const key = (tag.match(keyPattern)?.[2] ?? "").toLowerCase();

    if (!["og:image", "twitter:image", "twitter:image:src"].includes(key)) continue;
    const normalized = normalizeImageUrl(content);
    if (isXhsImageUrl(normalized)) return normalized;
  }

  return null;
}

export function extractOriginalAssetToken(url) {
  const normalized = normalizeImageUrl(url);
  const parsed = parseUrl(normalized);
  if (!parsed || !isXhsImageUrl(normalized)) return null;

  let parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  if (parts.length === 0) return null;

  if (parsed.hostname.toLowerCase() === "ci.xiaohongshu.com") {
    parts[parts.length - 1] = parts.at(-1).split("!", 1)[0];
    return parts.join("/").replace(/^\/+|\/+$/g, "") || null;
  }

  if (parts.length >= 3 && /^\d{10,14}$/.test(parts[0])) {
    parts = parts.slice(2);
  }

  if (parts.length === 0) return null;
  parts[parts.length - 1] = parts.at(-1).split("!", 1)[0];

  return parts.join("/").replace(/^\/+|\/+$/g, "") || null;
}

export function validateAssetToken(token) {
  if (typeof token !== "string" || token.length < 1 || token.length > 400) return false;
  if (token.startsWith("/") || token.includes("..") || token.includes("\\")) return false;
  return /^[A-Za-z0-9/_~.\-]+$/.test(token);
}

export function buildNoWatermarkUrl(token) {
  if (!validateAssetToken(token)) throw new XhsError("图片资源标识无效。");

  const encoded = token
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://ci.xiaohongshu.com/${encoded}?imageView2/format/jpg`;
}

function extractPageTitle(html) {
  const patterns = [
    /<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["'](.*?)["'][^>]*>/i,
    /<meta\b[^>]*content=["'](.*?)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i,
    /<title[^>]*>(.*?)<\/title>/is
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "").trim()).slice(0, 120);
    }
  }

  return "小红书图片";
}

function convertSourceUrls(sourceUrls) {
  const seenTokens = new Set();
  const images = [];

  for (const sourceUrl of sourceUrls) {
    const token = extractOriginalAssetToken(sourceUrl);
    if (!token || !validateAssetToken(token) || seenTokens.has(token)) continue;

    seenTokens.add(token);
    images.push({
      token,
      url: buildNoWatermarkUrl(token)
    });
  }

  return images;
}

/**
 * 只解析指定 noteId 对应的图片和视频。
 * 不扫描整页推荐内容，因此不会混入其他帖子的媒体资源。
 */
export function parseNoteHtml(html, options = {}) {
  const noteId = String(options.noteId ?? "").trim();
  if (!noteId) {
    return {
      title: extractPageTitle(html),
      content: "",
      images: [],
      videos: [],
      strategy: "missing-note-id"
    };
  }

  const exact = selectExactNoteFromStates(html, noteId);
  if (exact) {
    return {
      title: exact.title || extractPageTitle(html),
      content: exact.content,
      images: convertSourceUrls(exact.urls).slice(0, 50),
      videos: prepareVideoResults(exact.videos),
      strategy: "exact-initial-state"
    };
  }

  const localImages = extractTargetLocalImageList(html, noteId);
  const localVideos = extractTargetLocalVideoStreams(html, noteId);
  if (localImages || localVideos.length > 0) {
    return {
      title: localImages?.title || extractPageTitle(html),
      content: "",
      images: convertSourceUrls(localImages?.urls ?? []).slice(0, 50),
      videos: prepareVideoResults(localVideos),
      strategy: localImages && localVideos.length > 0
        ? "note-id-local-media"
        : localImages
          ? "note-id-local-image-list"
          : "note-id-local-video"
    };
  }

  // 最后的保守兜底只读取当前页面主媒体 meta，不全局扫描。
  const primaryImage = extractPrimaryMetaImage(html);
  const primaryVideo = extractPrimaryMetaVideo(html);
  return {
    title: extractPageTitle(html),
    content: "",
    images: primaryImage ? convertSourceUrls([primaryImage]) : [],
    videos: primaryVideo ? prepareVideoResults([primaryVideo]) : [],
    strategy: primaryImage && primaryVideo
      ? "primary-meta-media"
      : primaryImage
        ? "primary-meta-cover"
        : primaryVideo
          ? "primary-meta-video"
          : "not-found"
  };
}

async function readTextWithLimit(response, maxBytes = 6 * 1024 * 1024) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new XhsError("页面内容过大，已停止解析。", 413);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(merged);
}

export async function fetchNotePage(inputUrl) {
  let current = new URL(inputUrl);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isAllowedPageHost(current.hostname)) {
      throw new XhsError("分享链接跳转到了不受支持的地址。", 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: PAGE_HEADERS,
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new XhsError("访问小红书页面超时，请稍后重试。", 504);
      }
      throw new XhsError(`访问小红书页面失败：${error.message}`, 502);
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new XhsError("分享链接跳转响应缺少目标地址。", 502);
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      const hint = response.status === 403 || response.status === 461
        ? "小红书拒绝了服务器访问，可能触发了风控，请稍后重试。"
        : `小红书页面返回 HTTP ${response.status}。`;
      throw new XhsError(hint, response.status >= 500 ? 502 : 400);
    }

    const html = await readTextWithLimit(response);
    if (!html.trim()) throw new XhsError("小红书页面返回内容为空。", 502);

    return {
      finalUrl: current.toString(),
      html
    };
  }

  throw new XhsError("分享链接跳转次数过多。", 400);
}
