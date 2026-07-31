import {
  XhsError,
  buildNoWatermarkUrl,
  extractInputUrl,
  extractNoteId,
  extractOriginalAssetToken,
  fetchNotePage,
  isDirectImageUrl,
  parseNoteHtml,
  validateAssetToken
} from "../lib/xhs.js";

function readJsonBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "只支持 POST 请求。" });
  }

  try {
    const body = readJsonBody(req);
    const rawText = String(body.text ?? "").trim();

    if (!rawText) throw new XhsError("请粘贴小红书分享文案或链接。");
    if (rawText.length > 3000) throw new XhsError("输入内容过长。", 413);

    const inputUrl = extractInputUrl(rawText);

    if (isDirectImageUrl(inputUrl)) {
      const token = extractOriginalAssetToken(inputUrl);
      if (!token || !validateAssetToken(token)) {
        throw new XhsError("无法从图片地址中提取原始资源标识。");
      }

      return res.status(200).json({
        success: true,
        title: "小红书图片",
        count: 1,
        images: [{ index: 1, token, url: buildNoWatermarkUrl(token) }]
      });
    }

    const { finalUrl, html } = await fetchNotePage(inputUrl);
    const noteId = extractNoteId(finalUrl) || extractNoteId(inputUrl);

    if (!noteId) {
      throw new XhsError("无法从分享链接中识别当前笔记 ID。", 422);
    }

    const parsed = parseNoteHtml(html, { noteId });

    if (parsed.images.length === 0) {
      throw new XhsError(
        "没有解析到图片。笔记可能已删除、需要登录，或者小红书页面结构已更新。",
        422
      );
    }

    return res.status(200).json({
      success: true,
      title: parsed.title,
      noteId,
      strategy: parsed.strategy,
      count: parsed.images.length,
      images: parsed.images.map((image, index) => ({
        index: index + 1,
        token: image.token,
        url: image.url
      }))
    });
  } catch (error) {
    const statusCode = error instanceof XhsError ? error.statusCode : 500;
    const message = error instanceof XhsError
      ? error.message
      : "服务器解析失败，请稍后重试。";

    console.error("parse error", error);
    return res.status(statusCode).json({ success: false, message });
  }
}
