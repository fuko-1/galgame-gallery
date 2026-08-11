/* ============================================================
 * fuko 的 Galgame 收藏 —— 前端逻辑
 *
 * 数据来源：
 *   1.「我的评分」      —— 实时请求 Bangumi 公开 API（api.bgm.tv/v0）
 *   2.「还没玩过的」    —— 读取本仓库预生成的 data/galgame-list.json 快照
 *
 * 说明：纯原生 JS，无框架，方便后续替换/美化。
 * ============================================================ */

/* ----------------- 配置（与 config.json 保持一致） ----------------- */
const CONFIG = {
  bangumi: {
    username: "koberi",
    apiBase: "https://api.bgm.tv/v0",
    profileUrl: "https://bgm.tv/user/koberi",
  },
  twodfan: {
    profileUrl: "https://2dfan.com/users/346524",
    searchUrlTemplate: "https://2dfan.com/subjects/search?keyword={title}",
  },
  snapshotFile: "data/galgame-list.json",
  pageSize: 100,          // 收藏分页大小
  galgameType: 4,         // Bangumi subject_type：4 = 游戏
};

/* Bangumi subject_type → 中文名 */
const TYPE_NAMES = { 1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元" };
/* 收藏状态 type → 中文名 */
const STATUS_NAMES = { 1: "想看", 2: "看过", 3: "在看", 4: "搁置", 5: "抛弃" };

/* ----------------- DOM 引用 ----------------- */
const el = {
  statusMsg: document.getElementById("status-msg"),
  gridMine: document.getElementById("grid-mine"),
  gridUnplayed: document.getElementById("grid-unplayed"),
  tabs: document.querySelectorAll(".tab"),
  filterStatus: document.getElementById("filter-status"),
  filterStatusWrap: document.getElementById("tool-status-wrap"),
  filterType: document.getElementById("filter-type"),
  sortBy: document.getElementById("sort-by"),
  searchBox: document.getElementById("search-box"),
  snapshotTime: document.getElementById("snapshot-time"),
};

/* ----------------- 全局状态 ----------------- */
const state = {
  activeTab: "mine",     // mine | unplayed
  myCollections: [],     // 我的全部收藏（原始）
  unplayed: [],          // 还没玩过的清单
  mySubjectIds: new Set(), // 我标记过的条目 id（用于求差集）
  loading: false,
};

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 拼 2DFan 搜索链接（title 会做 URL 编码） */
function twodfanSearchUrl(title) {
  const t = encodeURIComponent(title || "");
  return CONFIG.twodfan.searchUrlTemplate.replace("{title}", t);
}

/** 生成星星字符串（满分 10 → 5 颗星，半星用 ⯨ 近似） */
function starString(rate10) {
  if (!rate10) return "";
  const full = Math.floor(rate10 / 2);
  const half = rate10 % 2 >= 1 ? 1 : 0;
  return "★".repeat(full) + (half ? "⯨" : "") + "☆".repeat(Math.max(0, 5 - full - half));
}

/** 安全取封面图（大→中→小） */
function coverOf(images) {
  if (!images) return "";
  return images.large || images.common || images.medium || images.small || "";
}

function setStatus(msg, isError = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("hidden", !msg);
  el.statusMsg.style.color = isError ? "#c0392b" : "";
}

/* ============================================================
 * 数据获取：我的收藏（实时）
 * ============================================================ */

/** 分页拉取某个收藏状态的全部条目 */
async function fetchCollectionStatus(subjectType, collectType) {
  const out = [];
  let offset = 0;
  for (;;) {
    const url =
      `${CONFIG.bangumi.apiBase}/users/${CONFIG.bangumi.username}/collections` +
      `?subject_type=${subjectType}&type=${collectType}` +
      `&limit=${CONFIG.pageSize}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bangumi API 请求失败：${res.status}`);
    const data = await res.json();
    const list = data.data || [];
    out.push(...list);
    if (list.length < CONFIG.pageSize) break;  // 没有更多了
    offset += CONFIG.pageSize;
    if (offset > 5000) break;                  // 兜底防死循环
  }
  return out;
}

/** 拉取我的全部收藏（所有状态 × 所有类型） */
async function fetchAllMyCollections() {
  // 收藏状态 1~5，条目类型 1/2/3/4/6
  const statuses = [1, 2, 3, 4, 5];
  const types = [1, 2, 3, 4, 6];
  const tasks = [];
  for (const t of types) for (const s of statuses) tasks.push(fetchCollectionStatus(t, s));
  const results = await Promise.all(tasks);
  return results.flat();
}

/* ============================================================
 * 数据获取：全站 Galgame 快照（本地 JSON）
 * ============================================================ */
async function fetchGalgameSnapshot() {
  const res = await fetch(CONFIG.snapshotFile);
  if (!res.ok) throw new Error(`读取全站清单失败：${res.status}`);
  return res.json(); // { updated_at, subjects: [...] }
}

/* ============================================================
 * 渲染：卡片（我的评分）
 * ============================================================ */
function renderMyCard(c) {
  const s = c.subject || {};
  const title = s.name_cn || s.name || "未知标题";
  const origin = s.name_cn && s.name && s.name_cn !== s.name ? s.name : "";
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    ${coverOf(s.images) ? `<img class="card-cover" loading="lazy" src="${coverOf(s.images)}" alt="">` : ""}
    <div class="card-body">
      <span class="badge type-${s.type}">${TYPE_NAMES[s.type] || "条目"}</span>
      <div class="card-title">
        <a href="https://bgm.tv/subject/${s.id}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${escapeHtml(title)}</a>
        ${origin ? `<span class="origin">${escapeHtml(origin)}</span>` : ""}
      </div>
      ${c.rate ? `<div class="card-rate"><span class="stars">${starString(c.rate)}</span><span class="rate-num">${c.rate}</span></div>` : ""}
      ${c.comment ? `<div class="card-comment">${escapeHtml(c.comment)}</div>` : ""}
      <div class="card-meta">
        <span>${STATUS_NAMES[c.type] || ""} · ${formatDate(c.updated_at)}</span>
      </div>
      ${(c.tags && c.tags.length) ? `<div class="card-tags">${c.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <a class="card-link" href="${twodfanSearchUrl(title)}" target="_blank" rel="noopener">去 2DFan 搜这部作品 ↗</a>
    </div>`;
  return card;
}

/* ============================================================
 * 渲染：列表项（还没玩过的 Galgame）
 * ============================================================ */
function renderUnplayedCard(s) {
  const title = s.name_cn || s.name || "未知标题";
  const origin = s.name_cn && s.name && s.name_cn !== s.name ? s.name : "";
  const rating = s.rating || {};
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    ${coverOf(s.images) ? `<img class="card-cover" loading="lazy" src="${coverOf(s.images)}" alt="">` : ""}
    <div class="card-body">
      <span class="badge type-4">游戏</span>
      <div class="card-title">
        <a href="https://bgm.tv/subject/${s.id}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${escapeHtml(title)}</a>
        ${origin ? `<span class="origin">${escapeHtml(origin)}</span>` : ""}
      </div>
      ${rating.score ? `<div class="card-rate"><span class="stars">${starString(Math.round(rating.score))}</span><span class="rate-num">${rating.score.toFixed(1)}</span><span class="card-meta">(${rating.total || 0}人)</span></div>` : ""}
      <div class="card-meta">
        ${s.date ? `<span>发售：${escapeHtml(s.date)}</span>` : ""}
        ${s.platform ? `<span>平台：${escapeHtml(s.platform)}</span>` : ""}
      </div>
      <a class="card-link" href="${twodfanSearchUrl(title)}" target="_blank" rel="noopener">去 2DFan 搜这部作品 ↗</a>
    </div>`;
  return card;
}

/* ============================================================
 * 筛选 / 排序 / 搜索
 * ============================================================ */
function applyMineFilters() {
  const status = el.filterStatus.value;   // all | 1..5
  const type = el.filterType.value;       // all | 1/2/3/4/6
  const sort = el.sortBy.value;           // rate | date
  const q = el.searchBox.value.trim().toLowerCase();

  let list = state.myCollections.slice();

  if (status !== "all") list = list.filter(c => String(c.type) === status);
  if (type !== "all") list = list.filter(c => String(c.subject?.type) === type);

  if (q) {
    list = list.filter(c => {
      const s = c.subject || {};
      return (
        (s.name || "").toLowerCase().includes(q) ||
        (s.name_cn || "").toLowerCase().includes(q) ||
        (c.comment || "").toLowerCase().includes(q)
      );
    });
  }

  list.sort((a, b) => {
    if (sort === "rate") return (b.rate || 0) - (a.rate || 0);
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });

  renderGrid(el.gridMine, list, renderMyCard);
}

function applyUnplayedFilters() {
  const sort = el.sortBy.value;
  const q = el.searchBox.value.trim().toLowerCase();

  let list = state.unplayed.slice();

  if (q) {
    list = list.filter(s =>
      (s.name || "").toLowerCase().includes(q) ||
      (s.name_cn || "").toLowerCase().includes(q)
    );
  }

  // 默认按全站评分排（评分人数太少的往后放）
  list.sort((a, b) => {
    if (sort === "date") return (b.date || "").localeCompare(a.date || "");
    const ra = a.rating || {}, rb = b.rating || {};
    return (rb.score || 0) - (ra.score || 0) || (rb.total || 0) - (ra.total || 0);
  });

  renderGrid(el.gridUnplayed, list, renderUnplayedCard);
}

function renderGrid(container, list, renderFn) {
  container.innerHTML = "";
  if (!list.length) {
    setStatus("这里空空如也～");
    return;
  }
  setStatus("");
  const frag = document.createDocumentFragment();
  list.forEach(item => frag.appendChild(renderFn(item)));
  container.appendChild(frag);
}

/* ============================================================
 * 标签页切换
 * ============================================================ */
function switchTab(tab) {
  state.activeTab = tab;
  el.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));

  const mine = tab === "mine";
  el.gridMine.classList.toggle("hidden", !mine);
  el.gridUnplayed.classList.toggle("hidden", mine);
  // 状态筛选只在「我的评分」页有意义
  el.filterStatusWrap.style.display = mine ? "" : "none";

  if (mine) applyMineFilters();
  else {
    if (!state.unplayed.length && !state.loading) loadUnplayed();
    else applyUnplayedFilters();
  }
}

/* ============================================================
 * 加载流程
 * ============================================================ */
async function loadMine() {
  setStatus("正在从 Bangumi 拉取你的收藏…");
  try {
    state.myCollections = await fetchAllMyCollections();
    state.mySubjectIds = new Set(state.myCollections.map(c => c.subject?.id).filter(Boolean));
    applyMineFilters();
  } catch (e) {
    console.error(e);
    setStatus("加载失败：" + e.message + "（可能是网络问题或收藏设为私密）", true);
  }
}

async function loadUnplayed() {
  setStatus("正在读取全站 Galgame 清单…");
  try {
    const snap = await fetchGalgameSnapshot();
    const all = snap.subjects || [];
    // 差集：全站 − 我标记过的
    state.unplayed = all.filter(s => !state.mySubjectIds.has(s.id));
    if (snap.updated_at) {
      el.snapshotTime.textContent = ` · 全站清单更新于 ${formatDate(snap.updated_at)}`;
    }
    applyUnplayedFilters();
  } catch (e) {
    console.error(e);
    setStatus("加载失败：" + e.message, true);
  }
}

/* ============================================================
 * 小工具
 * ============================================================ */
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ============================================================
 * 事件绑定 & 启动
 * ============================================================ */
el.tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
el.filterStatus.addEventListener("change", applyMineFilters);
el.filterType.addEventListener("change", applyMineFilters);
el.sortBy.addEventListener("change", () => (state.activeTab === "mine" ? applyMineFilters() : applyUnplayedFilters()));
el.searchBox.addEventListener("input", () => (state.activeTab === "mine" ? applyMineFilters() : applyUnplayedFilters()));

loadMine();
