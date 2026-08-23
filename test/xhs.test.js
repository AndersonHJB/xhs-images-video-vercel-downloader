import test from "node:test";
import assert from "node:assert/strict";

import {
  extractInputUrl,
  extractNoteId,
  fetchNotePage,
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

test("extractInputUrl 自动识别电脑与手机分享，兼容 Markdown 转义", () => {
  const shortUrl = "https://xhslink.cn/o/2KYMK6MAHx9";
  const desktopUrl =
    "https://www.xiaohongshu.com/discovery/item/6a657da9000000000f02b94a" +
    "?source=webshare&xhsshare=pc_web&xsec_token=desktop-token=";
  const escapedDesktopUrl = desktopUrl.replace(/([_&=])/g, "\\$1");
  assert.equal(
    extractInputUrl(
      `从离职后，我开始做编程私教 ${shortUrl} 直达【小红书】看看这篇分享~`
    ),
    shortUrl
  );
  assert.equal(extractInputUrl(`[${shortUrl}](${shortUrl})`), shortUrl);
  assert.equal(
    extractInputUrl(`79 【Python一对一教学】 [${escapedDesktopUrl}](${escapedDesktopUrl})`),
    desktopUrl
  );
  assert.equal(
    extractInputUrl(`先忽略 https://example.com/docs 再打开 ${shortUrl}`),
    shortUrl
  );
});

test("extractInputUrl 拒绝伪造域名、凭证 URL 和非安全端口", () => {
  assert.throws(
    () => extractInputUrl("https://xhslink.cn.example.com/o/fake"),
    /只支持小红书分享链接/
  );
  assert.throws(
    () => extractInputUrl("https://user:password@xhslink.cn/o/fake"),
    /只支持小红书分享链接/
  );
  assert.throws(
    () => extractInputUrl("https://xhslink.cn:8443/o/fake"),
    /只支持小红书分享链接/
  );
});

test("fetchNotePage 安全跟随手机短链并从最终地址保留 noteId", async () => {
  const shortUrl = "https://xhslink.cn/o/2KYMK6MAHx9";
  const finalUrl =
    "https://www.xiaohongshu.com/discovery/item/668d2967000000002500100a" +
    "?app_platform=ios&xsec_source=app_share";
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, options) => {
    const url = String(input);
    requests.push({ url, redirect: options?.redirect });
    if (url === shortUrl) {
      return new Response(null, {
        status: 302,
        headers: { location: finalUrl }
      });
    }
    if (url === finalUrl) {
      return new Response("<!doctype html><title>手机分享笔记</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    throw new Error(`未预期的测试请求：${url}`);
  };

  try {
    const result = await fetchNotePage(shortUrl);
    assert.equal(result.finalUrl, finalUrl);
    assert.equal(extractNoteId(result.finalUrl), "668d2967000000002500100a");
    assert.match(result.html, /手机分享笔记/);
    assert.deepEqual(requests, [
      { url: shortUrl, redirect: "manual" },
      { url: finalUrl, redirect: "manual" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchNotePage 在第二次请求前拦截 HTTP 降级跳转", async () => {
  const shortUrl = "https://xhslink.cn/o/unsafe";
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(null, {
      status: 302,
      headers: {
        location:
          "http://www.xiaohongshu.com/discovery/item/668d2967000000002500100a"
      }
    });
  };

  try {
    await assert.rejects(
      fetchNotePage(shortUrl),
      /分享链接跳转到了不受支持的地址/
    );
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
            desc: "目标正文\r\n第二行 #目标",
            imageList: makeImageList("target", 7)
          }
        },
        [otherId]: {
          note: {
            noteId: otherId,
            title: "相关推荐",
            desc: "推荐正文（禁止返回）",
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
  assert.equal(parsed.content, "目标正文\n第二行 #目标");
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
    <meta name="description" content="页面描述也不能作为当前文案">
    <script>{"noteId":"${targetId}","desc":"局部正文不可猜测",BROKEN,"imageList":${targetList}}</script>
    ${"x".repeat(70000)}
    <script>{"noteId":"bbbbbbbbbbbbbbbbbbbbbbbb","imageList":${otherList}}</script>
  `;

  const parsed = parseNoteHtml(html, { noteId: targetId });
  assert.equal(parsed.strategy, "note-id-local-image-list");
  assert.equal(parsed.content, "");
  assert.equal(parsed.images.length, 4);
  assert.ok(parsed.images.every((image) => image.token.startsWith("local")));
});

function videoUrl(id) {
  return `https://sns-video-bd.xhscdn.com/stream/${id}.mp4`;
}

function makeVideo(codec, id, width, height, bitrate, size) {
  return {
    masterUrl: videoUrl(id),
    backupUrls: [videoUrl(`${id}-backup`)],
    videoCodec: codec,
    width,
    height,
    videoBitrate: bitrate,
    size,
    qualityType: "HD"
  };
}

test("只解析当前 noteId 的视频流，不混入推荐帖子视频", () => {
  const targetId = "6a68c6d3000000001303f099";
  const otherId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const state = {
    note: {
      noteDetailMap: {
        [targetId]: {
          note: {
            noteId: targetId,
            type: "video",
            title: "目标视频",
            desc: "目标视频正文",
            imageList: makeImageList("video-cover", 1),
            video: {
              media: {
                stream: {
                  h264: [
                    makeVideo("h264", "target-1080", 1920, 1080, 5000000, 18000000),
                    makeVideo("h264", "target-720", 1280, 720, 2500000, 9000000)
                  ],
                  h265: [
                    makeVideo("h265", "target-hevc", 2560, 1440, 6000000, 20000000)
                  ]
                }
              }
            }
          }
        },
        [otherId]: {
          note: {
            noteId: otherId,
            type: "video",
            title: "推荐视频",
            desc: "推荐视频正文（禁止返回）",
            video: {
              media: {
                stream: {
                  h264: [makeVideo("h264", "other-video", 3840, 2160, 9000000, 40000000)]
                }
              }
            }
          }
        }
      }
    }
  };

  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`;
  const parsed = parseNoteHtml(html, { noteId: targetId });

  assert.equal(parsed.strategy, "exact-initial-state");
  assert.equal(parsed.title, "目标视频");
  assert.equal(parsed.content, "目标视频正文");
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.videos.length, 3);
  assert.ok(parsed.videos.every((video) => video.url.includes("target-")));
  assert.ok(parsed.videos.every((video) => !video.url.includes("other-video")));
  assert.equal(parsed.videos[0].codec, "h264");
  assert.equal(parsed.videos[0].width, 1920);
  assert.equal(parsed.videos[0].backupUrls.length, 1);
});

test("纯视频笔记即使没有 imageList 也可以解析", () => {
  const targetId = "cccccccccccccccccccccccc";
  const state = {
    note: {
      noteDetailMap: {
        [targetId]: {
          note: {
            noteId: targetId,
            title: "纯视频",
            type: "video",
            video: {
              media: {
                stream: {
                  h264: [makeVideo("h264", "video-only", 1080, 1920, 3000000, 12000000)]
                }
              }
            }
          }
        }
      }
    }
  };

  const parsed = parseNoteHtml(
    `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`,
    { noteId: targetId }
  );

  assert.equal(parsed.images.length, 0);
  assert.equal(parsed.videos.length, 1);
  assert.match(parsed.videos[0].url, /video-only/);
});

test("当前笔记没有文案时不从推荐内容或页面描述兜底", () => {
  const targetId = "dddddddddddddddddddddddd";
  const otherId = "eeeeeeeeeeeeeeeeeeeeeeee";
  const state = {
    note: {
      noteDetailMap: {
        [targetId]: {
          note: {
            noteId: targetId,
            title: "无正文目标帖",
            imageList: makeImageList("no-desc", 1)
          }
        },
        [otherId]: {
          note: {
            noteId: otherId,
            desc: "推荐正文（禁止返回）",
            imageList: makeImageList("recommended-desc", 10)
          }
        }
      }
    }
  };
  const html = `<meta name="description" content="页面描述（禁止返回）">
    <script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`;

  const parsed = parseNoteHtml(html, { noteId: targetId });
  assert.equal(parsed.strategy, "exact-initial-state");
  assert.equal(parsed.content, "");
});

test("文案按 Unicode 字符安全截断并兼容 description 字段", () => {
  const targetId = "ffffffffffffffffffffffff";
  const content = `  ${"😀".repeat(10001)}  `;
  const state = {
    note: {
      noteDetailMap: {
        [targetId]: {
          note: {
            noteId: targetId,
            title: "Unicode 文案",
            desc: "   ",
            description: content,
            imageList: makeImageList("unicode", 1)
          }
        }
      }
    }
  };

  const parsed = parseNoteHtml(
    `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`,
    { noteId: targetId }
  );
  assert.equal(Array.from(parsed.content).length, 10000);
  assert.equal(Array.from(parsed.content).at(-1), "😀");
  assert.ok(!parsed.content.includes("\ufffd"));
});
