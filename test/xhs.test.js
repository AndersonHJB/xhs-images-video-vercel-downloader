import test from "node:test";
import assert from "node:assert/strict";

import {
  extractNoteId,
  parseNoteHtml
} from "../lib/xhs.js";

function imageUrl(id, variant = "!nd_dft_wlteh_webp_3") {
  return `https://sns-webpic-qc.xhscdn.com/202607301856/signature/${id}${variant}`;
}

function makeImageList(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    urlDefault: imageUrl(`${prefix}${String(index + 1).padStart(2, "0")}`),
    urlPre: imageUrl(`${prefix}${String(index + 1).padStart(2, "0")}`, "!nd_prv_wlteh_webp_3")
  }));
}

test("extractNoteId 支持 discovery 和 explore URL", () => {
  assert.equal(
    extractNoteId("https://www.xiaohongshu.com/discovery/item/6a68c6d3000000001303f099?source=webshare"),
    "6a68c6d3000000001303f099"
  );
  assert.equal(
    extractNoteId("https://www.xiaohongshu.com/explore/1234567890abcdef12345678"),
    "1234567890abcdef12345678"
  );
});

test("只解析 noteDetailMap 中当前帖子的图片，不混入推荐帖子", () => {
  const targetId = "6a68c6d3000000001303f099";
  const otherId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const state = {
    note: {
      noteDetailMap: {
        [targetId]: {
          note: {
            noteId: targetId,
            title: "目标帖子",
            imageList: makeImageList("target", 7)
          }
        },
        [otherId]: {
          note: {
            noteId: otherId,
            title: "相关推荐",
            imageList: makeImageList("other", 15)
          }
        }
      }
    },
    user: {
      avatar: imageUrl("avatar")
    }
  };

  const html = `<!doctype html><html><head>
    <meta property="og:image" content="${imageUrl("cover")}">
    </head><body>
    <script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>
    <script>${JSON.stringify({ recommendations: makeImageList("recommend", 20) })}</script>
    </body></html>`;

  const parsed = parseNoteHtml(html, { noteId: targetId });

  assert.equal(parsed.strategy, "exact-initial-state");
  assert.equal(parsed.title, "目标帖子");
  assert.equal(parsed.images.length, 7);
  assert.ok(parsed.images.every((image) => image.token.startsWith("target")));
  assert.ok(parsed.images.every((image) => !image.token.startsWith("other")));
  assert.ok(parsed.images.every((image) => !image.token.startsWith("recommend")));
});

test("支持初始状态中的 undefined", () => {
  const targetId = "6a68c6d3000000001303f099";
  const list = JSON.stringify(makeImageList("undef", 3));
  const html = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"${targetId}":{"note":{"noteId":"${targetId}","title":"带 undefined","extra":undefined,"imageList":${list}}}}}}</script>`;

  const parsed = parseNoteHtml(html, { noteId: targetId });
  assert.equal(parsed.images.length, 3);
  assert.equal(parsed.title, "带 undefined");
});

test("初始状态不可解析时，只取距离当前 noteId 最近的 imageList", () => {
  const targetId = "6a68c6d3000000001303f099";
  const targetList = JSON.stringify(makeImageList("local", 4));
  const otherList = JSON.stringify(makeImageList("far", 12));
  const html = `
    <script>{"noteId":"${targetId}",BROKEN,"imageList":${targetList}}</script>
    ${"x".repeat(70000)}
    <script>{"noteId":"bbbbbbbbbbbbbbbbbbbbbbbb","imageList":${otherList}}</script>
  `;

  const parsed = parseNoteHtml(html, { noteId: targetId });
  assert.equal(parsed.strategy, "note-id-local-image-list");
  assert.equal(parsed.images.length, 4);
  assert.ok(parsed.images.every((image) => image.token.startsWith("local")));
});
