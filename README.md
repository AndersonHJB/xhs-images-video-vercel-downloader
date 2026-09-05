# 小红书图片、实况与视频下载器（Node.js + Python 双后台）

这是一个可直接部署到 Vercel 的小红书公开笔记媒体下载网站。访问者只需要粘贴分享文案或链接，即可解析当前笔记中的：

- 无水印原图
- 实况图片的静态原图与配对动态 MP4
- 视频流与多个可用清晰度
- 电脑端 `xiaohongshu.com` 长链与手机端 `xhslink.cn` 短链自动识别
- 当前笔记标题与正文文案
- 文案复制、逐张图片复制，以及支持平台上的多图剪贴板写入尝试
- 图片单张下载、实况 JPG + MP4 素材 ZIP、实况 MP4 单独下载，以及勾选批量 ZIP（自动附带 `文案.txt`）
- 视频浏览器分段下载、本地合并并保存为 MP4
- Node.js / Python 双后台自由切换

## 待发布功能

- Node.js 与 Python 两套解析器同步读取当前 `noteId` 对应的 `desc / description`，不从相关推荐兜底。
- 结果区可复制“标题 + 正文”的完整笔记文案。
- 每张图片提供独立“复制图片”按钮；支持多项剪贴板的平台可对勾选图片发起一次写入。
- 图片 ZIP 固定加入 UTF-8 BOM 编码的 `文案.txt`，包含标题、正文、来源、生成时间与解析引擎。
- 图片剪贴板只在 HTTPS 或 localhost 可用；Chrome / Chromium 当前会拒绝多个 `ClipboardItem`，页面会区分该限制与权限错误，并提供复制首张、逐张复制、复制链接与 ZIP 回退。

## v1.4 更新

- Node.js 与 Python 两套解析器会按 `imageList` 顺序识别 `livePhoto`，并把同一项 `stream` 中的动态 MP4 与静态原图一一配对。
- 实况卡片提供两个独立入口：“下载实况 ZIP”保存配对素材，“下载实况 MP4”只保存动态片段；原有“下载原图”保持不变。
- 单张实况素材包命名为 `NN-live-photo.zip`，内部包含 `NN.jpg` 与 `NN-live.mp4`。
- 勾选下载会把每张原图及其对应 `NN-live.mp4` 一并放入批量 ZIP，并继续附带 `文案.txt`。
- 实况素材 ZIP 是 JPG + MP4 素材包，不会自动写入 Apple Photos 所需的原生 Live Photo 元数据。
- 归档设置浏览器内存保护：桌面端上限 256 MiB，移动端或低内存设备上限 128 MiB；下载、备用线路、文案和最终 ZIP 共用同一预算。
- ZIP 生成前会精确核对 UTF-8 文件名、目录开销、ZIP32 边界与最终体积，超限时提示减少勾选或分批下载。

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
│   ├── archive.js          # 浏览器 ZIP Store 与文案 TXT 生成
│   └── xhs.js              # Node.js 解析核心
├── test/
│   ├── archive.test.js
│   ├── xhs.test.js
│   └── test_python_backend.py
├── app.js
├── visit-counter.js       # 独立加载 BornForThis 访问统计 SDK
├── visit-counter.css      # 访问统计专用液态玻璃浮层样式
├── changelog.html
├── changelog.css
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
git commit -m "feat: add Xiaohongshu live photo downloads"
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
npm run dev:vercel
```

不能只用普通静态服务器运行，因为图片和视频下载都依赖 `/api` Functions。

这里特意不使用 `dev` 作为脚本名：`vercel dev` 会自动读取并执行
`package.json` 中的 `dev`，如果该脚本再次调用 `vercel dev`，就会形成递归。
`dev:vercel` 只用于本地运行，不影响 Git push 后的 Vercel 自动部署，发布前无需修改或撤回。

## 网站访问统计

首页和更新记录页已接入 [domain-visit-counter](https://github.com/AndersonHJB/domain-visit-counter)，使用已部署的 HTTPS 服务：`https://counter.bornforthis.cn`。

统计以左下角液态玻璃浮层展示，沿用页面暖白、蓝黄配色。专用 `visit-counter.css` 只影响统计模块；支持收起 / 展开、手机安全区、减少透明度和减少动态效果偏好，不支持背景模糊时使用暖白底色。展示区域允许点击穿透，仅收起 / 展开按钮接收点击；输入框或选择框聚焦、现有提示条显示时，统计浮层暂时隐藏。

- **展示口径**：当前域名的累计页面浏览次数（PV），不是独立访客人数或下载次数；接入前的访问不会自动补录。
- **域名识别**：`visit-counter.js` 将当前 `location.hostname` 显式传给官方 SDK 的 `data-domain`。同一域名的首页和更新记录页共用总量，不设置 `data-project`；不同域名（包括 Vercel 预览域名）各自统计。
- **上报方式**：每次打开页面，异步加载一次 `/counter.js`，由 SDK 自动上报一次 `/hit?d=当前域名` 并读取 `/stats?d=当前域名`；不额外调用 `hit()`，也不轮询。上报与读取并行，数值可能短暂滞后一次访问。
- **数据显示**：通过 `bftcounter:update` 事件显示带千分位的真实 `total`；等待期间用 `—` 占位，脚本加载失败或 8 秒未获得有效结果时显示“访问统计暂时不可用”。失败不显示为 0，稍后返回的有效数据仍会更新。
- **本地调试**：`file://`、localhost、本地 IP 以及 `.local` / `.test` 等本地域名不加载远程 SDK、不上报。正式站点只需正常部署这些静态文件，无需新增 Vercel 环境变量。
- **独立运行**：统计代码与媒体解析、复制、ZIP 打包及下载逻辑分离；不把分享链接或笔记内容作为统计参数发送，也不请求 `includeIps`。

如统计服务启用了域名白名单，需要在计数器服务的 `allowedRootDomains` 中允许实际部署域名。可用 `https://counter.bornforthis.cn/stats?d=实际域名` 只读核对数据；页面里的访问统计模块和请求状态也可用于排查。

## 自动测试

```bash
npm test
```

测试覆盖：

- 当前帖子图片不会混入其他帖子图片。
- 当前帖子文案不会混入相关推荐或页面通用描述。
- 当前帖子视频不会混入相关推荐视频。
- 图文笔记原有解析结果保持不变。
- 纯视频笔记即使没有 `imageList` 也可以解析。
- H.264、H.265、AV1 多流提取与默认选择。
- 实况图片与同项 H.264 / H.265 / H.266 / AV1 动态流保持一一配对。
- 视频备用 CDN 地址保留。
- Node.js 与 Python 两套解析逻辑结果一致。
- 电脑长链、手机短链、Markdown 包裹链接与安全重定向边界。
- ZIP 可解出 UTF-8 中文文件名的 `文案.txt`，且正文元数据完整。
- ZIP 预估尺寸、中央目录、CRC、ZIP32 边界与不安全输入拒绝逻辑。

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

返回值中保留原有 `images` 字段，并新增正文、实况与视频字段：

```json
{
  "title": "笔记标题",
  "content": "笔记正文文案",
  "type": "mixed",
  "livePhotoCount": 1,
  "videoCount": 2,
  "images": [
    {
      "index": 1,
      "token": "...",
      "url": "https://...xhscdn.com/...",
      "livePhoto": true,
      "liveVideo": {
        "url": "https://...xhscdn.com/...",
        "backupUrls": [],
        "codec": "h264",
        "size": 6800000
      }
    }
  ],
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

## 视频与实况动态片段下载方式

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

如果媒体源不支持分段，页面会尝试备用 CDN 与浏览器直连；普通视频仍失败时会打开原地址供用户保存。

## 安全与限制

- 只允许 HTTPS 的小红书页面和 `xhscdn.com` 媒体地址。
- 分享链接和视频 CDN 跳转目标都会校验；页面分享链每一跳都必须使用 HTTPS、无凭证且仅使用安全端口。
- 只解析当前 `noteId` 的媒体对象，不全局扫描推荐内容。
- 文案只读取当前 `noteId` 已锁定笔记对象的直属字段；降级解析宁可返回空文案，也不会猜测推荐内容。
- 单个视频限制为 512 MB，避免浏览器本地合并占用过多内存。
- 实况单项 ZIP、批量 ZIP 和单独 MP4 会先检查已知大小，再对实际响应逐段限流；归档超限时不会生成截断 ZIP。
- 多图复制依赖标准 Async Clipboard API、HTTPS 与目标系统的多项剪贴板能力；不支持时请逐张复制或使用 ZIP。
- 图片与视频不会在服务器持久化。
- 临时签名的视频链接可能过期，解析后应及时下载。
- 仅处理公开可访问内容，请只保存自己拥有或已获授权的作品。
