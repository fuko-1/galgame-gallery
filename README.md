# fuko 的 Galgame 收藏

展示 Bangumi 个人评分、短评和收藏，并提供「Galgame 用户标签清单减去全部已收藏条目」的未收藏列表。网站采用原生 HTML、CSS 和 JavaScript，部署到 GitHub Pages，无需数据库或构建框架。

## 页面与数据口径

- **我的评分**：按收藏状态、作品类型筛选，搜索标题、原名或短评；按个人评分或标记时间排序。
- **未收藏的 Galgame**：从 Bangumi 的 Galgame 用户标签集合中排除所有收藏状态，包括想玩、在玩、玩过、搁置和抛弃；按公共评分或发售日期排序。
- **游戏推荐**：根据已玩评分、剧本作者、开发商和题材推荐未游玩作品。支持「适合我的」「续集与外传」「口碑优先」、每批 12 部和「不感兴趣」。隐藏保存在当前浏览器，可恢复。
- 用户标签可能包含其他类型游戏，这份清单不是经过人工审核的严格 Galgame 分类。
- Bangumi 和 2DFan 按钮仅为外部链接，本站不修改账户收藏或评分，也不获取 2DFan 账户数据。

## 运行

需要 Node.js 24 或更新版本，以及 Python 3.11 或更新版本（用于官方档案裁剪和相关测试）。浏览网站不需要这两个运行环境。

```sh
npm ci
npm test
python -m http.server 8000 --bind 127.0.0.1
```

打开 http://localhost:8000 。不要直接双击 HTML，浏览器无法可靠读取相邻 JSON。

## 配置

统一修改 `config.json`：

| 字段 | 用途 |
| --- | --- |
| `bangumi.username` | 公开收藏所属用户 |
| `bangumi.nickname` | 页面显示名 |
| `bangumi.profileUrl` | Bangumi 主页链接 |
| `bangumi.apiBase` | Bangumi 公开 API 地址 |
| `bangumi.snapshotFile` | 个人收藏快照路径 |
| `twodfan.profileUrl` | 2DFan 主页链接 |
| `twodfan.searchUrlTemplate` | 搜索链接，使用 `{title}` 占位符 |
| `galgame.tag` | 抓取的游戏用户标签 |
| `galgame.snapshotFile` | 标签清单快照路径 |
| `recommendations.snapshotFile` | 推荐关系、标签和制作人员快照路径 |

更换用户名后需要重新抓取个人快照，页面不会把旧文件自动转换成新用户的数据。快照来自公开接口，请勿把访问令牌写进配置或提交到仓库。

## 推荐规则

推荐使用 [Bangumi 官方公开 Wiki 档案](https://github.com/bangumi/Archive)，关系与职位常量来自 [bangumi/common](https://github.com/bangumi/common)。不需要 Bangumi 访问令牌或第三方 AI 密钥。

- 「不同演绎」「不同版本」「主版本」以及游戏之间的改编关系合并为同一作品，支持经中间版本连接的关系。玩过任一版本后排除同组其他版本；名称清理辅助识别未关联的 HD、重制、全语音等版本，保留续作编号和故事副标题。
- 「续集」「外传」独立保留；玩过移植版也可以推荐原作关联的续作。合集不会把各部作品合并成一个组，推荐中排除合集条目。
- 排除玩过、在玩、搁置和抛弃的作品及其版本；想玩仍是候选。排除未发售、无关系元数据、试玩版、评分不足 20 人或公共评分低于 6 的条目。同一未玩作品只出现一个版本。
- 评分偏好按同一作品去重，结合共同剧本作者、开发商、题材，以及经过评分人数平滑的公共评分排序。低分作品会降低相应偏好；推荐理由引用真实个人评分和制作人员关系，不把共同作者说成相同故事。首批适度分散开发商。

「不同演绎／版本」依赖社区维护的关系，名称辅助规则也可能漏掉未关联的别名。可用「不感兴趣」隐藏整组作品；新条目会在下一版官方档案中补入。推荐页按需下载元数据，加载失败不会影响个人评分或未收藏列表。

## 数据更新

```sh
npm run fetch
```

依次抓取个人收藏、游戏标签清单、检查官方推荐档案，再校验快照。也可分开运行：

```sh
npm run fetch:mine
npm run fetch:galgame
npm run fetch:recommendations
npm run validate:data
```

数据来源：个人收藏使用 `api.bgm.tv/v0`，全站候选清单解析 Bangumi 游戏用户标签页面。小数公共评分读取页面的数字评分，封面正确解析相对 URL；标签页缺失的封面先从已有详情和个人快照补全，再通过 API 补全。未授权时每轮最多请求 50 个条目，已授权时默认 200 个。尚未补全或 API 未提供图片的条目显示占位。零票或源站未公开分数的作品不会被捏造评分。

详情补全结果缓存在清单中，30 天内不会重复请求缺图条目。可通过 `GALGAME_ENRICH_LIMIT` 调整每轮请求上限（`0` 关闭额外 API 请求）。`GALGAME_MAX_PAGES` 默认 700；总页数超过此上限会报错，不会静默发布截断清单。单页只读检查可运行 `node scripts/fetch-galgame.mjs --check-page=1`，全量只读检查可运行 `node scripts/fetch-galgame.mjs --dry-run`。

### 一次授权，更新时自动使用

部分游戏被 Bangumi 标记为 NSFW，匿名 API 请求会返回 404。给后台抓取配置 Access Token 后，更新会自动携带授权，无需每次打开画廊或更新数据时登录。令牌以 Bangumi 设置的有效期为准；过期或撤销后需要重新配置，个人令牌不能自行续期。官方说明：[API 授权](https://github.com/bangumi/api/blob/master/docs-raw/How-to-Auth.md)、[NSFW 可见性](https://github.com/bangumi/api/blob/master/open-api/api.yml)。

Windows 首次设置：

1. 在 [Bangumi 个人令牌页面](https://next.bgm.tv/demo/access-token) 登录 `config.json` 中的账号（当前 `koberi`），点击「创建个人令牌」，按需要选择有效期（7 至 365 天）。
2. 在项目目录运行 `npm run auth:setup`，将令牌粘贴到隐藏输入提示中并按回车。不要发到聊天、写入前端、`config.json` 或仓库文件。
3. 脚本先通过 `/v0/me` 验证账号，再用 Windows DPAPI 加密保存到 `%LOCALAPPDATA%/galgame-gallery/bangumi-token.dpapi`，并用已登录的 GitHub CLI 设置 `fuko-1/galgame-gallery` 的 Actions Secret `BANGUMI_ACCESS_TOKEN`。随后补全首批 200 个缺图条目，优先推荐游戏。本地抓取以后自动读取；GitHub 每日工作流通过 Secret 注入。工作流更改需合并到默认分支才能用于每日计划。

若仅需要本地授权，运行 `powershell.exe -NoProfile -File scripts/setup-bangumi-auth.ps1`。其他系统或现有密钥管理工具可提供 `BANGUMI_ACCESS_TOKEN` 环境变量。环境变量优先于本地加密存储。若选择手动配置 GitHub，进入仓库 Settings → Secrets and variables → Actions，新建同名 Secret。

`npm run auth:check` 只验证授权；`npm run fetch:covers` 仅补全现有快照的封面，不重新抓取所有标签页。代理环境可用 `node --use-env-proxy scripts/fetch-galgame.mjs --enrich-only`。已授权时立即重试先前匿名 404 的缓存；授权失效会报错并保留原有快照。

令牌仅用于官方 HTTPS API 的游戏详情请求与账号验证，不发送给标签网页、图片 CDN 或其他 API 域名，不随重定向转发。个人收藏仍使用公开请求，避免把私密收藏发布到静态网站。仓库和网页只保存作品详情和封面 URL，不保存账号密码或令牌。授权能解决访问限制，但无法保证每个源站条目都有封面。

前端读取仓库里的静态快照，**不是每次打开都实时同步 Bangumi**。页面显示快照更新时间；个人收藏和清单分别加载，个人页面不会等待完整清单下载。

抓取会校验响应结构、分页完整性、唯一 ID、有效评分及数据量下降。请求超时、结构变化或异常缩水会失败；完整抓取与校验成功后才原子替换对应文件。在 Actions 中，全部抓取及发布校验成功后才提交数据，因此失败不会发布半成品。

推荐档案通过官方 `aux/latest.json` 检查版本；摘要未变时保留现有元数据，官方每周更新后才重新下载几百 MB 的 ZIP。脚本核对大小与 SHA-256，流式读取所需文件，只提交裁剪后的约 3.8 MB 元数据。可用 `python scripts/update-recommendation-metadata.py --force` 强制重建，或使用 `--archive /path/to/official.zip` 读取已下载且摘要匹配的档案。

如果本地设置了 HTTP_PROXY / HTTPS_PROXY 而 Node 无法连接，可在 Node 24 下使用 `node --use-env-proxy scripts/fetch-mine.mjs` 和 `node --use-env-proxy scripts/fetch-galgame.mjs`。不需要修改抓取代码。

## Actions 和部署

- **每日更新数据**：北京时间 04:17 计划运行，也可手动触发；GitHub 可能延迟启动。安装锁定依赖、运行回归测试、抓取并校验，然后提交有效数据。
- **检查代码与数据**：在 push 和 pull request 时验证离线回归测试及快照契约。
- **测试数据源**：手动运行少量真实网络请求，验证标签页及收藏 API 的当前结构；失败会正确返回非零退出码，不覆盖快照。

GitHub Pages 使用 main 分支根目录。合并并推送更改后，等待 Pages 部署成功再检查线上版本；本地分支或 PR 不会自动改变线上网站。

## 文件结构

```text
index.html / style.css / app.js  静态页面和交互
recommendations.js              推荐排序、去重与过滤规则
config.json                     页面和抓取共用配置
scripts/fetch-mine.mjs           收藏 API 抓取、完整性校验
scripts/fetch-galgame.mjs        标签 HTML 抓取、详情补全、完整性校验
scripts/validate-data.mjs        发布前快照契约检查
scripts/update-recommendation-metadata.py  官方档案裁剪与原子更新
data/                           公开数据快照
tests/                          离线回归测试和代表性 HTML 样本
.github/workflows/              刷新、测试与验证工作流
```

`PROJECT_REVIEW.md` 记录修复前的历史审查结果与复现步骤，其统计不代表修复后的最新数据。
