const MULTIPLE_ITEMS_PATTERN =
  /multiple\s+clipboarditems|multiple\s+(?:native\s+)?clipboard\s+items|more\s+than\s+one\s+clipboard\s*item/i;

const FOCUS_PATTERN =
  /document\s+is\s+not\s+focused|not\s+focused|must\s+be\s+focused/i;

const POLICY_PATTERN =
  /permissions?\s+policy|clipboard-write.+(?:disabled|disallowed|blocked)|blocked.+clipboard-write/i;

export function clipboardWriteFailureKind(error, imageCount = 1) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");

  if (imageCount > 1 && MULTIPLE_ITEMS_PATTERN.test(message)) {
    return "multiple-items";
  }
  if (FOCUS_PATTERN.test(message)) return "not-focused";
  if (POLICY_PATTERN.test(message)) return "permissions-policy";
  if (["NotSupportedError", "DataError"].includes(name)) {
    return "unsupported-format";
  }
  if (name === "NotAllowedError") return "permission";
  return "unknown";
}

export function refineClipboardWriteFailureKind(
  detectedKind,
  imageCount,
  permissionState
) {
  if (
    detectedKind === "permission" &&
    imageCount > 1 &&
    permissionState === "granted"
  ) {
    return "multiple-items";
  }
  return detectedKind;
}

export function clipboardWriteFailureMessageForKind(kind) {
  switch (kind) {
    case "multiple-items":
      return "多图未复制：剪贴板权限已经生效，但当前 Chrome / Chromium 暂不支持网页一次写入多张独立图片。请逐张复制，或下载 ZIP。";
    case "not-focused":
      return "图片未复制：请保持本页面位于前台，并直接点击复制按钮后重试。";
    case "permissions-policy":
      return "图片未复制：页面当前被浏览器的剪贴板策略限制，请在本站顶层页面中重试。";
    case "permission":
      return "图片未复制：浏览器拒绝了剪贴板写入，请确认本站剪贴板权限后重试。";
    case "unsupported-format":
      return "图片未复制：当前浏览器或目标格式不支持图片剪贴板，请下载原图或复制链接。";
    default:
      return "";
  }
}

export function clipboardWriteFailureMessage(error, imageCount = 1) {
  return clipboardWriteFailureMessageForKind(
    clipboardWriteFailureKind(error, imageCount)
  );
}
