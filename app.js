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

function applyMineFilters() {
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
  renderGrid(el.gridMine, list, renderMyCard);
}

function applyUnplayedFilters() {
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
  renderGrid(el.gridUnplayed, list, renderUnplayedCard);
}

function renderGrid(container, list, renderFn) {
  container.innerHTML = "";
  if (!list.length) { setStatus("这里空空如也～"); return; }
  setStatus("");
  const frag = document.createDocumentFragment();
  list.forEach(item => frag.appendChild(renderFn(item)));
  container.appendChild(frag);
}

function switchTab(tab) {
  state.activeTab = tab;
  el.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  const mine = tab === "mine";
  el.gridMine.classList.toggle("hidden", !mine);
  el.gridUnplayed.classList.toggle("hidden", mine);
  el.filterStatusWrap.style.display = mine ? "" : "none";
  if (mine) applyMineFilters();
  else applyUnplayedFilters();
}

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

    applyMineFilters();
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

el.tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
el.filterStatus.addEventListener("change", applyMineFilters);
el.filterType.addEventListener("change", applyMineFilters);
el.sortBy.addEventListener("change", () => (state.activeTab === "mine" ? applyMineFilters() : applyUnplayedFilters()));
el.searchBox.addEventListener("input", () => (state.activeTab === "mine" ? applyMineFilters() : applyUnplayedFilters()));

loadAll();
