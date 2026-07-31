# 小红书无水印原图下载器（Node.js + Python 双后台）

这是一个可以直接部署到 Vercel 的小红书无水印原图下载网站。访问者可以在页面中自行切换：

- `Node.js`：负责抓取、解析和图片代理下载。
- `Python`：使用独立实现完成同样的抓取、解析和图片代理下载。
- 两套后台返回相同的数据格式，前端不需要刷新页面即可切换。
- ZIP 文件始终在访问者浏览器本地生成，不在服务器保存图片。

## v1.2 更新

- 新增 Python 抓取接口：`/api/python_parse`。
- 新增 Python 图片下载接口：`/api/python_image`。
- 页面新增 Node.js / Python 引擎选择。
- 用户选择的引擎会保存到浏览器 `localStorage`。
- Node.js 与 Python 都只解析当前 `noteId` 对应的 `imageList`。
- 两套实现都会将图片资源 Token 转换为 `ci.xiaohongshu.com` 无水印地址。
- Python 后台仅使用标准库，不需要 `requests`、BeautifulSoup 或 Flask。
- Python 固定为 3.12，减少不同运行时版本造成的行为差异。

## 项目结构

```text
.
├── api/
│   ├── parse.js            # Node.js 笔记抓取与解析
│   ├── image.js            # Node.js 图片代理下载
│   ├── python_parse.py     # Python 笔记抓取与解析
│   └── python_image.py     # Python 图片代理下载
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

## 部署方式是否变化

不需要新建第二个 Vercel 项目，也不需要把 Python 单独部署。

Vercel 会根据 `/api` 目录中的文件扩展名分别构建：

```text
.js  → Node.js Function
.py  → Python Function
```

因此，已经部署过旧版本时，只需要把 v1.2 文件覆盖到原仓库并正常推送：

```bash
git add .
git commit -m "feat: add Python and Node.js dual backend"
git push
```

原 Vercel 项目会自动触发一次新的部署，域名、项目设置和 GitHub 关联都不需要修改。

仍然建议保持：

```text
Framework Preset：Other
Build Command：留空
Output Directory：留空
Install Command：留空或使用默认值
```

`vercel.json` 已经分别配置四个 Function，不需要在 Vercel 后台手动选择运行时。

## 本地运行

需要本机同时安装：

- Node.js 22 或更新版本
- Python 3.12 或兼容版本
- Vercel CLI

运行：

```bash
npx vercel dev
```

打开终端显示的本地地址即可测试两套后台。

## 自动测试

一次运行 Node.js 与 Python 测试：

```bash
npm test
```

也可以分别运行：

```bash
npm run test:node
npm run test:python
```

测试覆盖：

- 当前帖子与推荐帖子同时存在时，只提取当前帖子。
- 当前帖子 7 张、其他帖子 15/20 张时不混图。
- 页面状态中存在 `undefined`。
- 初始状态无法解析时，只查找当前 `noteId` 附近的图片列表。
- 图片 CDN 地址转换为无水印原始资源地址。

## 接口

### Node.js 解析

```text
POST /api/parse
```

### Python 解析

```text
POST /api/python_parse
```

请求体相同：

```json
{
  "text": "小红书分享文案或链接"
}
```

### Node.js 图片下载

```text
GET /api/image?token=...&name=01.jpg
```

### Python 图片下载

```text
GET /api/python_image?token=...&name=01.jpg
```

## Vercel 响应限制

项目不会让 Function 返回整个 ZIP。单张代理图片限制在约 4.2 MB，ZIP 在浏览器本地生成。

图片超过限制时，浏览器会尝试直接读取原图 CDN；仍然失败时，页面会提示使用“打开原图”。若需要稳定代理大图、大型 ZIP 或高并发流量，应把图片代理迁移到自有服务器或对象存储。

## 安全措施

- 只允许小红书页面、短链接和图片 CDN 域名。
- Python 与 Node.js 都检查分享链接重定向目标。
- 图片接口只接受经过格式验证的资源 Token。
- 限制输入长度、HTML 大小、图片数量和单图响应大小。
- 不在服务器持久化图片。

## 注意事项

- 只处理公开可访问的图文笔记。
- Node.js 和 Python 是两套独立实现，因此一套被临时风控时，可以尝试另一套；它们仍可能因为同一 Vercel 出口 IP 同时被限制。
- 小红书可能修改页面结构，解析逻辑需要持续维护。
- 作者直接写入图片像素中的署名或水印仍然会保留。
- 请只下载自己拥有或已经获得授权的内容。
