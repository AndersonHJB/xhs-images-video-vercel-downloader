const URL_PATTERN = /https?:\/\/[^\s<>'"，。！？、]+/i;

const XHS_IMAGE_PATTERN = /https?:(?:\\u002[fF]|\\\/|\/){2}[^"'<>\\\s]+?(?:xhscdn\.com|ci\.xiaohongshu\.com)[^"'<>\\\s]*/gi;

const CONTENT_IMAGE_PATTERN = /content\s*=\s*(["'])(https?:(?:\\u002[fF]|\\\/|\/){2}[^"'<>\\\s]+?(?:xhscdn\.com|ci\.xiaohongshu\.com)[^"'<>\\\s]*)\1/gi;

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

export class XhsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "XhsError";
    this.statusCode = statusCode;
  }
}

function decodeHtmlEntities(value) {
  return value
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

  if (value.startsWith("//")) {
    value = `https:${value}`;
  }

  if (value.startsWith("http://")) {
    value = `https://${value.slice("http://".length)}`;
  }

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

  if (!parsed) {
    throw new XhsError("链接格式无效。");
  }

  const host = parsed.hostname.toLowerCase();
  if (!isAllowedPageHost(host) && !isXhsImageUrl(value)) {
    throw new XhsError("只支持小红书分享链接或小红书图片链接。");
  }

  return value;
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
    ["avatar", 8000]
  ]);

  for (const [token, penalty] of penalties) {
    if (lower.includes(token)) score -= penalty;
  }

  return score;
}

function imageIdentity(url) {
  const parsed = parseUrl(normalizeImageUrl(url));
  if (!parsed) return String(url);

  const filename = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
  return (filename.split("!", 1)[0] || normalizeImageUrl(url)).toLowerCase();
}

function selectBestPerIdentity(urls) {
  const order = [];
  const best = new Map();

  for (const url of uniqueKeepOrder(urls)) {
    const identity = imageIdentity(url);
    const score = imageQualityScore(url);

    if (!best.has(identity)) {
      order.push(identity);
      best.set(identity, { score, url });
    } else if (score > best.get(identity).score) {
      best.set(identity, { score, url });
    }
  }

  return order.map((identity) => best.get(identity).url);
}

function extractContentImages(html) {
  const urls = [];
  for (const match of html.matchAll(CONTENT_IMAGE_PATTERN)) {
    urls.push(match[2]);
  }
  return selectBestPerIdentity(urls);
}

function extractMetaImages(html) {
  const urls = [];
  const metaPattern = /<meta\b[^>]*>/gi;
  const contentPattern = /\bcontent\s*=\s*(["'])(.*?)\1/i;
  const keyPattern = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i;

  for (const tagMatch of html.matchAll(metaPattern)) {
    const tag = tagMatch[0];
    const content = tag.match(contentPattern)?.[2] ?? "";
    const key = (tag.match(keyPattern)?.[2] ?? "").toLowerCase();

    if (!content) continue;
    if (!key.includes("image") && !content.includes("xhscdn.com")) continue;

    urls.push(...(content.match(XHS_IMAGE_PATTERN) ?? []));
    if (isXhsImageUrl(content)) urls.push(content);
  }

  return selectBestPerIdentity(urls);
}

function extractBalancedArray(text, start) {
  if (text[start] !== "[") return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function findImageListArrays(text) {
  const arrays = [];
  const pattern = /["']imageList["']\s*:\s*\[/g;

  for (const match of text.matchAll(pattern)) {
    const start = text.indexOf("[", match.index);
    if (start < 0) continue;
    const array = extractBalancedArray(text, start);
    if (array) arrays.push(array);
  }

  return arrays;
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
      selected.push(candidates.sort((a, b) => imageQualityScore(b) - imageQualityScore(a))[0]);
    }
  }

  return selectBestPerIdentity(selected);
}

function extractJsonImageLists(html) {
  const groups = [];

  for (const arrayText of findImageListArrays(html)) {
    const cleaned = arrayText.replace(/\bundefined\b/g, "null");

    try {
      const imageList = JSON.parse(cleaned);
      if (Array.isArray(imageList)) {
        const selected = chooseOneUrlPerImage(imageList);
        if (selected.length > 0) groups.push(selected);
      }
    } catch {
      const fallback = selectBestPerIdentity(arrayText.match(XHS_IMAGE_PATTERN) ?? []);
      if (fallback.length > 0) groups.push(fallback);
    }
  }

  if (groups.length === 0) return [];

  return groups.sort((a, b) => {
    const highA = a.filter((url) => HIGH_QUALITY_PATTERN.test(url)).length;
    const highB = b.filter((url) => HIGH_QUALITY_PATTERN.test(url)).length;
    return highB - highA || b.length - a.length;
  })[0];
}

function extractGlobalImages(html) {
  return selectBestPerIdentity(html.match(XHS_IMAGE_PATTERN) ?? []).filter((url) => {
    const lower = url.toLowerCase();
    return !lower.includes("avatar") && !lower.includes("thumbnail") && !lower.includes("/head/");
  });
}

function chooseBestGroup(groups) {
  const nonEmpty = groups.filter((group) => group.length > 0);
  if (nonEmpty.length === 0) return [];

  return nonEmpty.sort((a, b) => {
    const highA = a.filter((url) => HIGH_QUALITY_PATTERN.test(url) || url.includes("!nd_dft_")).length;
    const highB = b.filter((url) => HIGH_QUALITY_PATTERN.test(url) || url.includes("!nd_dft_")).length;
    return highB - highA || b.length - a.length;
  })[0];
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
  if (!validateAssetToken(token)) {
    throw new XhsError("图片资源标识无效。");
  }

  const encoded = token
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://ci.xiaohongshu.com/${encoded}?imageView2/format/jpg`;
}

function extractTitle(html) {
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

export function parseNoteHtml(html) {
  const groups = [
    extractContentImages(html),
    extractMetaImages(html),
    extractJsonImageLists(html),
    extractGlobalImages(html)
  ];

  const selected = chooseBestGroup(groups).slice(0, 50);
  const seenTokens = new Set();
  const images = [];

  for (const sourceUrl of selected) {
    const token = extractOriginalAssetToken(sourceUrl);
    if (!token || !validateAssetToken(token) || seenTokens.has(token)) continue;

    seenTokens.add(token);
    images.push({
      token,
      url: buildNoWatermarkUrl(token)
    });
  }

  return {
    title: extractTitle(html),
    images
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
