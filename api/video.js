import { XhsError, isXhsVideoUrl, normalizeImageUrl } from "../lib/xhs.js";

const MAX_CHUNK_BYTES = 3_500_000;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

function parseSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new XhsError(`${name} 参数无效。`);
  }
  return number;
}

function parseContentRange(value) {
  const match = String(value ?? "").match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? 0 : Number(match[3])
  };
}

async function fetchVideo(url, range) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        referer: "https://www.xiaohongshu.com/",
        range
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!isXhsVideoUrl(response.url)) {
      await response.body?.cancel().catch(() => {});
      throw new XhsError("视频 CDN 跳转到了不受支持的地址。", 502);
    }
    return response;
  } catch (error) {
    if (error?.name === "AbortError") throw new XhsError("读取视频超时。", 504);
    throw new XhsError(`读取视频失败：${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readBufferWithLimit(response, limit) {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > limit) {
    await response.body?.cancel().catch(() => {});
    throw new XhsError("视频分段超过服务器单次响应限制。", 413);
  }
  if (!response.body) throw new XhsError("视频响应为空。", 502);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new XhsError("视频分段超过服务器单次响应限制。", 413);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

function getSourceUrl(req) {
  const sourceUrl = normalizeImageUrl(String(req.query.url ?? ""));
  if (!isXhsVideoUrl(sourceUrl)) {
    throw new XhsError("视频地址无效或不属于小红书 CDN。");
  }
  return sourceUrl;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XHS-Engine", "node");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "只支持 GET 请求。" });
  }

  try {
    const sourceUrl = getSourceUrl(req);
    const action = String(req.query.action ?? "meta");

    if (action === "meta") {
      const response = await fetchVideo(sourceUrl, "bytes=0-0");
      if (![200, 206].includes(response.status)) {
        throw new XhsError(`视频服务器返回 HTTP ${response.status}。`, 502);
      }

      const contentRange = parseContentRange(response.headers.get("content-range"));
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      const size = contentRange?.total || (response.status === 200 ? contentLength : 0);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0] || "video/mp4";
      const acceptRanges = response.status === 206 || response.headers.get("accept-ranges") === "bytes";
      await response.body?.cancel().catch(() => {});

      if (size > MAX_VIDEO_BYTES) {
        throw new XhsError("视频超过 512 MB，浏览器本地合并可能占用过多内存。", 413);
      }

      return res.status(200).json({
        success: true,
        engine: "node",
        size,
        contentType,
        acceptRanges,
        chunkSize: MAX_CHUNK_BYTES
      });
    }

    if (action !== "chunk") throw new XhsError("不支持的视频操作。", 400);

    const start = parseSafeInteger(req.query.start, "start");
    const end = parseSafeInteger(req.query.end, "end");
    if (end < start) throw new XhsError("视频分段范围无效。", 400);
    if (end - start + 1 > MAX_CHUNK_BYTES) {
      throw new XhsError(`单个视频分段不能超过 ${MAX_CHUNK_BYTES} 字节。`, 413);
    }

    const response = await fetchVideo(sourceUrl, `bytes=${start}-${end}`);
    if (![200, 206].includes(response.status)) {
      throw new XhsError(`视频服务器返回 HTTP ${response.status}。`, 502);
    }

    const contentRange = parseContentRange(response.headers.get("content-range"));
    const declaredSize = Number(response.headers.get("content-length") ?? 0);

    if (response.status === 200 && start > 0) {
      await response.body?.cancel().catch(() => {});
      throw new XhsError("视频源不支持 Range 分段下载，请使用“打开视频”。", 409);
    }
    if (response.status === 200 && declaredSize > MAX_CHUNK_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new XhsError("视频源不支持 Range 分段下载，请使用“打开视频”。", 409);
    }

    const buffer = await readBufferWithLimit(response, MAX_CHUNK_BYTES);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Accept-Ranges", "bytes");
    if (contentRange) {
      res.setHeader("Content-Range", `bytes ${contentRange.start}-${contentRange.end}/${contentRange.total || "*"}`);
      if (contentRange.total) res.setHeader("X-Video-Total", String(contentRange.total));
    }
    return res.status(200).send(buffer);
  } catch (error) {
    const statusCode = error instanceof XhsError ? error.statusCode : 500;
    const message = error instanceof XhsError ? error.message : "Node.js 视频下载失败。";
    console.error("video error", error);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(statusCode).json({ success: false, engine: "node", message });
  }
}
