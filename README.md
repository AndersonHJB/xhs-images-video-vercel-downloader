# 小红书无水印原图下载网站

这是一个适合直接部署到 Vercel 的完整项目：

- 前端：纯静态 HTML、CSS、JavaScript
- 解析接口：Vercel Node.js Function
- 单图下载：Vercel Node.js Function
- ZIP 打包：在访问者浏览器中完成
- npm 依赖：无

## 为什么选择 Node.js

部署目标是 Vercel，因此采用 Node.js 更直接。静态前端和 Function 使用同一种语言，不需要额外维护 Python 运行环境，也不需要安装任何第三方 npm 包。

这个网站并非“完全纯静态”：浏览器无法稳定地跨域读取小红书笔记 HTML，因此 `/api/parse` 必须在服务器端访问并解析公开笔记；用户看到的页面仍然是纯静态文件。

## 本地运行

```bash
npx vercel dev
```

## 部署到 Vercel

### GitHub 自动部署

```bash
git init
git add .
git commit -m "init xhs downloader"
git branch -M main
git remote add origin git@github.com:你的用户名/你的仓库.git
git push -u origin main
```

随后在 Vercel 中导入该仓库，Framework Preset 选择 `Other`，无需填写构建命令和输出目录。

### Vercel CLI

```bash
npx vercel
npx vercel --prod
```

## 工作流程

1. 用户粘贴小红书分享文案。
2. `/api/parse` 获取公开笔记页面并提取图片资源 token。
3. token 转换为 `ci.xiaohongshu.com` 无水印资源地址。
4. 图片预览直接使用图片 CDN。
5. 单张下载经过 `/api/image` 返回附件。
6. 多张图片逐张下载到浏览器内存，由项目内置的无依赖 ZIP 实现在浏览器本地打包。

## Vercel 响应限制

项目没有让 Function 返回一个大型 ZIP。`/api/image` 将单张代理图片限制在约 4.2 MB；超过时，浏览器会尝试直接读取原图 CDN。仍然失败时，页面会提示用户使用“打开原图”。

若需要稳定支持几十 MB 的单图、大型 ZIP 或大量并发下载，建议把图片代理部署到自己的服务器，而不是通过 Vercel Function 传输大文件。

## 安全措施

- 只允许小红书及其短链接域名。
- 手动检查每次 HTTP 重定向，降低 SSRF 风险。
- 图片接口只接收受限格式的资源 token。
- 限制 HTML 大小、输入长度、图片数量和单图响应大小。
- 不在服务器持久化图片。

## 注意事项

- 只处理公开可访问的图文笔记。
- 小红书可能修改页面结构或限制数据中心 IP，解析逻辑需要持续维护。
- 作者直接写入图片像素中的署名或水印仍会保留。
- 请仅下载自己拥有或已经获得授权的内容。
