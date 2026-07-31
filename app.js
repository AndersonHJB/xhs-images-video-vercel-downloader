const state = {
  title: "小红书图片",
  images: [],
  videos: [],
  selected: new Set(),
  busy: false,
  engine: localStorage.getItem("xhs-engine") === "python" ? "python" : "node",
  strategy: ""
};

const elements = {
  form: document.querySelector("#parse-form"),
  textarea: document.querySelector("#share-text"),
  pasteButton: document.querySelector("#paste-button"),
  parseButton: document.querySelector("#parse-button"),
  emptyState: document.querySelector("#empty-state"),
  resultSection: document.querySelector("#result-section"),
  noteTitle: document.querySelector("#note-title"),
  resultMeta: document.querySelector("#result-meta"),
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
  copyLinksButton: document.querySelector("#copy-links-button"),
  downloadZipButton: document.querySelector("#download-zip-button"),
  progressPanel: document.querySelector("#progress-panel"),
  progressTitle: document.querySelector("#progress-title"),
  progressText: document.querySelector("#progress-text"),
  progressBar: document.querySelector("#progress-bar"),
  toast: document.querySelector("#toast"),
  engineInputs: [...document.querySelectorAll('input[name="engine"]')],
  engineHint: document.querySelector("#engine-hint")
};

function showToast(message, type = "info") {
  elements.toast.textContent = message;
  elements.toast.dataset.type = type;
  elements.toast.classList.add("toast-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(
    () => elements.toast.classList.remove("toast-visible"),
    3200
  );
}

function setParsing(isParsing) {
  state.busy = isParsing;
  elements.parseButton.disabled = isParsing;
  elements.parseButton.classList.toggle("is-loading", isParsing);
  elements.textarea.disabled = isParsing;
  for (const input of elements.engineInputs) input.disabled = isParsing;
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
    `已找到 ${parts.join("、")} · ${engineLabel()} 引擎${strategy}`;
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

async function fetchImageBlob(image) {
  const response = await fetch(proxyUrl(image));

  if (response.ok) return response.blob();

  if (response.status === 413) {
    try {
      const directResponse = await fetch(image.url, {
        mode: "cors",
        referrerPolicy: "no-referrer"
      });
      if (directResponse.ok) return directResponse.blob();
    } catch {
      // 继续抛出更明确的提示。
    }

    throw new Error(
      "图片超过 Vercel 单次响应限制，且浏览器无法跨域读取原图。请点击“打开原图”。"
    );
  }

  throw new Error(await readApiError(response));
}

async function downloadSingle(image) {
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
  elements.downloadVideoButton.disabled = true;
  elements.parseButton.disabled = true;
  elements.videoQuality.disabled = true;
  elements.selectAllButton.disabled = true;
  elements.copyLinksButton.disabled = true;
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
    elements.copyLinksButton.disabled = false;
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
  }

  const allSelected =
    state.images.length > 0 && state.selected.size === state.images.length;
  elements.selectAllButton.textContent = allSelected ? "取消全选" : "全部选择";
  elements.downloadZipButton.textContent = `下载所选 ZIP（${state.selected.size}）`;
  elements.downloadZipButton.disabled = state.selected.size === 0;
}

function renderResults() {
  elements.emptyState.hidden = true;
  elements.resultSection.hidden = false;
  elements.noteTitle.textContent = state.title;
  updateResultMeta();
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

// 无依赖 ZIP Store 实现。图片本身已经压缩，使用 Store 更快，
// 也避免依赖第三方 CDN 或 npm 包。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosTime, dosDate };
}

function makeZipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const { dosTime, dosDate } = dosDateTime();
  let localOffset = 0;
  let centralSize = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    centralSize += centralHeader.byteLength;
    localOffset += localHeader.byteLength + data.byteLength;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], {
    type: "application/zip"
  });
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
  elements.parseButton.disabled = true;
  for (const input of elements.engineInputs) input.disabled = true;
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

    setProgress(
      selectedImages.length,
      selectedImages.length,
      "正在浏览器中生成 ZIP 文件"
    );
    const zipBlob = makeZipBlob(files);
    triggerBlobDownload(zipBlob, `${sanitizeFilename(state.title)}.zip`);

    if (failures.length > 0) {
      showToast(
        `ZIP 已生成，其中 ${failures.length} 张因大小或网络限制未加入。`,
        "error"
      );
    } else {
      showToast("全部原图已打包，ZIP 开始保存。", "success");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.busy = false;
    elements.selectAllButton.disabled = false;
    elements.parseButton.disabled = false;
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
    state.images = payload.images || [];
    state.videos = payload.videos || [];
    state.strategy = payload.strategy || "";
    state.selected = new Set(state.images.map((image) => image.index));
    renderResults();
    const summary = [
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
  const allSelected = state.selected.size === state.images.length;
  state.selected = allSelected
    ? new Set()
    : new Set(state.images.map((image) => image.index));
  updateSelectionUI();
});

elements.copyLinksButton.addEventListener("click", async () => {
  const links = state.images
    .filter((image) => state.selected.has(image.index))
    .map((image) => image.url)
    .join("\n");

  if (!links) {
    showToast("请先选择图片。", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(links);
    showToast("所选原图链接已复制", "success");
  } catch {
    showToast("复制失败，请检查浏览器剪贴板权限。", "error");
  }
});

elements.videoQuality.addEventListener("change", updateVideoSelection);
elements.downloadVideoButton.addEventListener("click", downloadCurrentVideo);

elements.downloadZipButton.addEventListener("click", downloadSelectedZip);
