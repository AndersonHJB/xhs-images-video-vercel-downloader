import { makeNoteTextFileData, makeZipBlob } from "./lib/archive.js";
import {
  clipboardWriteFailureKind,
  clipboardWriteFailureMessageForKind,
  refineClipboardWriteFailureKind
} from "./lib/clipboard.js";

const state = {
  title: "小红书图片",
  content: "",
  noteId: "",
  sourceUrl: "",
  parseEngine: "node",
  images: [],
  videos: [],
  selected: new Set(),
  busy: false,
  multipleClipboardItemsSupported: null,
  engine: localStorage.getItem("xhs-engine") === "python" ? "python" : "node",
  strategy: ""
};

const MAX_CLIPBOARD_IMAGES = 12;
const MAX_CLIPBOARD_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_CLIPBOARD_PIXELS = 20_000_000;
const MAX_CLIPBOARD_TOTAL_BYTES = 120 * 1024 * 1024;
const CLIPBOARD_IMAGE_TIMEOUT_MS = 20_000;
const CLIPBOARD_WRITE_TIMEOUT_MS = 30_000;
const IMAGE_HEADER_INSPECTION_BYTES = 1024 * 1024;

const elements = {
  form: document.querySelector("#parse-form"),
  textarea: document.querySelector("#share-text"),
  pasteButton: document.querySelector("#paste-button"),
  parseButton: document.querySelector("#parse-button"),
  emptyState: document.querySelector("#empty-state"),
  resultSection: document.querySelector("#result-section"),
  noteTitle: document.querySelector("#note-title"),
  resultMeta: document.querySelector("#result-meta"),
  captionSection: document.querySelector("#caption-section"),
  noteCaption: document.querySelector("#note-caption"),
  copyCaptionButton: document.querySelector("#copy-caption-button"),
  imageActions: document.querySelector("#image-actions"),
  imageSection: document.querySelector("#image-section"),
  imageGrid: document.querySelector("#image-grid"),
  videoSection: document.querySelector("#video-section"),
  videoPlayer: document.querySelector("#video-player"),
  videoQuality: document.querySelector("#video-quality"),
  videoMeta: document.querySelector("#video-meta"),
  downloadVideoButton: document.querySelector("#download-video-button"),
  openVideoLink: document.querySelector("#open-video-link"),
  selectAllButton: document.querySelector("#select-all-button"),
  copySelectedImagesButton: document.querySelector("#copy-selected-images-button"),
  clipboardFallback: document.querySelector("#clipboard-fallback"),
  copyFirstSelectedImageButton: document.querySelector(
    "#copy-first-selected-image-button"
  ),
  copyLinksButton: document.querySelector("#copy-links-button"),
  downloadZipButton: document.querySelector("#download-zip-button"),
  progressPanel: document.querySelector("#progress-panel"),
  progressTitle: document.querySelector("#progress-title"),
  progressText: document.querySelector("#progress-text"),
  progressBar: document.querySelector("#progress-bar"),
  toast: document.querySelector("#toast"),
  alertToast: document.querySelector("#alert-toast"),
  engineInputs: [...document.querySelectorAll('input[name="engine"]')],
  engineHint: document.querySelector("#engine-hint")
};

function showToast(message, type = "info", duration = 3200) {
  const target = type === "error" ? elements.alertToast : elements.toast;
  const inactive = type === "error" ? elements.toast : elements.alertToast;

  inactive.classList.remove("toast-visible");
  inactive.textContent = "";
  target.textContent = message;
  target.dataset.type = type;
  target.classList.add("toast-visible");
  clearTimeout(showToast.timer);
  clearTimeout(showToast.clearTimer);
  showToast.timer = setTimeout(
    () => {
      target.classList.remove("toast-visible");
      showToast.clearTimer = setTimeout(() => {
        if (!target.classList.contains("toast-visible") && target.textContent === message) {
          target.textContent = "";
        }
      }, 220);
    },
    duration
  );
}

function setParsing(isParsing) {
  state.busy = isParsing;
  elements.parseButton.disabled = isParsing;
  elements.parseButton.classList.toggle("is-loading", isParsing);
  elements.textarea.disabled = isParsing;
  elements.videoQuality.disabled = isParsing;
  elements.downloadVideoButton.disabled = isParsing;
  for (const input of elements.engineInputs) input.disabled = isParsing;
  updateSelectionUI();
}

function sanitizeFilename(value) {
  return (
    String(value || "小红书原图")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "小红书原图"
  );
}

function imageFilename(image) {
  return `${String(image.index).padStart(2, "0")}.jpg`;
}

function extractSourceUrl(text) {
  const match = String(text ?? "").match(/https?:\/\/[^\s<>'"”]+/i);
  return match?.[0].replace(/[.,;:!?\])}，。！？；：）】》]+$/g, "") || "";
}

function noteClipboardText() {
  const title = String(state.title || "").trim();
  const content = String(state.content || "").trim();

  if (!content) return title;
  if (!title || content === title || content.startsWith(`${title}\n`)) return content;
  return `${title}\n\n${content}`;
}

function noteTextFileData() {
  return makeNoteTextFileData({
    title: state.title,
    content: state.content,
    sourceUrl: state.sourceUrl,
    engine: engineLabel(state.parseEngine)
  });
}

function fallbackCopyText(text) {
  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  let copied = false;
  try {
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("浏览器未允许复制文本。");
}

async function writeTextToClipboard(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      try {
        fallbackCopyText(text);
        return;
      } catch {
        throw error;
      }
    }
  }
  fallbackCopyText(text);
}

function textClipboardErrorMessage(error, label) {
  if (!window.isSecureContext) {
    return `${label}未复制：请通过 HTTPS 或 localhost 打开页面，或手动选择文本复制。`;
  }
  if (error?.name === "NotAllowedError") {
    return `${label}未复制：浏览器未授予剪贴板权限，请允许访问后重试。`;
  }
  if (["NotSupportedError", "DataError"].includes(error?.name)) {
    return `${label}未复制：当前浏览器不支持该剪贴板操作，请手动选择文本复制。`;
  }
  return `${label}未复制：${error?.message || "浏览器拒绝了剪贴板写入"} 请手动选择文本复制。`;
}

async function copyTextAction({ text, trigger, label, successMessage }) {
  if (state.busy || !text) return;

  state.busy = true;
  trigger?.setAttribute("aria-busy", "true");
  elements.parseButton.disabled = true;
  elements.videoQuality.disabled = true;
  elements.downloadVideoButton.disabled = true;
  for (const input of elements.engineInputs) input.disabled = true;
  updateSelectionUI();

  try {
    await writeTextToClipboard(text);
    showToast(successMessage, "success");
  } catch (error) {
    showToast(textClipboardErrorMessage(error, label), "error", 6200);
  } finally {
    state.busy = false;
    trigger?.removeAttribute("aria-busy");
    elements.parseButton.disabled = false;
    elements.videoQuality.disabled = false;
    elements.downloadVideoButton.disabled = false;
    for (const input of elements.engineInputs) input.disabled = false;
    updateSelectionUI();
    trigger?.focus({ preventScroll: true });
  }
}

function engineLabel(engine = state.engine) {
  return engine === "python" ? "Python" : "Node.js";
}

function updateEngineUI() {
  for (const input of elements.engineInputs) {
    input.checked = input.value === state.engine;
  }

  elements.engineHint.textContent = state.engine === "python"
    ? "当前使用 Python 完成页面抓取、图片代理和视频分段下载。"
    : "当前使用 Node.js 完成页面抓取、图片代理和视频分段下载。";
}

function updateResultMeta() {
  if (!state.images.length && !state.videos.length) return;
  const strategy = state.strategy ? ` · ${state.strategy}` : "";
  const parts = [];
  if (state.images.length) parts.push(`${state.images.length} 张无水印原图`);
  if (state.videos.length) parts.push(`${state.videos.length} 个视频清晰度`);
  elements.resultMeta.textContent =
    `已找到 ${parts.join("、")} · ${engineLabel(state.parseEngine)} 引擎${strategy}`;
}

function proxyUrl(image) {
  const params = new URLSearchParams({
    token: image.token,
    name: imageFilename(image)
  });
  const endpoint = state.engine === "python"
    ? "/api/python_image"
    : "/api/image";
  return `${endpoint}?${params.toString()}`;
}

function setProgress(current, total, title = "正在下载并打包") {
  elements.progressPanel.hidden = false;
  elements.progressTitle.textContent = title;
  elements.progressText.textContent = `${current} / ${total}`;
  elements.progressBar.style.width = `${
    total ? Math.round((current / total) * 100) : 0
  }%`;
}

function hideProgress() {
  elements.progressPanel.hidden = true;
  elements.progressBar.style.width = "0%";
}

function triggerBlobDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}

async function readApiError(response) {
  try {
    const body = await response.json();
    return body.message || `请求失败：HTTP ${response.status}`;
  } catch {
    return `请求失败：HTTP ${response.status}`;
  }
}

async function responseBlobWithLimit(response, maxBytes = 0) {
  const contentType = response.headers.get("content-type") || "";
  if (!maxBytes) return response.blob();

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error("单张原图超过 30 MB，请改用下载原图或 ZIP。");
    error.name = "ImageTooLargeError";
    throw error;
  }

  if (!response.body?.getReader) {
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      const error = new Error("单张原图超过 30 MB，请改用下载原图或 ZIP。");
      error.name = "ImageTooLargeError";
      throw error;
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        const error = new Error("单张原图超过 30 MB，请改用下载原图或 ZIP。");
        error.name = "ImageTooLargeError";
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  return new Blob(chunks, { type: contentType });
}

async function fetchImageBlob(image, { signal, maxBytes = 0 } = {}) {
  const response = await fetch(proxyUrl(image), { signal });

  if (response.ok) return responseBlobWithLimit(response, maxBytes);

  if (response.status === 413) {
    try {
      const directResponse = await fetch(image.url, {
        mode: "cors",
        referrerPolicy: "no-referrer",
        signal
      });
      if (directResponse.ok) {
        return responseBlobWithLimit(directResponse, maxBytes);
      }
    } catch (error) {
      if (["AbortError", "ImageTooLargeError"].includes(error?.name)) throw error;
      // 继续抛出更明确的提示。
    }

    throw new Error(
      "图片超过 Vercel 单次响应限制，且浏览器无法跨域读取原图。请点击“打开原图”。"
    );
  }

  throw new Error(await readApiError(response));
}

function imageClipboardCapabilityError() {
  if (!window.isSecureContext) {
    return "图片未复制：请通过 HTTPS 或 localhost 打开页面后重试。";
  }
  if (!navigator.clipboard?.write || typeof window.ClipboardItem !== "function") {
    return "图片未复制：当前浏览器不支持直接写入图片剪贴板，请下载原图或复制链接。";
  }
  if (
    typeof window.ClipboardItem.supports === "function" &&
    !window.ClipboardItem.supports("image/png")
  ) {
    return "图片未复制：当前浏览器剪贴板不支持 PNG 图片，请下载原图或复制链接。";
  }
  return "";
}

function abortError() {
  const error = new Error("图片复制任务已停止。");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function raceWithAbort(promise, signal, onLateResolve) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then(onLateResolve, () => {});
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          onLateResolve?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      }
    );
  });
}

function validateImageDimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    height > Math.floor(MAX_CLIPBOARD_PIXELS / width)
  ) {
    throw new Error("单张图片像素过大，无法安全写入剪贴板，请下载原图。");
  }
}

function imageDimensionsFromHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (offset, values) =>
    offset + values.length <= bytes.length &&
    values.every((value, index) => bytes[offset + index] === value);

  if (has(0, [0x89, 0x50, 0x4e, 0x47]) && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (
    bytes.length >= 10 &&
    (has(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      has(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
  ) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  if (has(0, [0xff, 0xd8])) {
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3)
        };
      }
      offset += segmentLength;
    }
  }

  if (
    bytes.length >= 30 &&
    has(0, [0x52, 0x49, 0x46, 0x46]) &&
    has(8, [0x57, 0x45, 0x42, 0x50])
  ) {
    if (has(12, [0x56, 0x50, 0x38, 0x58])) {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
      };
    }
    if (has(12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6))
      };
    }
    if (has(12, [0x56, 0x50, 0x38, 0x20]) && has(23, [0x9d, 0x01, 0x2a])) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff
      };
    }
  }

  // AVIF / HEIF 的 ispe 属性在解码前就能提供画布尺寸。
  for (let offset = 4; offset + 16 <= bytes.length; offset += 1) {
    if (has(offset, [0x69, 0x73, 0x70, 0x65])) {
      const boxSize = view.getUint32(offset - 4);
      if (boxSize < 20) continue;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (width && height) return { width, height };
    }
  }

  return null;
}

async function inspectImageDimensions(blob, signal) {
  const header = new Uint8Array(
    await raceWithAbort(
      blob.slice(0, IMAGE_HEADER_INSPECTION_BYTES).arrayBuffer(),
      signal
    )
  );
  return imageDimensionsFromHeader(header);
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器无法把这张图片转换为 PNG。"));
    }, "image/png");
  });
}

async function imageBlobToPng(blob, signal) {
  throwIfAborted(signal);
  if (!String(blob.type || "").startsWith("image/")) {
    throw new Error("原图响应不是可复制的图片格式。");
  }
  if (blob.size > MAX_CLIPBOARD_SOURCE_BYTES) {
    throw new Error("单张原图超过 30 MB，请改用下载原图或 ZIP。");
  }

  const headerDimensions = await inspectImageDimensions(blob, signal);
  if (headerDimensions) {
    validateImageDimensions(headerDimensions.width, headerDimensions.height);
  }

  async function drawToPng(source, width, height) {
    throwIfAborted(signal);
    validateImageDimensions(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图片转换画布。");
    try {
      context.drawImage(source, 0, 0);
      throwIfAborted(signal);
      return await raceWithAbort(canvasToPngBlob(canvas), signal);
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  if (typeof createImageBitmap === "function") {
    let bitmap = null;
    try {
      bitmap = await raceWithAbort(
        createImageBitmap(blob),
        signal,
        (lateBitmap) => lateBitmap?.close?.()
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // 个别浏览器的 createImageBitmap 格式覆盖少于 <img>，继续尝试后者。
    }
    if (bitmap) {
      try {
        return await drawToPng(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close?.();
      }
    }
  }

  const href = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.decoding = "async";
    const loadPromise = new Promise((resolve, reject) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("浏览器无法读取这张原图。")),
        { once: true }
      );
      image.src = href;
    });
    await raceWithAbort(loadPromise, signal);
    return await drawToPng(image, image.naturalWidth, image.naturalHeight);
  } finally {
    image.removeAttribute("src");
    URL.revokeObjectURL(href);
  }
}

async function clipboardPngBlob(image, operationSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromOperation = () => controller.abort();
  operationSignal?.addEventListener("abort", abortFromOperation, { once: true });
  if (operationSignal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CLIPBOARD_IMAGE_TIMEOUT_MS);

  try {
    return await imageBlobToPng(
      await fetchImageBlob(image, {
        signal: controller.signal,
        maxBytes: MAX_CLIPBOARD_SOURCE_BYTES
      }),
      controller.signal
    );
  } catch (error) {
    if (timedOut && error?.name === "AbortError") {
      throw new Error("读取单张原图超过 20 秒，已停止复制。请检查网络后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    operationSignal?.removeEventListener("abort", abortFromOperation);
  }
}

function createQueuedClipboardTasks(images) {
  let nextIndex = 0;
  let completed = 0;
  let totalBytes = 0;
  let started = false;
  let cancelled = false;
  const operationController = new AbortController();
  const deferred = images.map(() => {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    // 某些平台只消费第一个 ClipboardItem；仍要接住其他任务的失败。
    promise.catch(() => {});
    return { promise, resolve, reject, settled: false };
  });

  function settle(index, method, value) {
    const item = deferred[index];
    if (item.settled) return;
    item.settled = true;
    item[method](value);
  }

  async function worker() {
    while (!cancelled && nextIndex < images.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        const pngBlob = await clipboardPngBlob(
          images[index],
          operationController.signal
        );
        totalBytes += pngBlob.size;
        if (totalBytes > MAX_CLIPBOARD_TOTAL_BYTES) {
          throw new Error("所选图片转换后超过 120 MB，请减少勾选数量后重试。");
        }
        settle(index, "resolve", pngBlob);
      } catch (error) {
        if (error && typeof error === "object") error.clipboardStage = "conversion";
        settle(index, "reject", error);
      } finally {
        if (!cancelled) {
          completed += 1;
          setProgress(completed, images.length, "正在准备复制图片");
        }
      }
    }
  }

  function start() {
    if (started || cancelled) return;
    started = true;
    const workerCount = Math.min(2, images.length);
    for (let index = 0; index < workerCount; index += 1) void worker();
  }

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    operationController.abort();
    const error = new Error("图片复制任务已停止。");
    error.name = "AbortError";
    for (let index = 0; index < deferred.length; index += 1) {
      settle(index, "reject", error);
    }
  }

  return {
    promises: deferred.map((item) => item.promise),
    start,
    cancel
  };
}

async function writeImagesToClipboard(images) {
  const capabilityError = imageClipboardCapabilityError();
  if (capabilityError) throw new Error(capabilityError);

  setProgress(0, images.length, "正在准备复制图片");
  const tasks = createQueuedClipboardTasks(images);

  try {
    const clipboardItems = tasks.promises.map(
      (pngPromise) => new window.ClipboardItem({ "image/png": pngPromise })
    );

    // write() 必须仍在点击手势调用栈中触发；图片数据可通过 Promise 后续完成。
    const writePromise = navigator.clipboard.write(clipboardItems);
    // 超时后 writePromise 仍可能由系统结束，预先接住避免迟到拒绝泄漏。
    writePromise.catch(() => {});
    tasks.start();
    // 以平台实际的 write() 结果为准；Chromium 会直接拒绝多个 ClipboardItem。
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error("系统剪贴板 30 秒未完成写入，已停止这次复制。");
        error.name = "TimeoutError";
        reject(error);
      }, CLIPBOARD_WRITE_TIMEOUT_MS);
    });
    try {
      await Promise.race([writePromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    tasks.cancel();
  }
}

async function resolvedClipboardWriteFailureKind(error, imageCount) {
  const detectedKind = clipboardWriteFailureKind(error, imageCount);
  if (
    detectedKind !== "permission" ||
    imageCount <= 1 ||
    !navigator.permissions?.query
  ) {
    return detectedKind;
  }

  try {
    const permission = await navigator.permissions.query({
      name: "clipboard-write"
    });
    return refineClipboardWriteFailureKind(
      detectedKind,
      imageCount,
      permission.state
    );
  } catch {
    // 并非所有浏览器都在 Permissions API 中暴露 clipboard-write。
  }
  return detectedKind;
}

function imageClipboardErrorMessage(error, imageCount = 1, failureKind = null) {
  const capabilityError = imageClipboardCapabilityError();
  if (capabilityError) return capabilityError;
  const writeFailureMessage = clipboardWriteFailureMessageForKind(
    failureKind || clipboardWriteFailureKind(error, imageCount)
  );
  if (writeFailureMessage) return writeFailureMessage;
  if (error?.clipboardStage === "conversion" && imageCount > 1) {
    return `多图复制未完整完成：${error.message || "至少一张原图读取失败"} 请减少勾选、逐张复制或下载 ZIP。`;
  }
  return `图片未复制：${error?.message || "读取原图失败"} 可改用下载原图、打开原图或复制链接。`;
}

async function copyImages(images, trigger) {
  if (state.busy || images.length === 0) return;

  if (images.length > MAX_CLIPBOARD_IMAGES) {
    showToast(
      `为避免浏览器内存过高，一次最多复制 ${MAX_CLIPBOARD_IMAGES} 张图片。请减少勾选数量，或直接下载 ZIP。`,
      "error",
      7200
    );
    return;
  }

  const capabilityError = imageClipboardCapabilityError();
  if (capabilityError) {
    showToast(capabilityError, "error", 6200);
    return;
  }

  state.busy = true;
  trigger?.setAttribute("aria-busy", "true");
  elements.parseButton.disabled = true;
  elements.videoQuality.disabled = true;
  elements.downloadVideoButton.disabled = true;
  for (const input of elements.engineInputs) input.disabled = true;
  updateSelectionUI();

  try {
    await writeImagesToClipboard(images);
    if (images.length === 1) {
      showToast("图片已写入剪贴板，可以直接粘贴。", "success");
    } else {
      state.multipleClipboardItemsSupported = true;
      showToast(
        "浏览器已接收所选图片；目标应用若只粘贴一张，请逐张复制或下载 ZIP。",
        "success",
        7200
      );
    }
  } catch (error) {
    const failureKind = await resolvedClipboardWriteFailureKind(
      error,
      images.length
    );
    if (failureKind === "multiple-items") {
      state.multipleClipboardItemsSupported = false;
      updateSelectionUI();
    }
    showToast(
      imageClipboardErrorMessage(error, images.length, failureKind),
      "error",
      7200
    );
  } finally {
    state.busy = false;
    trigger?.removeAttribute("aria-busy");
    elements.parseButton.disabled = false;
    elements.videoQuality.disabled = false;
    elements.downloadVideoButton.disabled = false;
    for (const input of elements.engineInputs) input.disabled = false;
    hideProgress();
    updateSelectionUI();
    trigger?.focus({ preventScroll: true });
  }
}

async function downloadSingle(image) {
  if (state.busy) return;
  try {
    showToast(`正在下载第 ${image.index} 张图片……`);
    const blob = await fetchImageBlob(image);
    triggerBlobDownload(blob, imageFilename(image));
    showToast(`第 ${image.index} 张图片已开始保存`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}


function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小未知";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function currentVideo() {
  if (!state.videos.length) return null;
  const selected = Number(elements.videoQuality.value || 1);
  return state.videos.find((video) => video.index === selected) || state.videos[0];
}

function videoFilename() {
  return `${sanitizeFilename(state.title || "小红书视频")}.mp4`;
}

function videoApiUrl(action, sourceUrl, extra = {}) {
  const endpoint = state.engine === "python" ? "/api/python_video" : "/api/video";
  const params = new URLSearchParams({ action, url: sourceUrl, ...extra });
  return `${endpoint}?${params.toString()}`;
}

function updateVideoSelection() {
  const video = currentVideo();
  if (!video) return;

  elements.videoPlayer.src = video.url;
  elements.videoPlayer.poster = state.images[0]?.url || "";
  elements.openVideoLink.href = video.url;
  const resolution = video.width && video.height ? `${video.width}×${video.height}` : "原始清晰度";
  const codec = String(video.codec || "video").toUpperCase();
  elements.videoMeta.textContent = `${resolution} · ${codec} · ${formatBytes(video.size)}`;
  elements.videoPlayer.load();
}

function renderVideo() {
  const hasVideo = state.videos.length > 0;
  elements.videoSection.hidden = !hasVideo;
  if (!hasVideo) {
    elements.videoPlayer.removeAttribute("src");
    elements.videoPlayer.load();
    elements.videoQuality.replaceChildren();
    return;
  }

  elements.videoQuality.replaceChildren();
  for (const video of state.videos) {
    const option = document.createElement("option");
    option.value = String(video.index);
    option.textContent = video.label || `视频线路 ${video.index}`;
    option.selected = Boolean(video.isDefault);
    elements.videoQuality.append(option);
  }
  updateVideoSelection();
}

async function readVideoApiError(response) {
  try {
    const body = await response.json();
    return body.message || `视频请求失败：HTTP ${response.status}`;
  } catch {
    return `视频请求失败：HTTP ${response.status}`;
  }
}

async function getVideoMeta(sourceUrl, fallbackSize = 0) {
  const response = await fetch(videoApiUrl("meta", sourceUrl));
  if (!response.ok) throw new Error(await readVideoApiError(response));
  const meta = await response.json();
  const size = Number(meta.size || fallbackSize || 0);
  if (!size) throw new Error("无法确定视频大小，不能安全执行分段下载。");
  return {
    size,
    contentType: meta.contentType || "video/mp4",
    chunkSize: Math.min(Number(meta.chunkSize || 3_500_000), 3_500_000)
  };
}

async function downloadVideoByChunks(sourceUrl, video) {
  const meta = await getVideoMeta(sourceUrl, video.size);
  const chunks = [];
  const totalChunks = Math.ceil(meta.size / meta.chunkSize);

  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * meta.chunkSize;
    const end = Math.min(meta.size - 1, start + meta.chunkSize - 1);
    setProgress(
      index,
      totalChunks,
      `正在分段下载视频 ${formatBytes(start)} / ${formatBytes(meta.size)}`
    );

    const response = await fetch(
      videoApiUrl("chunk", sourceUrl, {
        start: String(start),
        end: String(end)
      })
    );
    if (!response.ok) throw new Error(await readVideoApiError(response));

    const buffer = await response.arrayBuffer();
    const expected = end - start + 1;
    if (buffer.byteLength !== expected && end !== meta.size - 1) {
      throw new Error(`视频第 ${index + 1} 段长度异常。`);
    }
    chunks.push(new Uint8Array(buffer));
    setProgress(
      index + 1,
      totalChunks,
      `正在分段下载视频 ${formatBytes(Math.min(meta.size, end + 1))} / ${formatBytes(meta.size)}`
    );
  }

  return new Blob(chunks, { type: meta.contentType || "video/mp4" });
}

async function tryDirectVideoDownload(sourceUrl) {
  const response = await fetch(sourceUrl, {
    mode: "cors",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok) throw new Error(`视频 CDN 返回 HTTP ${response.status}`);
  return response.blob();
}

async function downloadCurrentVideo() {
  if (state.busy) return;
  const video = currentVideo();
  if (!video) {
    showToast("当前笔记没有可下载的视频。", "error");
    return;
  }

  state.busy = true;
  updateSelectionUI();
  elements.downloadVideoButton.disabled = true;
  elements.parseButton.disabled = true;
  elements.videoQuality.disabled = true;
  elements.selectAllButton.disabled = true;
  elements.copySelectedImagesButton.disabled = true;
  elements.copyLinksButton.disabled = true;
  elements.copyCaptionButton.disabled = true;
  elements.downloadZipButton.disabled = true;
  for (const input of elements.engineInputs) input.disabled = true;

  const candidates = [video.url, ...(video.backupUrls || [])].filter(Boolean);
  let lastError = null;

  try {
    for (const sourceUrl of candidates) {
      try {
        const blob = await downloadVideoByChunks(sourceUrl, video);
        triggerBlobDownload(blob, videoFilename());
        showToast("视频已经合并完成并开始保存", "success");
        return;
      } catch (error) {
        lastError = error;
      }
    }

    // CDN 不支持 Range 或分段接口受限时，再尝试浏览器直连。
    try {
      const blob = await tryDirectVideoDownload(video.url);
      triggerBlobDownload(blob, videoFilename());
      showToast("视频已通过浏览器直连开始保存", "success");
      return;
    } catch (error) {
      lastError = error;
    }

    window.open(video.url, "_blank", "noopener,noreferrer");
    throw new Error(
      `${lastError?.message || "自动下载失败"}，已打开视频原地址，可在新页面中保存。`
    );
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.busy = false;
    elements.downloadVideoButton.disabled = false;
    elements.parseButton.disabled = false;
    elements.videoQuality.disabled = false;
    elements.selectAllButton.disabled = false;
    elements.copySelectedImagesButton.disabled = false;
    elements.copyLinksButton.disabled = false;
    elements.copyCaptionButton.disabled = false;
    for (const input of elements.engineInputs) input.disabled = false;
    hideProgress();
    updateSelectionUI();
  }
}

function updateSelectionUI() {
  const checkboxes = elements.imageGrid.querySelectorAll(
    'input[type="checkbox"]'
  );

  for (const checkbox of checkboxes) {
    checkbox.checked = state.selected.has(Number(checkbox.dataset.index));
    checkbox.disabled = state.busy;
  }

  for (const button of elements.imageGrid.querySelectorAll("button")) {
    button.disabled = state.busy;
  }

  const allSelected =
    state.images.length > 0 && state.selected.size === state.images.length;
  const selectedCount = state.selected.size;
  const noSelection = selectedCount === 0;
  const firstSelectedImage = state.images.find((image) =>
    state.selected.has(image.index)
  );
  const multipleItemsBlocked =
    state.multipleClipboardItemsSupported === false && selectedCount > 1;
  elements.selectAllButton.textContent = allSelected ? "取消全选" : "全部选择";
  elements.copySelectedImagesButton.textContent = multipleItemsBlocked
    ? `多图复制受限（${selectedCount}）`
    : `复制图片（${selectedCount}）`;
  elements.copySelectedImagesButton.setAttribute(
    "aria-label",
    multipleItemsBlocked
      ? `当前浏览器不支持一次复制 ${selectedCount} 张独立图片`
      : `复制所选图片（${selectedCount} 张）`
  );
  elements.copySelectedImagesButton.setAttribute(
    "aria-describedby",
    multipleItemsBlocked
      ? "clipboard-fallback-title clipboard-hint"
      : "clipboard-hint"
  );
  elements.copyLinksButton.textContent = `复制链接（${selectedCount}）`;
  elements.downloadZipButton.textContent = `下载 ZIP（${selectedCount}）`;
  elements.selectAllButton.disabled = state.busy || state.images.length === 0;
  elements.copySelectedImagesButton.disabled =
    state.busy || noSelection || multipleItemsBlocked;
  elements.clipboardFallback.hidden = !multipleItemsBlocked;
  elements.copyFirstSelectedImageButton.textContent = firstSelectedImage
    ? `复制第 ${firstSelectedImage.index} 张`
    : "复制首张";
  elements.copyFirstSelectedImageButton.disabled =
    state.busy || !firstSelectedImage;
  elements.copyLinksButton.disabled = state.busy || noSelection;
  elements.downloadZipButton.disabled = state.busy || noSelection;
  elements.copyCaptionButton.disabled = state.busy || !String(state.content || "").trim();
}

function renderCaption() {
  const content = String(state.content || "").trim();
  elements.captionSection.hidden = !content;
  elements.noteCaption.textContent = content;
  elements.copyCaptionButton.disabled = !content;
}

function renderResults() {
  elements.emptyState.hidden = true;
  elements.resultSection.hidden = false;
  elements.noteTitle.textContent = state.title;
  updateResultMeta();
  renderCaption();
  renderVideo();

  const hasImages = state.images.length > 0;
  elements.imageActions.hidden = !hasImages;
  elements.imageSection.hidden = !hasImages;
  elements.imageGrid.replaceChildren();

  for (const image of state.images) {
    const card = document.createElement("article");
    card.className = "image-card";
    card.innerHTML = `
      <label class="select-control" title="选择第 ${image.index} 张图片">
        <input type="checkbox" data-index="${image.index}" checked />
        <span></span>
      </label>
      <div class="image-frame">
        <img src="${image.url}" alt="第 ${image.index} 张原图预览" loading="lazy" referrerpolicy="no-referrer" />
        <span class="image-number">${String(image.index).padStart(2, "0")}</span>
      </div>
      <div class="image-card-actions">
        <button class="card-button download-one" type="button">下载原图</button>
        <button class="card-button card-button-copy copy-image" type="button" aria-label="复制第 ${image.index} 张图片">复制图片</button>
        <a class="card-button card-button-muted" href="${image.url}" target="_blank" rel="noopener noreferrer">打开原图</a>
      </div>
    `;

    card
      .querySelector('input[type="checkbox"]')
      .addEventListener("change", (event) => {
        const index = Number(event.currentTarget.dataset.index);
        if (event.currentTarget.checked) state.selected.add(index);
        else state.selected.delete(index);
        updateSelectionUI();
      });

    card
      .querySelector(".download-one")
      .addEventListener("click", () => downloadSingle(image));
    const copyButton = card.querySelector(".copy-image");
    copyButton.addEventListener("click", () => copyImages([image], copyButton));
    elements.imageGrid.append(card);
  }

  updateSelectionUI();
  elements.resultSection.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

async function parseShareText(text, engine) {
  const endpoint = engine === "python"
    ? "/api/python_parse"
    : "/api/parse";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || `解析失败：HTTP ${response.status}`);
  }

  return payload;
}

async function downloadSelectedZip() {
  if (state.busy) return;

  const selectedImages = state.images.filter((image) =>
    state.selected.has(image.index)
  );
  if (selectedImages.length === 0) {
    showToast("请先选择至少一张图片。", "error");
    return;
  }

  state.busy = true;
  elements.downloadZipButton.disabled = true;
  elements.selectAllButton.disabled = true;
  elements.copySelectedImagesButton.disabled = true;
  elements.copyLinksButton.disabled = true;
  elements.copyCaptionButton.disabled = true;
  elements.parseButton.disabled = true;
  elements.videoQuality.disabled = true;
  elements.downloadVideoButton.disabled = true;
  for (const input of elements.engineInputs) input.disabled = true;
  updateSelectionUI();
  const files = [];
  const failures = [];

  try {
    setProgress(0, selectedImages.length);

    for (let offset = 0; offset < selectedImages.length; offset += 1) {
      const image = selectedImages[offset];
      setProgress(
        offset,
        selectedImages.length,
        `正在下载第 ${image.index} 张原图`
      );

      try {
        const blob = await fetchImageBlob(image);
        files.push({
          name: imageFilename(image),
          data: new Uint8Array(await blob.arrayBuffer())
        });
      } catch (error) {
        failures.push({ image, message: error.message });
      }

      setProgress(offset + 1, selectedImages.length);
    }

    if (files.length === 0) {
      throw new Error(failures[0]?.message || "所有图片均下载失败。");
    }

    files.push({
      name: "文案.txt",
      data: noteTextFileData()
    });

    setProgress(
      selectedImages.length,
      selectedImages.length,
      "正在浏览器中生成 ZIP 文件"
    );
    const zipBlob = makeZipBlob(files);
    triggerBlobDownload(zipBlob, `${sanitizeFilename(state.title)}.zip`);

    if (failures.length > 0) {
      showToast(
        `ZIP 与文案 TXT 已生成，其中 ${failures.length} 张因大小或网络限制未加入。`,
        "error"
      );
    } else {
      showToast("全部原图与文案 TXT 已打包，ZIP 开始保存。", "success");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.busy = false;
    elements.selectAllButton.disabled = false;
    elements.copySelectedImagesButton.disabled = false;
    elements.copyLinksButton.disabled = false;
    elements.copyCaptionButton.disabled = false;
    elements.parseButton.disabled = false;
    elements.videoQuality.disabled = false;
    elements.downloadVideoButton.disabled = false;
    for (const input of elements.engineInputs) input.disabled = false;
    hideProgress();
    updateSelectionUI();
  }
}

for (const input of elements.engineInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    state.engine = input.value === "python" ? "python" : "node";
    localStorage.setItem("xhs-engine", state.engine);
    updateEngineUI();
    updateResultMeta();
    showToast(`已切换到 ${engineLabel()} 后台`, "success");
  });
}

updateEngineUI();

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.textarea.value.trim();

  if (!text) {
    showToast("请先粘贴小红书分享文案或链接。", "error");
    elements.textarea.focus();
    return;
  }

  const selectedEngine = elements.engineInputs.find((input) => input.checked)?.value || "node";
  state.engine = selectedEngine === "python" ? "python" : "node";
  localStorage.setItem("xhs-engine", state.engine);
  updateEngineUI();

  setParsing(true);
  showToast(`正在使用 ${engineLabel()} 解析公开笔记页面……`);

  try {
    const payload = await parseShareText(text, state.engine);
    state.title = payload.title || "小红书媒体";
    state.content = typeof payload.content === "string" ? payload.content.trim() : "";
    state.noteId = String(payload.noteId || "");
    state.sourceUrl = extractSourceUrl(text);
    state.parseEngine = payload.engine === "python" ? "python" : "node";
    state.images = payload.images || [];
    state.videos = payload.videos || [];
    state.strategy = payload.strategy || "";
    state.selected = new Set(state.images.map((image) => image.index));
    renderResults();
    const summary = [
      state.content ? "完整文案" : "",
      state.images.length ? `${state.images.length} 张无水印原图` : "",
      state.videos.length ? `${state.videos.length} 个视频清晰度` : ""
    ].filter(Boolean).join("、");
    showToast(`${engineLabel()} 成功解析${summary ? `：${summary}` : ""}`, "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setParsing(false);
  }
});

elements.pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    elements.textarea.value = text;
    elements.textarea.focus();
    showToast("已粘贴剪贴板内容", "success");
  } catch {
    showToast("浏览器未授予剪贴板权限，请手动粘贴。", "error");
  }
});

elements.selectAllButton.addEventListener("click", () => {
  if (state.busy) return;
  const allSelected = state.selected.size === state.images.length;
  state.selected = allSelected
    ? new Set()
    : new Set(state.images.map((image) => image.index));
  updateSelectionUI();
});

elements.copyCaptionButton.addEventListener("click", (event) => {
  if (state.busy) return;
  const text = noteClipboardText();
  if (!state.content || !text) {
    showToast("当前笔记没有可复制的正文文案。", "error");
    return;
  }
  void copyTextAction({
    text,
    trigger: event.currentTarget,
    label: "文案",
    successMessage: "笔记标题与完整文案已复制"
  });
});

elements.copySelectedImagesButton.addEventListener("click", (event) => {
  const selectedImages = state.images.filter((image) =>
    state.selected.has(image.index)
  );
  void copyImages(selectedImages, event.currentTarget);
});

elements.copyFirstSelectedImageButton.addEventListener("click", (event) => {
  const firstSelectedImage = state.images.find((image) =>
    state.selected.has(image.index)
  );
  if (!firstSelectedImage) {
    showToast("请先选择至少一张图片。", "error");
    return;
  }
  void copyImages([firstSelectedImage], event.currentTarget);
});

elements.copyLinksButton.addEventListener("click", (event) => {
  if (state.busy) return;
  const links = state.images
    .filter((image) => state.selected.has(image.index))
    .map((image) => image.url)
    .join("\n");

  if (!links) {
    showToast("请先选择图片。", "error");
    return;
  }

  void copyTextAction({
    text: links,
    trigger: event.currentTarget,
    label: "链接",
    successMessage: "所选原图链接已复制"
  });
});

elements.videoQuality.addEventListener("change", updateVideoSelection);
elements.downloadVideoButton.addEventListener("click", downloadCurrentVideo);

elements.downloadZipButton.addEventListener("click", downloadSelectedZip);
