// 图片本身已经压缩，ZIP 使用 Store 模式，避免引入第三方依赖。
const ZIP16_MAX = 0xffff;
const ZIP32_MAX = 0xffffffff;
const ZIP_END_SIZE = 22;
const TEXT_ENCODER = new TextEncoder();

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
  const validDate = date instanceof Date && Number.isFinite(date.getTime())
    ? date
    : new Date();
  const year = Math.min(2107, Math.max(1980, validDate.getFullYear()));
  const dosTime =
    (validDate.getHours() << 11) |
    (validDate.getMinutes() << 5) |
    Math.floor(validDate.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((validDate.getMonth() + 1) << 5) |
    validDate.getDate();
  return { dosTime, dosDate };
}

function zipFormatError(message) {
  const error = new Error(message);
  error.name = "ZipFormatError";
  return error;
}

function prepareStoredZipFiles(files) {
  if (!Array.isArray(files)) {
    throw zipFormatError("ZIP 文件列表必须是数组。");
  }
  if (files.length > ZIP16_MAX) {
    throw zipFormatError("ZIP 文件数量超过 Store/ZIP32 格式上限。");
  }

  let localSize = 0;
  let centralSize = 0;
  const prepared = files.map((file) => {
    const name = String(file?.name || "");
    if (!name) throw zipFormatError("ZIP 内部文件名不能为空。");
    const nameBytes = TEXT_ENCODER.encode(name);
    if (nameBytes.byteLength > ZIP16_MAX) {
      throw zipFormatError(`ZIP 内部文件名过长：${name.slice(0, 80)}`);
    }

    const data = file?.data;
    if (!(data instanceof Uint8Array)) {
      throw zipFormatError(`ZIP 文件 ${name} 的数据必须是 Uint8Array。`);
    }
    if (!Number.isSafeInteger(data.byteLength) || data.byteLength > ZIP32_MAX) {
      throw zipFormatError(`ZIP 文件 ${name} 超过 ZIP32 单文件上限。`);
    }

    localSize += 30 + nameBytes.byteLength + data.byteLength;
    centralSize += 46 + nameBytes.byteLength;
    if (
      !Number.isSafeInteger(localSize)
      || !Number.isSafeInteger(centralSize)
      || localSize > ZIP32_MAX
      || centralSize > ZIP32_MAX
    ) {
      throw zipFormatError("ZIP 归档超过 Store/ZIP32 体积上限。");
    }

    return { name, nameBytes, data };
  });

  const totalSize = localSize + centralSize + ZIP_END_SIZE;
  if (!Number.isSafeInteger(totalSize) || totalSize > ZIP32_MAX) {
    throw zipFormatError("ZIP 归档超过 Store/ZIP32 体积上限。");
  }

  return { prepared, localSize, centralSize, totalSize };
}

export function estimateStoredZipSize(files) {
  return prepareStoredZipFiles(files).totalSize;
}

export function makeZipBlob(files, date = new Date()) {
  const {
    prepared,
    localSize: expectedLocalSize,
    centralSize: expectedCentralSize,
    totalSize
  } = prepareStoredZipFiles(files);
  const localParts = [];
  const centralParts = [];
  const { dosTime, dosDate } = dosDateTime(date);
  let localOffset = 0;
  let centralSize = 0;

  for (const file of prepared) {
    const { nameBytes, data } = file;
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
  endView.setUint16(8, prepared.length, true);
  endView.setUint16(10, prepared.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  if (
    localOffset !== expectedLocalSize
    || centralSize !== expectedCentralSize
  ) {
    throw zipFormatError("ZIP 归档尺寸计算不一致，已停止生成。");
  }

  const blob = new Blob([...localParts, ...centralParts, end], {
    type: "application/zip"
  });
  if (blob.size !== totalSize) {
    throw zipFormatError("ZIP 归档生成尺寸异常，已停止保存。");
  }
  return blob;
}

export function makeNoteTextFileData({
  title,
  content,
  sourceUrl,
  engine,
  generatedAt = new Date()
}) {
  const generatedLabel = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false
  }).format(generatedAt);
  const text = [
    "小红书笔记",
    "",
    `标题：${String(title || "小红书笔记").trim()}`,
    "",
    "文案：",
    String(content || "").trim() || "（当前公开页面未提供可读取的正文文案）",
    "",
    `来源：${sourceUrl || "（未获取到来源链接）"}`,
    `生成时间：${generatedLabel}`,
    `解析引擎：${engine || "未知"}`,
    ""
  ].join("\n");

  // BOM 让 Windows 记事本也能稳定识别中文 UTF-8。
  return new TextEncoder().encode(`\uFEFF${text}`);
}
