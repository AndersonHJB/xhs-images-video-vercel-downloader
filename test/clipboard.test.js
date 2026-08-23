import test from "node:test";
import assert from "node:assert/strict";

import {
  clipboardWriteFailureKind,
  clipboardWriteFailureMessage,
  refineClipboardWriteFailureKind
} from "../lib/clipboard.js";

function domError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

test("Chromium 多 ClipboardItem 拒绝会识别为浏览器限制而非权限错误", () => {
  const error = domError(
    "NotAllowedError",
    "Support for multiple ClipboardItems is not implemented."
  );

  assert.equal(clipboardWriteFailureKind(error, 6), "multiple-items");
  assert.match(clipboardWriteFailureMessage(error, 6), /权限已经生效/);
  assert.match(clipboardWriteFailureMessage(error, 6), /Chrome \/ Chromium/);
  assert.doesNotMatch(clipboardWriteFailureMessage(error, 6), /未授予/);
});

test("相同 NotAllowedError 在单图操作中仍按权限拒绝处理", () => {
  const error = domError("NotAllowedError", "Write permission denied.");

  assert.equal(clipboardWriteFailureKind(error, 1), "permission");
  assert.match(clipboardWriteFailureMessage(error, 1), /浏览器拒绝/);
});

test("多图失败且权限已授予时会按浏览器多项限制处理", () => {
  assert.equal(
    refineClipboardWriteFailureKind("permission", 6, "granted"),
    "multiple-items"
  );
  assert.equal(
    refineClipboardWriteFailureKind("permission", 1, "granted"),
    "permission"
  );
  assert.equal(
    refineClipboardWriteFailureKind("permission", 6, "denied"),
    "permission"
  );
});

test("页面失焦错误会提示用户回到当前页面", () => {
  const error = domError("NotAllowedError", "Document is not focused.");

  assert.equal(clipboardWriteFailureKind(error, 1), "not-focused");
  assert.match(clipboardWriteFailureMessage(error, 1), /保持本页面位于前台/);
});

test("Permissions Policy 错误与普通权限拒绝分开提示", () => {
  const error = domError(
    "NotAllowedError",
    "Clipboard write is blocked by Permissions Policy."
  );

  assert.equal(clipboardWriteFailureKind(error, 1), "permissions-policy");
  assert.match(clipboardWriteFailureMessage(error, 1), /剪贴板策略限制/);
});

test("不支持格式和未知失败保持独立分类", () => {
  const unsupported = domError("DataError", "image/png is not supported");
  const unknown = new Error("network conversion failed");

  assert.equal(clipboardWriteFailureKind(unsupported, 1), "unsupported-format");
  assert.match(clipboardWriteFailureMessage(unsupported, 1), /不支持图片剪贴板/);
  assert.equal(clipboardWriteFailureKind(unknown, 1), "unknown");
  assert.equal(clipboardWriteFailureMessage(unknown, 1), "");
});
