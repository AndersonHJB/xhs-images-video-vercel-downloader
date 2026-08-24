import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateStoredZipSize,
  makeNoteTextFileData,
  makeZipBlob
} from "../lib/archive.js";

async function readStoredZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map();
  const flags = new Map();

  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  assert.ok(bytes.length >= 22, "ZIP 必须包含 EOCD");
  const eocdOffset = bytes.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50, "EOCD 签名完整");
  assert.equal(view.getUint16(eocdOffset + 4, true), 0, "ZIP 使用单磁盘");
  assert.equal(view.getUint16(eocdOffset + 6, true), 0, "中央目录位于同一磁盘");
  const entryCount = view.getUint16(eocdOffset + 10, true);
  assert.equal(view.getUint16(eocdOffset + 8, true), entryCount);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  assert.equal(view.getUint16(eocdOffset + 20, true), 0, "ZIP 不含尾注");
  assert.equal(centralOffset + centralSize, eocdOffset, "中央目录尺寸与 EOCD 一致");

  let offset = centralOffset;
  for (let entry = 0; entry < entryCount; entry += 1) {
    assert.ok(offset + 46 <= eocdOffset, "中央目录项未截断");
    assert.equal(view.getUint32(offset, true), 0x02014b50, "中央目录签名正确");
    const generalFlags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    assert.ok(nameEnd + extraLength + commentLength <= eocdOffset);
    const name = decoder.decode(bytes.slice(nameStart, nameEnd));

    assert.equal(method, 0, `${name} 使用 Store 模式`);
    assert.equal(compressedSize, uncompressedSize, `${name} 存储尺寸一致`);
    assert.ok(localOffset + 30 <= centralOffset, `${name} 本地头未截断`);
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `${name} 本地头签名正确`);
    assert.equal(view.getUint16(localOffset + 6, true), generalFlags);
    assert.equal(view.getUint16(localOffset + 8, true), method);
    assert.equal(view.getUint32(localOffset + 14, true), checksum);
    assert.equal(view.getUint32(localOffset + 18, true), compressedSize);
    assert.equal(view.getUint32(localOffset + 22, true), uncompressedSize);

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    assert.equal(decoder.decode(bytes.slice(localNameStart, localNameEnd)), name);
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    assert.ok(dataEnd <= centralOffset, `${name} 数据未截断`);
    const data = bytes.slice(dataStart, dataEnd);
    assert.equal(crc32(data), checksum, `${name} CRC32 匹配`);

    files.set(name, data);
    flags.set(name, generalFlags);
    offset = nameEnd + extraLength + commentLength;
  }

  assert.equal(offset, centralOffset + centralSize, "中央目录消费完整");
  return { files, flags, entryCount };
}

test("文案 TXT 使用 UTF-8 BOM 并包含标题、正文、来源和引擎", () => {
  const data = makeNoteTextFileData({
    title: "上海周末散步地图",
    content: "梧桐树下走走停停。\n#上海散步",
    sourceUrl: "https://www.xiaohongshu.com/explore/example",
    engine: "Node.js",
    generatedAt: new Date("2026-08-23T14:48:57+08:00")
  });

  assert.deepEqual([...data.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(data);
  assert.match(text, /标题：上海周末散步地图/);
  assert.match(text, /梧桐树下走走停停。\n#上海散步/);
  assert.match(text, /来源：https:\/\/www\.xiaohongshu\.com\/explore\/example/);
  assert.match(text, /解析引擎：Node\.js/);
});

test("ZIP 中央目录、CRC 与本地头一致，中文文件名启用 UTF-8 标志", async () => {
  const caption = makeNoteTextFileData({
    title: "示例笔记",
    content: "示例文案",
    sourceUrl: "https://example.com/note",
    engine: "Python",
    generatedAt: new Date("2026-08-23T14:48:57+08:00")
  });
  const zip = makeZipBlob(
    [
      { name: "01.jpg", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "文案.txt", data: caption }
    ],
    new Date("2026-08-23T14:48:57+08:00")
  );

  assert.equal(zip.type, "application/zip");
  assert.equal(zip.size, estimateStoredZipSize([
    { name: "01.jpg", data: new Uint8Array([1, 2, 3, 4]) },
    { name: "文案.txt", data: caption }
  ]));
  const { files, flags, entryCount } = await readStoredZip(zip);
  assert.equal(entryCount, 2);
  assert.deepEqual([...files.keys()], ["01.jpg", "文案.txt"]);
  assert.deepEqual([...files.get("01.jpg")], [1, 2, 3, 4]);
  assert.match(new TextDecoder().decode(files.get("文案.txt")), /示例文案/);
  assert.equal(flags.get("文案.txt") & 0x0800, 0x0800);
});

test("ZIP 预估包含 UTF-8 文件名开销并拒绝不安全输入", () => {
  const files = [
    { name: "01-live.mp4", data: new Uint8Array(7) },
    { name: "文案.txt", data: new Uint8Array(3) }
  ];
  const encodedNameBytes = files.reduce(
    (total, file) => total + new TextEncoder().encode(file.name).byteLength,
    0
  );
  const dataBytes = files.reduce((total, file) => total + file.data.byteLength, 0);

  assert.equal(
    estimateStoredZipSize(files),
    22 + dataBytes + files.length * (30 + 46) + encodedNameBytes * 2
  );
  assert.throws(
    () => makeZipBlob([{ name: "bad.bin", data: new ArrayBuffer(1) }]),
    { name: "ZipFormatError", message: /Uint8Array/ }
  );
  assert.throws(
    () => estimateStoredZipSize([{ name: "", data: new Uint8Array() }]),
    { name: "ZipFormatError", message: /文件名不能为空/ }
  );
});
