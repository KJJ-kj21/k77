# 🎓 校园集市 · 二手交易平台

一个**零依赖**的校园二手交易应用，支持多用户注册登录、商品发布（含图片上传）、浏览搜索与个人商品管理。

## 技术栈

- **后端**：Node.js 内置 `http` 模块 + `node:sqlite`（内置 SQLite 数据库）+ `node:crypto`（密码散列与会话）
- **前端**：原生 HTML / CSS / JavaScript（单页应用，无构建步骤）
- **数据库**：SQLite（文件 `data.db`，首次启动自动创建）
- **依赖**：无任何 npm 第三方包，`node server.js` 即可运行

> 需要 Node.js ≥ 22.5.0（内置 `node:sqlite`）。

## 快速开始

```bash
# 启动服务（默认 http://127.0.0.1:3000）
node server.js

# 自定义端口 / 局域网共享
#   Windows PowerShell:
$env:PORT=8080; $env:HOST="0.0.0.0"; node server.js
```

打开浏览器访问 <http://127.0.0.1:3000> 即可使用。

## 功能

- ✅ 用户注册 / 登录 / 退出（scrypt 密码散列 + 7 天会话 Cookie）
- ✅ 发布商品：标题、价格、分类、成色、描述、交易地点、联系方式、最多 6 张图片
- ✅ 商品列表：关键词搜索、分类筛选、价格/时间排序
- ✅ 商品详情：图片轮播、卖家信息、联系方式
- ✅ 个人中心：查看/删除自己的商品、标记「已售出」
- ✅ 数据持久化到 SQLite，重启不丢失

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 注册（username/password/nickname/phone/wechat） |
| POST | `/api/login` | 登录，设置会话 Cookie |
| POST | `/api/logout` | 退出登录 |
| GET  | `/api/me` | 获取当前登录用户 |
| GET  | `/api/categories` | 分类与成色枚举 |
| GET  | `/api/items` | 商品列表（`?search=&category=&sort=&mine=1`） |
| GET  | `/api/items/:id` | 商品详情 |
| POST | `/api/items` | 发布商品（需登录，`images` 为 base64 数组） |
| POST | `/api/items/:id/status` | 标记已售/在售（需本人） |
| DELETE | `/api/items/:id` | 删除商品（需本人） |

## 目录结构

```
├── server.js          # 后端（HTTP + SQLite + 认证 + 上传）
├── package.json
├── data.db            # SQLite 数据库（运行时生成）
├── uploads/           # 上传的图片（运行时生成）
└── public/
    ├── index.html     # 页面结构
    ├── style.css      # 样式
    └── app.js         # 前端逻辑
```
