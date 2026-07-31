# 小红书图片与视频下载器（Node.js + Python 双后台）

这是一个可直接部署到 Vercel 的小红书公开笔记媒体下载网站。访问者只需要粘贴分享文案或链接，即可解析当前笔记中的：

- 无水印原图
- 视频流与多个可用清晰度
- 图片单张下载、勾选下载与浏览器本地 ZIP
- 视频浏览器分段下载、本地合并并保存为 MP4
- Node.js / Python 双后台自由切换

## v1.3 更新

- 新增视频笔记识别和视频下载。
- 支持新版 `video.media.stream.h264 / h265 / av1` 数据结构。
- 兼容旧版 `video.consumer.originVideoKey`。
- 视频有多个流时可在页面选择分辨率和编码。
- 新增 Node.js 视频分段接口：`/api/video`。
- 新增 Python 视频分段接口：`/api/python_video`。
- 每个视频分段小于 Vercel 单次响应限制，最终文件在浏览器中合并。
- 只读取当前 `noteId` 对应的视频对象，不会抓取相关推荐中的视频。
- 原有图片解析、无水印转换、单张下载、复制链接和 ZIP 功能保持不变。

## 项目结构

```text
.
├── api/
│   ├── parse.js            # Node.js 笔记抓取与图片/视频解析
│   ├── image.js            # Node.js 图片代理下载
│   ├── video.js            # Node.js 视频元数据与分段下载
│   ├── python_parse.py     # Python 笔记抓取与图片/视频解析
│   ├── python_image.py     # Python 图片代理下载
│   └── python_video.py     # Python 视频元数据与分段下载
├── lib/
│   └── xhs.js              # Node.js 解析核心
├── test/
│   ├── xhs.test.js
│   └── test_python_backend.py
├── app.js
├── index.html
├── style.css
├── package.json
├── vercel.json
└── .python-version
```

## 直接更新现有部署

部署方式不变，不需要创建第二个 Vercel 项目，也不需要把 Python 单独部署。

将新版文件覆盖到原仓库后提交：

```bash
git add .
git commit -m "feat: add Xiaohongshu video download"
git push
```

已经关联 GitHub 的 Vercel 项目会自动重新部署，原域名和项目设置不需要修改。

建议继续保持：

```text
Framework Preset：Other
Build Command：留空
Output Directory：留空
Install Command：留空或默认
```

## 本地运行

需要安装 Node.js、Python 和 Vercel CLI：

```bash
npx vercel dev
```

不能只用普通静态服务器运行，因为图片和视频下载都依赖 `/api` Functions。

## 自动测试

```bash
npm test
```

测试覆盖：

- 当前帖子图片不会混入其他帖子图片。
- 当前帖子视频不会混入相关推荐视频。
- 图文笔记原有解析结果保持不变。
- 纯视频笔记即使没有 `imageList` 也可以解析。
- H.264、H.265、AV1 多流提取与默认选择。
- 视频备用 CDN 地址保留。
- Node.js 与 Python 两套解析逻辑结果一致。

## 接口

### 解析笔记

```text
POST /api/parse
POST /api/python_parse
```

请求：

```json
{
  "text": "小红书分享文案或链接"
}
```

返回值中保留原有 `images` 字段，并新增：

```json
{
  "type": "video",
  "videoCount": 2,
  "videos": [
    {
      "index": 1,
      "url": "https://...xhscdn.com/...",
      "backupUrls": [],
      "codec": "h264",
      "width": 1920,
      "height": 1080,
      "size": 18000000,
      "label": "1920×1080 · H264 · 线路 1",
      "isDefault": true
    }
  ]
}
```

### 图片下载

```text
GET /api/image?token=...&name=01.jpg
GET /api/python_image?token=...&name=01.jpg
```

### 视频信息与分段

```text
GET /api/video?action=meta&url=...
GET /api/video?action=chunk&url=...&start=0&end=3499999

GET /api/python_video?action=meta&url=...
GET /api/python_video?action=chunk&url=...&start=0&end=3499999
```

前端会自动调用这些接口，不需要访问者手动操作。

## 视频下载方式

视频通常大于 Vercel Function 的单次响应大小，因此项目不会让一个 Function 一次返回整个视频。流程是：

```text
浏览器获取视频总大小
        ↓
通过所选 Node.js / Python 后台逐段读取
        ↓
每段不超过 3.5 MB
        ↓
浏览器本地合并为 Blob
        ↓
保存为 MP4
```

如果视频源不支持分段，页面会尝试浏览器直连；仍失败时会打开视频原地址供用户保存。

## 安全与限制

- 只允许 HTTPS 的小红书页面和 `xhscdn.com` 媒体地址。
- 分享链接和视频 CDN 跳转目标都会校验。
- 只解析当前 `noteId` 的媒体对象，不全局扫描推荐内容。
- 单个视频限制为 512 MB，避免浏览器本地合并占用过多内存。
- 图片与视频不会在服务器持久化。
- 临时签名的视频链接可能过期，解析后应及时下载。
- 仅处理公开可访问内容，请只保存自己拥有或已获授权的作品。
