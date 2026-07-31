import { XhsError, buildNoWatermarkUrl, validateAssetToken } from "../lib/xhs.js";

const MAX_IMAGE_BYTES = 4_200_000;

function safeFilename(value) {
  const name = String(value ?? "image.jpg")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 80);
  return name || "image.jpg";
}

async function readBufferWithLimit(response) {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_IMAGE_BYTES) {
    throw new XhsError("原图超过 Vercel 单次响应限制，请使用原图直链下载。", 413);
  }

  if (!response.body) throw new XhsError("图片响应为空。", 502);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new XhsError("原图超过 Vercel 单次响应限制，请使用原图直链下载。", 413);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XHS-Engine", "node");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "只支持 GET 请求。" });
  }

  try {
    const token = String(req.query.token ?? "");
    if (!validateAssetToken(token)) throw new XhsError("图片资源标识无效。");

    const sourceUrl = buildNoWatermarkUrl(token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(sourceUrl, {
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: "https://www.xiaohongshu.com/"
        },
        redirect: "follow",
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new XhsError("下载原图超时。", 504);
      throw new XhsError(`下载原图失败：${error.message}`, 502);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new XhsError(`原图服务器返回 HTTP ${response.status}。`, 502);
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0] || "image/jpeg";
    if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      throw new XhsError("原图服务器返回的不是图片。", 502);
    }

    const buffer = await readBufferWithLimit(response);
    const filename = safeFilename(req.query.name ?? "image.jpg");

    res.setHeader("Content-Type", contentType === "application/octet-stream" ? "image/jpeg" : contentType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (error) {
    const statusCode = error instanceof XhsError ? error.statusCode : 500;
    const message = error instanceof XhsError ? error.message : "下载图片失败。";

    console.error("image error", error);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(statusCode).json({ success: false, message });
  }
}
