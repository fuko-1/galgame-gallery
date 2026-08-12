const CONFIG = {
  bangumi: { username: "koberi", profileUrl: "https://bgm.tv/user/koberi" },
  twodfan: {
    profileUrl: "https://2dfan.com/users/346524",
    searchUrlTemplate: "https://2dfan.com/subjects/search?keyword={title}",
  },
  galgameSnapshot: "data/galgame-list.json",
  mySnapshot: "data/my-collections.json",
};

const TYPE_NAMES = { 1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元" };
const STATUS_NAMES = { 1: "想看", 2: "看过", 3: "在看", 4: "搁置", 5: "抛弃" };

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

const state = {
  activeTab: "mine",
  myCollections: [],
  unplayed: [],
  mySubjectIds: new Set(),
  // 分页状态
  pageMine: 1,
  pageUnplayed: 1,
  pageSize: 50,
  // 缓存当前过滤结果（分页用）
  filteredMine: [],
  filteredUnplayed: [],
};

function twodfanSearchUrl(title) {
  return CONFIG.twodfan.searchUrlTemplate.replace("{title}", encodeURIComponent(title || ""));
}
function starString(r) {
  if (!r) return "";
  const full = Math.floor(r / 2), half = r % 2 >= 1 ? 1 : 0;
  return "★".repeat(full) + (half ? "⯨" : "") + "☆".repeat(Math.max(0, 5 - full - half));
}
function coverOf(images) {
  if (!images) return "";
  return images.large || images.common || images.medium || images.small || images.grid || "";
}
function setStatus(msg, isError = false) {
  el.statusMsg.textContent = msg;
  el.statusMsg.classList.toggle("hidden", !msg);
  el.statusMsg.style.color = isError ? "#c0392b" : "";
}

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读取 ${url} 失败：${res.status}`);
  return res.json();
}

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
      <div class="card-meta"><span>${STATUS_NAMES[c.type] || ""} · ${formatDate(c.updated_at)}</span></div>
      ${(c.tags && c.tags.length) ? `<div class="card-tags">${c.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <a class="card-link" href="${twodfanSearchUrl(title)}" target="_blank" rel="noopener">去 2DFan 搜这部作品 ↗</a>
    </div>`;
  return card;
}

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

/* ---------------- 过滤逻辑 ---------------- */
function computeMineFiltered() {
  const status = el.filterStatus.value;
  const type = el.filterType.value;
  const sort = el.sortBy.value;
  const q = el.searchBox.value.trim().toLowerCase();
  let list = state.myCollections.slice();
  if (status !== "all") list = list.filter(c => String(c.type) === status);
  if (type !== "all") list = list.filter(c => String(c.subject?.type) === type);
  if (q) {
    list = list.filter(c => {
      const s = c.subject || {};
      return (s.name || "").toLowerCase().includes(q) ||
             (s.name_cn || "").toLowerCase().includes(q) ||
             (c.comment || "").toLowerCase().includes(q);
    });
  }
  list.sort((a, b) => sort === "rate"
    ? (b.rate || 0) - (a.rate || 0)
    : new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  return list;
}

function computeUnplayedFiltered() {
  const sort = el.sortBy.value;
  const q = el.searchBox.value.trim().toLowerCase();
  let list = state.unplayed.slice();
  if (q) {
    list = list.filter(s =>
      (s.name || "").toLowerCase().includes(q) ||
      (s.name_cn || "").toLowerCase().includes(q));
  }
  list.sort((a, b) => {
    if (sort === "date") return (b.date || "").localeCompare(a.date || "");
    const ra = a.rating || {}, rb = b.rating || {};
    return (rb.score || 0) - (ra.score || 0) || (rb.total || 0) - (ra.total || 0);
  });
  return list;
}

/* ---------------- 分页渲染 ---------------- */
function renderPaginated(container, allItems, page, renderFn, pager) {
  container.innerHTML = "";
  const total = allItems.length;
  if (!total) {
    setStatus("这里空空如也～");
    pager.innerHTML = "";
    return;
  }
  setStatus("");
  const totalPages = Math.ceil(total / state.pageSize);
  const p = Math.min(Math.max(1, page), totalPages);

  const start = (p - 1) * state.pageSize;
  const pageItems = allItems.slice(start, start + state.pageSize);

  const frag = document.createDocumentFragment();
  pageItems.forEach(item => frag.appendChild(renderFn(item)));
  container.appendChild(frag);

  // 分页控件
  pager.innerHTML = `
    <button class="pg-btn" data-act="prev" ${p <= 1 ? "disabled" : ""}>‹ 上一页</button>
    <span class="pg-info">第 ${p} / ${totalPages} 页 · 共 ${total} 条</span>
    <button class="pg-btn" data-act="next" ${p >= totalPages ? "disabled" : ""}>下一页 ›</button>
    <label class="pg-size">每页
      <select class="pg-select">
        <option value="50" ${state.pageSize === 50 ? "selected" : ""}>50</option>
        <option value="100" ${state.pageSize === 100 ? "selected" : ""}>100</option>
      </select>
    </label>`;
}

function applyMine(resetPage = false) {
  if (resetPage) state.pageMine = 1;
  state.filteredMine = computeMineFiltered();
  renderPaginated(el.gridMine, state.filteredMine, state.pageMine, renderMyCard, pagerMine);
}

function applyUnplayed(resetPage = false) {
  if (resetPage) state.pageUnplayed = 1;
  state.filteredUnplayed = computeUnplayedFiltered();
  renderPaginated(el.gridUnplayed, state.filteredUnplayed, state.pageUnplayed, renderUnplayedCard, pagerUnplayed);
}

/* ---------------- 分页控件（动态创建，插在网格后） ---------------- */
function makePager(onChange) {
  const div = document.createElement("div");
  div.className = "pagination";
  div.addEventListener("click", (e) => {
    const btn = e.target.closest(".pg-btn");
    if (!btn || btn.disabled) return;
    onChange(btn.dataset.act === "prev" ? -1 : 1, null);
  });
  div.addEventListener("change", (e) => {
    if (e.target.classList.contains("pg-select")) {
      onChange(0, Number(e.target.value));
    }
  });
  return div;
}

let pagerMine, pagerUnplayed;

function setupPagers() {
  pagerMine = makePager((delta, size) => {
    if (size) { state.pageSize = size; state.pageMine = 1; }
    else state.pageMine += delta;
    applyMine();
  });
  pagerUnplayed = makePager((delta, size) => {
    if (size) { state.pageSize = size; state.pageUnplayed = 1; }
    else state.pageUnplayed += delta;
    applyUnplayed();
  });
  el.gridMine.after(pagerMine);
  el.gridUnplayed.after(pagerUnplayed);
}

/* ---------------- 标签页切换 ---------------- */
function switchTab(tab) {
  state.activeTab = tab;
  el.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  const mine = tab === "mine";
  el.gridMine.classList.toggle("hidden", !mine);
  el.gridUnplayed.classList.toggle("hidden", mine);
  pagerMine.classList.toggle("hidden", !mine);
  pagerUnplayed.classList.toggle("hidden", mine);
  el.filterStatusWrap.style.display = mine ? "" : "none";
  if (mine) applyMine();
  else applyUnplayed();
}

/* ---------------- 加载 ---------------- */
async function loadAll() {
  setStatus("正在加载数据…");
  try {
    const [mine, gal] = await Promise.all([
      loadJSON(CONFIG.mySnapshot),
      loadJSON(CONFIG.galgameSnapshot),
    ]);
    state.myCollections = mine.collections || [];
    state.mySubjectIds = new Set(state.myCollections.map(c => c.subject?.id).filter(Boolean));
    state.unplayed = (gal.subjects || []).filter(s => !state.mySubjectIds.has(s.id));

    const times = [mine.updated_at, gal.updated_at].filter(Boolean).map(formatDate).join(" / ");
    if (times) el.snapshotTime.textContent = ` · 数据更新于 ${times}`;

    applyMine(true);
  } catch (e) {
    console.error(e);
    setStatus("加载失败：" + e.message + "（数据文件可能还没生成，请先在 Actions 跑一次抓取）", true);
  }
}

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

/* ---------------- 事件 ---------------- */
el.tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
el.filterStatus.addEventListener("change", () => applyMine(true));
el.filterType.addEventListener("change", () => applyMine(true));
el.sortBy.addEventListener("change", () => (state.activeTab === "mine" ? applyMine(true) : applyUnplayed(true)));
el.searchBox.addEventListener("input", () => (state.activeTab === "mine" ? applyMine(true) : applyUnplayed(true)));

setupPagers();
loadAll();
