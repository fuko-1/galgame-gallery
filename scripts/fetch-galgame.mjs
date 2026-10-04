import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { authorizationError, authorizationHeaders, BANGUMI_UA, loadAccessToken, verifyAccessToken } from "./bangumi-auth.mjs";

const UA = BANGUMI_UA;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const validScore = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10;

export function normalizeCover(value, base = "https://bgm.tv") {
  if (!value || /no_icon_subject/i.test(value)) return "";
  try {
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    // Reject malformed URLs emitted by the old scraper, even when cached.
    if (/^\/\/[^/]+\./.test(url.pathname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeDate(value) {
  const match = text(value).match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:$|[\s（(、,，])/);
  if (!match) return "";
  const [, year, month, day] = match;
  const normalized = year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0");
  const date = new Date(normalized + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : "";
}

function isPlatform(value) {
  return /(?:^|[\s、,，/|＋+])(?:PC(?:-?98(?:01)?)?|Windows|Win(?:dows)?\s*\d+|macOS|Mac|Linux|DOS|MSX\d*|Android|iOS|Web|浏览器|PS[1-5PV]?|PS\s*Vita|PlayStation(?:\s*\d+)?|Nintendo\s*Switch(?:\s*2)?|Switch(?:\s*2)?|Xbox(?:\s*(?:One|360|Series[\sXS/]*))?|3DS|NDS|DS|GBA?|GB[AC]?|Wii(?:\s*U)?|DC|Dreamcast|SS|Saturn|FC|SFC|NES|SNES|SEGA|Mega\s*Drive)(?:$|[\s、,，/|＋+（(等])/i.test(value);
}

export function tagPageUrl(tag, page) {
  const url = new URL("https://bgm.tv/game/tag/" + encodeURIComponent(tag));
  url.searchParams.set("sort", "collects");
  url.searchParams.set("page", String(page));
  return url.href;
}

/** Login/challenge pages must never look like a successful end of the list. */
export function parseGalgamePage(html, { tag = "Galgame", page = 1 } = {}) {
  const $ = load(html);
  const heading = text($("h1").first().text());
  const identity = heading.match(/^游戏标签\s*[:：]\s*(.+)$/);
  if (!identity || identity[1].toLowerCase() !== tag.toLowerCase()) {
    throw new Error("第 " + page + " 页不是预期的游戏标签页：" + (heading || "缺少题头"));
  }
  const pagination = text($(".page_inner .p_edge").text()).match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/);
  const currentPage = Number($(".page_inner .p_cur").first().text());
  if (!pagination || currentPage !== page || Number(pagination[1]) !== page || Number(pagination[2]) < page) {
    throw new Error("第 " + page + " 页分页结构无效，拒绝把异常页面当作抓取结束");
  }
  const totalPages = Number(pagination[2]);
  for (const anchor of $(".page_inner a[href]").toArray()) {
    const url = new URL($(anchor).attr("href"), tagPageUrl(tag, page));
    if (url.searchParams.has("page") && url.searchParams.get("sort") !== "collects") {
      throw new Error("第 " + page + " 页未按标注数排序，分页参数与请求不符");
    }
  }
  const subjects = [];
  const ids = new Set();
  let ratedRows = 0;
  let parsedScores = 0;
  for (const element of $("li[id^='item_']").toArray()) {
    const row = $(element);
    const id = Number(row.attr("id").match(/^item_(\d+)$/)?.[1]);
    const title = row.find("h3 a.l").first();
    const displayedName = text(title.text());
    if (!id || !displayedName || title.attr("href") !== "/subject/" + id || ids.has(id)) {
      throw new Error("第 " + page + " 页条目结构损坏或存在重复 ID");
    }
    ids.add(id);
    const originalName = text(row.find("h3 small.grey").first().text());
    const info = text(row.find("p.info.tip").first().text()).split(/\s+\/\s+/).map(text);
    const date = normalizeDate(info[0]);
    // Missing fields shift genre/company left; never label those as a platform.
    const platform = info.slice(0, 2).find(isPlatform) || "";
    const image = row.find("a.subjectCover img, img.cover").first();
    const cover = ["data-src", "data-original", "data-cfsrc", "src"]
      .map((attribute) => normalizeCover(image.attr(attribute))).find(Boolean);
    const rate = row.find("p.rateInfo");
    const scoreText = text(rate.find("small.fade").first().text());
    const score = /^\d+(?:\.\d+)?$/.test(scoreText) ? Number(scoreText) : undefined;
    const totalMatch = text(rate.text()).match(/\(([\d,]+)\s*人评分\)/);
    const total = totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : undefined;
    if (total > 0) ratedRows++;
    if (total > 0 && validScore(score)) parsedScores++;
    const subject = {
      id,
      name: originalName || displayedName,
      name_cn: originalName && originalName !== displayedName ? displayedName : "",
      date,
      platform,
    };
    if (cover) subject.images = { small: cover, grid: cover };
    if (validScore(score)) subject.rating = { score, ...(total > 0 ? { total } : {}) };
    subjects.push(subject);
  }
  if (!subjects.length) throw new Error("第 " + page + " 页没有有效条目，拒绝覆盖快照");
  return { subjects, currentPage, totalPages, ratedRows, parsedScores };
}

export async function fetchTextWithRetry(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  retries = 2,
  sleepImpl = sleep,
  accessToken = "",
} = {}) {
  const auth = authorizationHeaders(url, accessToken);
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", ...auth },
        ...(accessToken ? { redirect: "error" } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error("HTTP " + response.status + ": " + url);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } catch (error) {
      const retryable = !error.status || [408, 425, 429].includes(error.status) || error.status >= 500;
      if (!retryable || attempt >= retries) {
        if (accessToken && !error.status) throw new Error("Bangumi 授权请求连接失败，请检查网络或代理后重试");
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await sleepImpl(Math.min(1_000 * 2 ** attempt, 5_000));
  }
}

function cleanImages(images) {
  if (!images || typeof images !== "object") return undefined;
  const normalized = Object.fromEntries(Object.entries(images)
    .map(([key, value]) => [key, normalizeCover(value)]).filter(([, value]) => value));
  const first = normalized.small || normalized.medium || normalized.large || normalized.grid || normalized.common;
  return first ? { ...normalized, small: normalized.small || first, grid: normalized.grid || first } : undefined;
}

function applyDetails(subject, details) {
  if (!details) return subject;
  const images = cleanImages(details.images);
  if (!subject.images && images) subject.images = images;
  if (!subject.date) subject.date = normalizeDate(details.date);
  if (!subject.name_cn && details.name_cn) subject.name_cn = text(details.name_cn);
  // The official API distinguishes the original name from its Chinese translation.
  if (details.name && details.name_cn) subject.name = text(details.name);
  const score = details.rating?.score ?? details.score;
  if (!subject.rating && validScore(score)) {
    subject.rating = { score };
    if (Number.isInteger(details.rating?.total) && details.rating.total > 0) subject.rating.total = details.rating.total;
  }
  return subject;
}

export function validateSnapshot(snapshot, { previous, ratedRows, parsedScores, maxDrop = 0.15 } = {}) {
  const subjects = snapshot.subjects;
  if (!Array.isArray(subjects) || !subjects.length || snapshot.count !== subjects.length) {
    throw new Error("快照为空或计数不一致，保留原有文件");
  }
  if (subjects.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || !text(item.name)) ||
      new Set(subjects.map((item) => item.id)).size !== subjects.length) {
    throw new Error("快照存在无效条目或重复 ID");
  }
  const oldCount = previous?.subjects?.length || 0;
  if (oldCount && subjects.length < oldCount * (1 - maxDrop)) {
    throw new Error("快照从 " + oldCount + " 降为 " + subjects.length + "，降幅超过 " + maxDrop * 100 + "%，保留原有文件");
  }
  if (ratedRows > 0 && parsedScores / ratedRows < 0.85) {
    throw new Error("网页评分解析异常：" + ratedRows + " 个有评分人数的条目仅解析出 " + parsedScores + " 个有效评分");
  }
  const rated = subjects.filter((subject) => subject.rating?.total > 0);
  if (rated.length && rated.filter((subject) => validScore(subject.rating?.score)).length / rated.length < 0.85) {
    throw new Error("快照评分普遍无效，保留原有文件");
  }
  if (subjects.length >= 100) {
    const wellVoted = subjects.filter((subject) => subject.rating?.total >= 10);
    if (wellVoted.length < Math.min(100, subjects.length * 0.05) ||
        wellVoted.filter((subject) => validScore(subject.rating.score)).length / wellVoted.length < 0.8) {
      throw new Error("清单缺少足够的有效公共评分，可能是评分节点变化，保留原有文件");
    }
  }
  const oldRated = previous?.subjects?.filter((subject) => validScore(subject.rating?.score)).length || 0;
  const newRated = subjects.filter((subject) => validScore(subject.rating?.score)).length;
  if (oldRated >= 20 && newRated < oldRated * (1 - maxDrop)) {
    throw new Error("有效评分数量明显下降，可能是网页结构变化，保留原有文件");
  }
  for (const subject of subjects) {
    for (const cover of Object.values(subject.images || {})) {
      if (!normalizeCover(cover)) throw new Error("条目 " + subject.id + " 含有无效封面 URL");
    }
  }
  return snapshot;
}

/** Fetch all pages in memory; this function never writes files. */
export async function fetchGalgameSnapshot({
  config,
  previous = {},
  personal = {},
  fetchImpl = globalThis.fetch,
  maxPages = 700,
  enrichLimit = 50,
  sleepImpl = sleep,
  logger = console,
  now = new Date(),
  timeoutMs = 20_000,
  retries = 2,
  accessToken = "",
} = {}) {
  const tag = config?.galgame?.tag || "Galgame";
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(enrichLimit) || enrichLimit < 0) {
    throw new Error("maxPages 必须为正整数，enrichLimit 必须为非负整数");
  }
  const requestOptions = { fetchImpl, sleepImpl, timeoutMs, retries };
  const map = new Map();
  let totalPages;
  let ratedRows = 0;
  let parsedScores = 0;
  for (let page = 1; ; page++) {
    const parsed = parseGalgamePage(await fetchTextWithRetry(tagPageUrl(tag, page), requestOptions), { tag, page });
    if (parsed.totalPages > maxPages) {
      throw new Error("标签页共有 " + parsed.totalPages + " 页，超过上限 " + maxPages + "，拒绝发布截断数据");
    }
    if (totalPages !== undefined && parsed.totalPages !== totalPages) {
      throw new Error("抓取期间总页数从 " + totalPages + " 变为 " + parsed.totalPages + "，请重试以避免漏项");
    }
    totalPages = parsed.totalPages;
    const additions = parsed.subjects.filter((subject) => !map.has(subject.id));
    if (!additions.length) throw new Error("第 " + page + " 页没有新增条目，可能重复返回了前一页，拒绝发布不完整数据");
    if (additions.length !== parsed.subjects.length) {
      logger.warn("第 " + page + " 页有 " + (parsed.subjects.length - additions.length) + " 条跨页重合，已去重");
    }
    for (const subject of parsed.subjects) map.set(subject.id, subject);
    ratedRows += parsed.ratedRows;
    parsedScores += parsed.parsedScores;
    logger.log("第 " + page + "/" + totalPages + " 页：本页 " + parsed.subjects.length + " 条，去重后 " + map.size + " 条");
    if (page === totalPages) break;
    await sleepImpl(350);
  }
  const subjects = [...map.values()];
  const snapshot = {
    updated_at: now.toISOString(),
    source: { type: "bangumi_user_tag", tag, url: tagPageUrl(tag, 1) },
    count: subjects.length,
    subjects,
  };
  // Validate extraction before cached/API details can disguise broken parsing.
  validateSnapshot(snapshot, { previous: { subjects: previous.subjects?.map((s) => ({ id: s.id })) }, ratedRows, parsedScores });
  const previousMap = new Map((previous.subjects || []).map((subject) => [subject.id, subject]));
  const personalMap = new Map((personal.collections || [])
    .filter((item) => item.subject_type === 4 && item.subject)
    .map((item) => [item.subject_id, item.subject]));
  for (const subject of subjects) {
    const old = previousMap.get(subject.id);
    applyDetails(subject, personalMap.get(subject.id));
    // Preserve useful cached details without reintroducing bad URLs or zero scores.
    applyDetails(subject, old);
    if (old?.details_checked_at) subject.details_checked_at = old.details_checked_at;
    if (old?.details_access) subject.details_access = old.details_access;
  }
  await enrichMissingDetails(subjects, { config, enrichLimit, now, logger, accessToken, ...requestOptions });
  return validateSnapshot(snapshot, { previous, ratedRows, parsedScores });
}

/** Missing public details (404) are per-item gaps, not an API outage. */
export async function enrichMissingDetails(subjects, {
  config, enrichLimit = 50, now = new Date(), logger = console,
  fetchImpl = globalThis.fetch, sleepImpl = sleep, timeoutMs = 20_000, retries = 2,
  accessToken = "", priorityIds = [],
} = {}) {
  if (!Number.isInteger(enrichLimit) || enrichLimit < 0) throw new Error("enrichLimit 必须为非负整数");
  const requestOptions = { fetchImpl, sleepImpl, timeoutMs, retries, accessToken };
  const accessMode = accessToken ? "authorized" : "public";
  const cacheAgeMs = 30 * 24 * 60 * 60 * 1_000;
  const priorities = new Map(priorityIds.map((id, index) => [id, index]));
  const apiBase = (config?.bangumi?.apiBase || "https://api.bgm.tv/v0").replace(/\/$/, "");
  authorizationHeaders(apiBase + "/subjects/1", accessToken);
  const candidates = subjects.filter((subject) => !subject.images &&
    ((accessToken && subject.details_access !== "authorized") ||
      !(Date.parse(subject.details_checked_at) > now.getTime() - cacheAgeMs)))
    .sort((a, b) => (priorities.get(a.id) ?? Infinity) - (priorities.get(b.id) ?? Infinity))
    .slice(0, enrichLimit);
  let filled = 0;
  let failures = 0;
  for (const subject of candidates) {
    try {
      const details = JSON.parse(await fetchTextWithRetry(apiBase + "/subjects/" + subject.id, requestOptions));
      if (details.id !== subject.id || details.type !== 4) throw new Error("API 条目 ID 或类型不符");
      applyDetails(subject, details);
      subject.details_checked_at = now.toISOString();
      subject.details_access = accessMode;
      if (subject.images) filled++;
      failures = 0;
    } catch (error) {
      if (accessToken && [401, 403].includes(error.status)) throw authorizationError(error.status);
      // Cache unavailable public details; transient failures can be retried next run.
      logger.warn("条目 " + subject.id + " 详情补全失败，保留已知字段：" + error.message);
      if (error.status === 404) {
        subject.details_checked_at = now.toISOString();
        subject.details_access = accessMode;
        failures = 0;
      } else if (++failures >= 3) {
        logger.warn("连续三次详情补全失败，停止本轮可选补全");
        break;
      }
    }
    await sleepImpl(350);
  }
  logger.log("详情补全：" + accessMode + "，新增 " + filled + " 张封面");
  return subjects;
}

async function readOptionalJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeSnapshotAtomic(filename, snapshot) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function main({ cwd = process.cwd(), fetchImpl = globalThis.fetch, args = process.argv.slice(2), ...options } = {}) {
  const config = JSON.parse(await readFile(path.resolve(cwd, "config.json"), "utf8"));
  const output = path.resolve(cwd, config.galgame?.snapshotFile || "data/galgame-list.json");
  const checkArgument = args.find((argument) => /^--check-page=\d+$/.test(argument));
  if (args.some((argument) => !["--dry-run", "--enrich-only", checkArgument].includes(argument))) throw new Error("未知参数；可用 --dry-run、--enrich-only 或 --check-page=1");
  if (checkArgument && args.includes("--enrich-only")) throw new Error("--check-page 不能与 --enrich-only 同时使用");
  if (checkArgument) {
    const page = Number(checkArgument.split("=")[1]);
    const tag = config.galgame?.tag || "Galgame";
    const parsed = parseGalgamePage(await fetchTextWithRetry(tagPageUrl(tag, page), { fetchImpl, ...options }), { tag, page });
    console.log(JSON.stringify(parsed, null, 2));
    return parsed;
  }
  const personalFile = path.resolve(cwd, config.bangumi?.snapshotFile || "data/my-collections.json");
  const [previous, personal] = await Promise.all([readOptionalJson(output), readOptionalJson(personalFile)]);
  const accessToken = options.accessToken ?? await loadAccessToken(options);
  if (accessToken) {
    await verifyAccessToken(accessToken, { username: config.bangumi.username, fetchImpl, ...options });
    console.log("已自动使用 Bangumi 授权补全详情");
  } else console.log("未配置 Bangumi 授权：受限条目可能缺少封面，可运行 npm run auth:setup");
  const enrichLimit = Number(process.env.GALGAME_ENRICH_LIMIT ?? (accessToken ? 200 : 50));
  let snapshot;
  if (args.includes("--enrich-only")) {
    validateSnapshot(previous);
    snapshot = structuredClone(previous);
    let priorityIds = [];
    const metadata = await readOptionalJson(path.resolve(cwd, config.recommendations?.snapshotFile || "data/recommendation-metadata.json"));
    if (metadata.schema_version === 1) {
      const { recommendGames } = await import("../recommendations.js");
      priorityIds = recommendGames(snapshot.subjects, personal.collections || [], metadata).items.map(item => item.subject.id);
    }
    await enrichMissingDetails(snapshot.subjects, { config, fetchImpl, enrichLimit, ...options, accessToken, priorityIds });
    snapshot.details_updated_at = (options.now || new Date()).toISOString();
    validateSnapshot(snapshot, { previous });
  } else snapshot = await fetchGalgameSnapshot({
    config, previous, personal, fetchImpl,
    maxPages: Number(process.env.GALGAME_MAX_PAGES || 700),
    enrichLimit, ...options, accessToken,
  });
  if (!args.includes("--dry-run")) await writeSnapshotAtomic(output, snapshot);
  console.log("✅ Galgame 用户标签快照" + (args.includes("--dry-run") ? "验证通过（未写文件）" : "已更新") + "，共 " + snapshot.count + " 条");
  return snapshot;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error("抓取失败，保留原有快照：", error);
    process.exitCode = 1;
  });
}
