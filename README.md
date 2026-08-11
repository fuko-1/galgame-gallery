# fuko 的 Galgame 收藏

一个纯静态个人页面：实时展示我的 Bangumi 评分/吐槽，并给出「全站 Galgame 减去我标记过的 = 还没玩过」的待玩清单，每个条目附「去 2DFan 搜这部作品」链接。

## 文件结构

```
index.html                  页面骨架
style.css                   基础样式（视觉美化可在此覆盖）
app.js                      前端逻辑：取数据 + 筛选/排序/搜索 + 2DFan 链接
config.json                 账号等配置（username / 2DFan 链接）
scripts/fetch-galgame.mjs   抓取全站 Galgame 清单 → data/galgame-list.json
data/galgame-list.json      全站清单快照（由脚本/Actions 更新）
.github/workflows/          GitHub Actions：每天自动更新清单
```

## 数据来源

| 内容 | 来源 | 更新方式 |
|------|------|----------|
| 我的评分 | Bangumi 公开 API `api.bgm.tv/v0` | 浏览器打开时**实时**拉取 |
| 全站 Galgame 清单 | Bangumi 搜索 API | GitHub Actions **每天**抓一次存成 JSON |

## 部署到 GitHub Pages

1. 在 GitHub 新建一个**公开**仓库（比如叫 `galgame-gallery`）。
2. 把本目录所有文件上传（可用网页 Upload，或 git push）。
3. 仓库 → **Settings → Pages** → Source 选 `main` 分支、`/ (root)` → Save。
4. 几分钟后访问 `https://<你的用户名>.github.io/galgame-gallery/`。
5. 到仓库 **Actions** 标签页，手动点一次 **「更新全站 Galgame 清单」→ Run workflow**，先生成全站清单（否则「还没玩过」页是空的）。之后每天自动更新。

## 本地预览

直接双击 `index.html` 可能因浏览器安全策略读不到 `data/`。建议起个本地服务：

```bash
# 任选其一
npx serve .
python -m http.server 8000
```

然后浏览器打开 `http://localhost:8000`。

## 本地手动抓取全站清单（可选，需能访问 api.bgm.tv）

```bash
node scripts/fetch-galgame.mjs
```

## 修改账号

改 `config.json` 和 `app.js` 顶部的 `CONFIG`（Bangumi 用户名、2DFan 链接）即可。
