import { recommendGames, validateRecommendationMetadata } from "./recommendations.js";

let config;

const TYPE_NAMES = { 1: "书籍", 2: "动画", 3: "音乐", 4: "游戏", 6: "三次元" };
const STATUS_NAMES = { 1: "想看", 2: "看过", 3: "在看", 4: "搁置", 5: "抛弃" };
const GAME_STATUS_NAMES = { ...STATUS_NAMES, 1: "想玩", 2: "玩过", 3: "在玩" };

const el = {
  statusMsg: document.getElementById("status-msg"),
  gridMine: document.getElementById("grid-mine"),
  gridUnplayed: document.getElementById("grid-unplayed"),
  gridRecommend: document.getElementById("grid-recommend"),
  toolbar: document.getElementById("main-toolbar"),
  recommendControls: document.getElementById("recommend-controls"),
  recommendMode: document.getElementById("recommend-mode"),
  recommendNext: document.getElementById("recommend-next"),
  recommendRestore: document.getElementById("recommend-restore"),
  recommendBatch: document.getElementById("recommend-batch"),
  recommendSummary: document.getElementById("recommend-summary"),
  tabs: document.querySelectorAll(".tab"),
  filterStatus: document.getElementById("filter-status"),
  filterStatusWrap: document.getElementById("tool-status-wrap"),
  filterType: document.getElementById("filter-type"),
  filterTypeWrap: document.getElementById("tool-type-wrap"),
  sortBy: document.getElementById("sort-by"),
  searchBox: document.getElementById("search-box"),
  snapshotTime: document.getElementById("snapshot-time"),
  unplayedNote: document.getElementById("unplayed-note"),
};

const state = {
  activeTab: "mine",
  configError: "",
  myCollections: [],
  galSubjects: [],
  unplayed: [],
  recommendationMetadata: null,
  recommendationCache: null,
  hiddenWorkIds: [],
  sources: {
    mine: { status: "loading", error: "", updatedAt: "" },
    gal: { status: "loading", error: "", updatedAt: "" },
    meta: { status: "idle", error: "", updatedAt: "" },
  },
  views: {
    mine: { status: "2", type: "galgame", sort: "rate", query: "", page: 1, pageSize: 50 },
    unplayed: { sort: "rate", query: "", page: 1, pageSize: 50 },
    recommend: { mode: "personal", batch: 0 },
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, document.baseURI);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function twodfanSearchUrl(title) {
  const template = config?.twodfan?.searchUrlTemplate;
  return safeHttpUrl(typeof template === "string" ? template.replace("{title}", encodeURIComponent(title)) : "");
}

function scoreOf(value) {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 && score <= 10 ? score : 0;
}

function starString(value) {
  const score = Math.round(scoreOf(value));
  const full = Math.floor(score / 2), half = score % 2;
  return "★".repeat(full) + (half ? "⯨" : "") + "☆".repeat(5 - full - half);
}

function coverMarkup(images) {
  const url = [images?.common, images?.medium, images?.small, images?.large, images?.grid]
    .map(safeHttpUrl).find(Boolean);
  return `<div class="card-cover"><span class="cover-placeholder" aria-hidden="true">暂无封面</span>${url
    ? `<img loading="lazy" src="${escapeHtml(url)}" alt="">` : ""}</div>`;
}

function cardHeading(subject) {
  const title = subject.name_cn || subject.name || "未知标题";
  const origin = subject.name_cn && subject.name && subject.name_cn !== subject.name ? subject.name : "";
  const url = `https://bgm.tv/subject/${encodeURIComponent(subject.id ?? "")}`;
  return `<div class="card-title"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>
    ${origin ? `<span class="origin">${escapeHtml(origin)}</span>` : ""}</div>`;
}

function searchLink(subject) {
  const url = twodfanSearchUrl(subject.name_cn || subject.name || "");
  return url ? `<a class="card-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">去 2DFan 搜这部作品 ↗</a>` : "";
}

function makeCard(markup) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = markup;
  // Keep the same placeholder for missing URLs and failed image requests.
  const image = card.querySelector(".card-cover img");
  if (image) image.addEventListener("error", () => image.remove(), { once: true });
  return card;
}

function renderMyCard(collection) {
  const subject = collection.subject || {};
  const rate = scoreOf(collection.rate);
  const names = Number(subject.type) === 4 ? GAME_STATUS_NAMES : STATUS_NAMES;
  return makeCard(`${coverMarkup(subject.images)}
    <div class="card-body">
      <span class="badge type-${escapeHtml(subject.type)}">${TYPE_NAMES[subject.type] || "条目"}</span>
      ${cardHeading(subject)}
      ${rate ? `<div class="card-rate"><span class="stars">${starString(rate)}</span><span class="rate-num">${rate}</span></div>` : ""}
      ${collection.comment ? `<div class="card-comment">${escapeHtml(collection.comment)}</div>` : ""}
      <div class="card-meta"><span>${names[collection.type] || ""} · ${escapeHtml(formatDate(collection.updated_at))}</span></div>
      ${Array.isArray(collection.tags) && collection.tags.length ? `<div class="card-tags">${collection.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      ${searchLink(subject)}
    </div>`);
}

function renderUnplayedCard(subject, recommendation = null) {
  const rate = scoreOf(subject.rating?.score);
  const total = subject.rating?.total;
  const totalMarkup = Number.isInteger(total) && total >= 0 ? `<span class="card-meta">(${total}人)</span>` : "";
  return makeCard(`${coverMarkup(subject.images)}
    <div class="card-body">
      <span class="badge type-4">${recommendation?.kind === "sequel" ? "续集" : recommendation?.kind === "side_story" ? "外传 / 后续故事" : "游戏"}</span>
      ${cardHeading(subject)}
      ${recommendation ? `<div class="recommend-reasons">${recommendation.reasons.map(reason => `<p>${escapeHtml(reason)}</p>`).join("")}</div>` : ""}
      ${rate ? `<div class="card-rate"><span class="stars">${starString(rate)}</span><span class="rate-num">${rate.toFixed(1)}</span>${totalMarkup}</div>` : '<div class="card-meta">暂无评分</div>'}
      <div class="card-meta">
        ${subject.date ? `<span>发售：${escapeHtml(subject.date)}</span>` : ""}
        ${subject.platform ? `<span>平台：${escapeHtml(subject.platform)}</span>` : ""}
      </div>
      ${searchLink(subject)}
      ${recommendation ? `<button class="hide-recommendation" data-hide-work="${recommendation.workId}">不感兴趣</button>` : ""}
    </div>`);
}

function computeMineFiltered() {
  const view = state.views.mine;
  const query = view.query.trim().toLowerCase();
  return state.myCollections.filter(collection => {
    const subject = collection.subject || {};
    return (view.status === "all" || String(collection.type) === view.status)
      && (view.type === "all" || (view.type === "galgame"
        ? String(subject.type) === "4" && subject.is_galgame === true : String(subject.type) === view.type))
      && (!query || [subject.name, subject.name_cn, collection.comment].some(value => String(value || "").toLowerCase().includes(query)));
  }).sort((a, b) => view.sort === "rate"
    ? scoreOf(b.rate) - scoreOf(a.rate)
    : (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
}

function computeUnplayedFiltered() {
  const view = state.views.unplayed;
  const query = view.query.trim().toLowerCase();
  return state.unplayed.filter(subject => subject.is_galgame === true && (!query || [subject.name, subject.name_cn]
    .some(value => String(value || "").toLowerCase().includes(query))))
    .sort((a, b) => view.sort === "date"
      ? String(b.date || "").localeCompare(String(a.date || ""))
      : scoreOf(b.rating?.score) - scoreOf(a.rating?.score) || (Number(b.rating?.total) || 0) - (Number(a.rating?.total) || 0));
}

function setStatus(message, isError = false) {
  el.statusMsg.textContent = message;
  el.statusMsg.classList.toggle("hidden", !message);
  el.statusMsg.classList.toggle("error", isError);
}

function renderPaginated(container, items, view, renderCard, pager) {
  container.innerHTML = "";
  const totalPages = Math.max(1, Math.ceil(items.length / view.pageSize));
  view.page = Math.min(Math.max(1, view.page), totalPages);
  if (!items.length) {
    setStatus("没有符合当前条件的条目。");
    pager.innerHTML = "";
    return;
  }
  setStatus("");
  const start = (view.page - 1) * view.pageSize;
  const fragment = document.createDocumentFragment();
  items.slice(start, start + view.pageSize).forEach(item => fragment.appendChild(renderCard(item)));
  container.appendChild(fragment);
  pager.innerHTML = `
    <button class="pg-btn" data-act="prev" ${view.page <= 1 ? "disabled" : ""}>‹ 上一页</button>
    <span class="pg-info">第 ${view.page} / ${totalPages} 页 · 共 ${items.length} 条</span>
    <button class="pg-btn" data-act="next" ${view.page >= totalPages ? "disabled" : ""}>下一页 ›</button>
    <label class="pg-size">每页 <select class="pg-select">
      <option value="50" ${view.pageSize === 50 ? "selected" : ""}>50</option>
      <option value="100" ${view.pageSize === 100 ? "selected" : ""}>100</option>
    </select></label>`;
}

function activeSourceMessage() {
  if (state.configError) return { text: `配置加载失败：${state.configError}`, error: true };
  const mine = state.sources.mine;
  const gal = state.sources.gal;
  if (mine.status === "error") return {
    text: state.activeTab === "mine" ? `个人收藏加载失败：${mine.error}`
      : `无法生成${state.activeTab === "recommend" ? "推荐" : "未收藏清单"}：个人收藏加载失败，无法排除已收藏的作品。${mine.error}`,
    error: true,
  };
  if (state.activeTab !== "mine" && gal.status === "error") return { text: `Galgame 清单加载失败：${gal.error}`, error: true };
  if (mine.status !== "ready") return { text: "正在加载个人收藏…" };
  if (state.activeTab !== "mine" && gal.status !== "ready") return { text: "正在加载 Galgame 清单…" };
  if (state.activeTab === "recommend") {
    if (state.sources.meta.status === "error") return { text: `推荐关系数据加载失败：${state.sources.meta.error}`, error: true };
    if (state.sources.meta.status !== "ready") return { text: "正在加载作品关系与推荐资料…" };
  }
  return null;
}

function renderActive() {
  const mine = state.activeTab === "mine";
  const recommending = state.activeTab === "recommend";
  const container = recommending ? el.gridRecommend : mine ? el.gridMine : el.gridUnplayed;
  const pager = recommending ? null : mine ? pagerMine : pagerUnplayed;
  const times = [];
  if (state.sources.mine.updatedAt) times.push(`个人收藏：${formatDate(state.sources.mine.updatedAt)}`);
  if (!mine && state.sources.gal.updatedAt) times.push(`Galgame 清单：${formatDate(state.sources.gal.updatedAt)}`);
  if (recommending && state.recommendationMetadata) times.push(`关系档案：${formatDate(state.recommendationMetadata.source?.date)}`);
  el.snapshotTime.textContent = times.length ? ` · 数据更新于 ${times.join(" / ")}` : "";
  const message = activeSourceMessage();
  if (message) {
    container.innerHTML = "";
    if (pager) pager.innerHTML = "";
    if (recommending) {
      el.recommendSummary.textContent = "";
      el.recommendBatch.textContent = "";
      el.recommendNext.disabled = true;
    }
    setStatus(message.text, message.error);
    return;
  }
  if (recommending) {
    renderRecommendations();
    return;
  }
  renderPaginated(container, mine ? computeMineFiltered() : computeUnplayedFiltered(), state.views[state.activeTab],
    mine ? renderMyCard : renderUnplayedCard, pager);
}

function saveHiddenRecommendations() {
  try { localStorage.setItem(`galgame-gallery:hidden:${config.bangumi.username}`, JSON.stringify(state.hiddenWorkIds)); } catch { /* In-memory hiding still works. */ }
}

function renderRecommendations() {
  if (!state.recommendationCache) state.recommendationCache = recommendGames(state.galSubjects, state.myCollections,
    state.recommendationMetadata, { mode: state.views.recommend.mode, hiddenWorkIds: state.hiddenWorkIds });
  const { items, stats } = state.recommendationCache;
  const view = state.views.recommend;
  const batches = Math.max(1, Math.ceil(items.length / 12));
  view.batch = Math.min(view.batch, batches - 1);
  el.gridRecommend.innerHTML = "";
  items.slice(view.batch * 12, view.batch * 12 + 12).forEach(item => el.gridRecommend.appendChild(renderUnplayedCard(item.subject, item)));
  el.recommendNext.disabled = items.length <= 12;
  el.recommendRestore.hidden = !state.hiddenWorkIds.length;
  el.recommendBatch.textContent = items.length ? `第 ${view.batch + 1} / ${batches} 批 · ${items.length} 部候选` : "";
  el.recommendSummary.textContent = `参考 ${stats.favorites} 部高分 Galgame；已过滤 ${stats.excludedVersions} 个已玩 / 在玩等作品的其他版本。包含想玩，排除在玩、搁置和抛弃；只推荐通过类型筛选、已发售且至少 20 人评分的作品。`;
  setStatus(items.length ? "" : "暂时没有符合条件的推荐。可以切换推荐方向或恢复已隐藏的作品。");
}

function ensureRecommendationMetadata() {
  if (!config || state.sources.meta.status !== "idle") return;
  state.sources.meta.status = "loading";
  if (!config.recommendations?.snapshotFile) {
    state.sources.meta.status = "error";
    state.sources.meta.error = "未配置推荐资料路径";
    return;
  }
  loadSnapshot("meta", config.recommendations.snapshotFile, "subjects");
}

function makePager(tab) {
  const pager = document.createElement("div");
  pager.className = "pagination";
  pager.addEventListener("click", event => {
    const button = event.target.closest(".pg-btn");
    if (!button || button.disabled || tab !== state.activeTab) return;
    state.views[tab].page += button.dataset.act === "prev" ? -1 : 1;
    renderActive();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  pager.addEventListener("change", event => {
    const size = Number(event.target.value);
    if (tab !== state.activeTab || !event.target.classList.contains("pg-select") || ![50, 100].includes(size)) return;
    state.views[tab].pageSize = size;
    state.views[tab].page = 1;
    renderActive();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  return pager;
}

const pagerMine = makePager("mine");
const pagerUnplayed = makePager("unplayed");
el.gridMine.after(pagerMine);
el.gridUnplayed.after(pagerUnplayed);

function syncControls() {
  const mine = state.activeTab === "mine";
  const recommending = state.activeTab === "recommend";
  el.toolbar.hidden = recommending;
  el.recommendControls.hidden = !recommending;
  el.unplayedNote.hidden = state.activeTab !== "unplayed";
  if (recommending) {
    el.recommendMode.value = state.views.recommend.mode;
    return;
  }
  const view = state.views[state.activeTab];
  el.filterStatusWrap.hidden = !mine;
  el.filterTypeWrap.hidden = !mine;
  el.unplayedNote.hidden = mine;
  if (mine) {
    el.filterStatus.value = view.status;
    el.filterType.value = view.type;
    const names = ["4", "galgame"].includes(view.type) ? GAME_STATUS_NAMES : STATUS_NAMES;
    Array.from(el.filterStatus.options).forEach(option => {
      option.textContent = names[option.value] || "全部";
    });
  }
  Array.from(el.sortBy.options).forEach(option => {
    option.textContent = option.value === "rate" ? (mine ? "我的评分" : "Bangumi 评分") : (mine ? "标记时间" : "发售日期");
  });
  el.sortBy.value = view.sort;
  el.searchBox.value = view.query;
  el.searchBox.placeholder = mine ? "搜索标题 / 短评…" : "搜索标题…";
}

function switchTab(tab) {
  if (!Object.hasOwn(state.views, tab)) return;
  state.activeTab = tab;
  const mine = tab === "mine";
  el.tabs.forEach(button => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  el.gridMine.classList.toggle("hidden", !mine);
  el.gridUnplayed.classList.toggle("hidden", tab !== "unplayed");
  el.gridRecommend.classList.toggle("hidden", tab !== "recommend");
  pagerMine.classList.toggle("hidden", !mine);
  pagerUnplayed.classList.toggle("hidden", tab !== "unplayed");
  if (tab === "recommend") ensureRecommendationMetadata();
  syncControls();
  renderActive();
}

function changeView(key, value) {
  if (state.activeTab === "recommend") return;
  if (state.activeTab !== "mine" && ["status", "type"].includes(key)) return;
  const view = state.views[state.activeTab];
  view[key] = value;
  view.page = 1;
  if (key === "type") syncControls();
  renderActive();
}

async function loadJSON(url) {
  const signal = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(url, { signal, cache: "no-cache" });
    if (!response.ok) throw new Error(`读取 ${url} 失败（${response.status}）`);
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw new Error(`读取 ${url} 超时（20 秒）`);
    throw error;
  }
}

function applyConfig() {
  const nickname = config.bangumi.nickname || config.bangumi.username || "我";
  const title = `${nickname} 的 Galgame 收藏`;
  document.title = title;
  document.getElementById("site-title").textContent = title;
  for (const [id, url] of [["link-bangumi", config.bangumi.profileUrl], ["link-2dfan", config.twodfan?.profileUrl]]) {
    const link = document.getElementById(id);
    const safeUrl = safeHttpUrl(url);
    link.hidden = !safeUrl;
    if (safeUrl) link.href = safeUrl;
  }
  el.unplayedNote.textContent = `已结合游戏类型、Galgame 分类与标签共识筛选；排除我的全部收藏状态（含想玩、在玩、搁置和抛弃）。`;
  try {
    const saved = JSON.parse(localStorage.getItem(`galgame-gallery:hidden:${config.bangumi.username}`) || "[]");
    state.hiddenWorkIds = Array.isArray(saved) ? saved.filter(id => Number.isSafeInteger(id) && id > 0) : [];
  } catch { state.hiddenWorkIds = []; }
}

async function loadSnapshot(name, url, field) {
  const source = state.sources[name];
  try {
    const snapshot = await loadJSON(url);
    if (name === "meta") state.recommendationMetadata = validateRecommendationMetadata(snapshot);
    else if (!Array.isArray(snapshot[field])) throw new Error("快照格式不正确");
    if (name === "mine") state.myCollections = snapshot.collections;
    else if (name === "meta") state.recommendationMetadata = snapshot;
    else state.galSubjects = snapshot.subjects;
    state.recommendationCache = null;
    source.status = "ready";
    source.updatedAt = snapshot.updated_at || "";
    if (state.sources.mine.status === "ready" && state.sources.gal.status === "ready") {
      const ids = new Set(state.myCollections.map(collection => String(collection.subject?.id ?? collection.subject_id)));
      state.unplayed = state.galSubjects.filter(subject => !ids.has(String(subject.id)));
    }
  } catch (error) {
    source.status = "error";
    source.error = error.message;
  }
  renderActive();
}

async function loadAll() {
  try {
    config = await loadJSON("config.json");
    if (!config?.bangumi?.snapshotFile || !config?.galgame?.snapshotFile) throw new Error("缺少快照文件路径");
    applyConfig();
    if (state.activeTab === "recommend") ensureRecommendationMetadata();
  } catch (error) {
    state.configError = error.message;
    renderActive();
    return;
  }
  await Promise.all([
    loadSnapshot("mine", config.bangumi.snapshotFile, "collections"),
    loadSnapshot("gal", config.galgame.snapshotFile, "subjects"),
  ]);
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (isNaN(date)) return String(iso).slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

el.tabs.forEach(tab => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
el.filterStatus.addEventListener("change", () => changeView("status", el.filterStatus.value));
el.filterType.addEventListener("change", () => changeView("type", el.filterType.value));
el.sortBy.addEventListener("change", () => changeView("sort", el.sortBy.value));
el.searchBox.addEventListener("input", () => changeView("query", el.searchBox.value));
el.recommendMode.addEventListener("change", () => {
  state.views.recommend.mode = el.recommendMode.value;
  state.views.recommend.batch = 0;
  state.recommendationCache = null;
  renderActive();
});
el.recommendNext.addEventListener("click", () => {
  if (el.recommendNext.disabled || !state.recommendationCache) return;
  const batches = Math.ceil(state.recommendationCache.items.length / 12);
  state.views.recommend.batch = (state.views.recommend.batch + 1) % batches;
  renderActive();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
el.gridRecommend.addEventListener("click", event => {
  const button = event.target.closest("[data-hide-work]");
  if (!button) return;
  const work = Number(button.dataset.hideWork);
  if (!Number.isSafeInteger(work) || state.hiddenWorkIds.includes(work)) return;
  state.hiddenWorkIds.push(work);
  state.recommendationCache = null;
  saveHiddenRecommendations();
  renderActive();
});
el.recommendRestore.addEventListener("click", () => {
  state.hiddenWorkIds = [];
  state.views.recommend.batch = 0;
  state.recommendationCache = null;
  saveHiddenRecommendations();
  renderActive();
});

switchTab("mine");
loadAll();
