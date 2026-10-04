import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CONFIG = fileURLToPath(new URL("../config.json", import.meta.url));
const TYPES = [1, 2, 3, 4, 6];
const STATUSES = [1, 2, 3, 4, 5];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;

function validateConfig(config) {
  if (!isObject(config) || typeof config.username !== "string" || !config.username.trim()) {
    throw new Error("config.json 缺少 bangumi.username");
  }
  if (typeof config.apiBase !== "string" || !/^https?:\/\//.test(config.apiBase)) {
    throw new Error("config.json 的 bangumi.apiBase 必须是 HTTP(S) 地址");
  }
  new URL(config.apiBase);
}

/** 校验前端使用的字段，并拒绝跨分页或跨收藏状态重复的条目。 */
export function validateCollections(collections) {
  if (!Array.isArray(collections)) throw new Error("collections 必须是数组");
  const ids = new Set();
  for (const item of collections) {
    if (!isObject(item) || !positiveInt(item.subject_id) || !TYPES.includes(item.subject_type)
        || !STATUSES.includes(item.type) || !Number.isInteger(item.rate) || item.rate < 0 || item.rate > 10) {
      throw new Error("收藏条目的 ID、类型、状态或个人评分无效");
    }
    if (ids.has(item.subject_id)) throw new Error(`收藏条目重复：${item.subject_id}`);
    ids.add(item.subject_id);
    const subject = item.subject;
    if (!isObject(subject) || subject.id !== item.subject_id || subject.type !== item.subject_type
        || typeof subject.name !== "string" || typeof subject.name_cn !== "string"
        || !(subject.name.trim() || subject.name_cn.trim())) {
      throw new Error(`收藏条目 ${item.subject_id} 的 subject 结构无效`);
    }
    if (typeof item.updated_at !== "string" || !Number.isFinite(Date.parse(item.updated_at))
        || !Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string")
        || !(item.comment === null || typeof item.comment === "string") || typeof item.private !== "boolean") {
      throw new Error(`收藏条目 ${item.subject_id} 的收藏字段无效`);
    }
    if (subject.images !== undefined && subject.images !== null
        && (!isObject(subject.images) || Object.values(subject.images).some((url) => typeof url !== "string"))) {
      throw new Error(`收藏条目 ${item.subject_id} 的封面字段无效`);
    }
    if (subject.score !== undefined && (typeof subject.score !== "number" || !Number.isFinite(subject.score)
        || subject.score < 0 || subject.score > 10)) {
      throw new Error(`收藏条目 ${item.subject_id} 的 Bangumi 评分无效`);
    }
  }
  return collections;
}

async function fetchJson(url, { fetchImpl, sleepImpl, timeoutMs, retries }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "fuko-galgame-gallery/1.0", Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Bangumi 收藏 API 返回 HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.retryable === false || attempt === retries) throw error;
    } finally {
      clearTimeout(timer);
    }
    await sleepImpl(Math.min(1000 * 2 ** attempt, 8000));
  }
}

/** 根据 API 的 total 完整读取五种媒介的五种收藏状态，不静默截断。 */
export async function fetchCollections(config, options = {}) {
  validateConfig(config);
  const settings = {
    fetchImpl: globalThis.fetch,
    sleepImpl: sleep,
    timeoutMs: 15_000,
    retries: 2,
    pageSize: 100,
    requestDelayMs: 300,
    maxPages: 10_000,
    ...options,
  };
  if (!positiveInt(settings.pageSize) || settings.pageSize > 100 || !positiveInt(settings.maxPages)
      || !positiveInt(settings.timeoutMs) || !Number.isInteger(settings.retries) || settings.retries < 0
      || !Number.isFinite(settings.requestDelayMs) || settings.requestDelayMs < 0) {
    throw new Error("收藏抓取的分页、重试或超时配置无效");
  }
  const all = [];
  let requests = 0;
  for (const subjectType of TYPES) {
    for (const status of STATUSES) {
      let expectedTotal;
      let offset = 0;
      for (let page = 0; ; page++) {
        if (page >= settings.maxPages) throw new Error(`收藏 ${subjectType}/${status} 超过分页安全上限，拒绝截断`);
        if (requests++) await settings.sleepImpl(settings.requestDelayMs);
        const url = new URL(`${config.apiBase.replace(/\/$/, "")}/users/${encodeURIComponent(config.username)}/collections`);
        url.search = new URLSearchParams({
          subject_type: String(subjectType), type: String(status),
          limit: String(settings.pageSize), offset: String(offset),
        });
        const result = await fetchJson(url.href, settings);
        if (!isObject(result) || !Number.isSafeInteger(result.total) || result.total < 0
            || result.limit !== settings.pageSize || result.offset !== offset || !Array.isArray(result.data)) {
          throw new Error(`收藏 ${subjectType}/${status} 分页响应的 total/limit/offset/data 结构无效`);
        }
        if (expectedTotal === undefined) expectedTotal = result.total;
        if (result.total !== expectedTotal) throw new Error(`收藏 ${subjectType}/${status} 抓取期间 total 改变，请重试`);
        const expectedLength = Math.min(settings.pageSize, expectedTotal - offset);
        if (result.data.length !== expectedLength) {
          throw new Error(`收藏 ${subjectType}/${status} 分页不完整：预期 ${expectedLength} 条，收到 ${result.data.length} 条`);
        }
        validateCollections(result.data);
        if (result.data.some((item) => item.subject_type !== subjectType || item.type !== status)) {
          throw new Error(`收藏 ${subjectType}/${status} 返回了其他类型或状态的条目`);
        }
        all.push(...result.data);
        offset += result.data.length;
        if (offset === expectedTotal) break;
      }
    }
  }
  return validateCollections(all);
}

function validateSnapshot(snapshot) {
  if (!isObject(snapshot) || !Number.isSafeInteger(snapshot.count) || snapshot.count < 0
      || !Array.isArray(snapshot.collections) || snapshot.count !== snapshot.collections.length) {
    throw new Error("旧收藏快照结构无效，拒绝覆盖");
  }
  validateCollections(snapshot.collections);
}

/** 全部请求和质量检查通过后，在目标目录内原子替换快照。 */
export async function updateMySnapshot({ configPath = DEFAULT_CONFIG, now = () => new Date(), ...options } = {}) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateConfig(config.bangumi);
  if (typeof config.bangumi.snapshotFile !== "string" || !config.bangumi.snapshotFile.trim()) {
    throw new Error("config.json 缺少 bangumi.snapshotFile");
  }
  const output = path.resolve(path.dirname(configPath), config.bangumi.snapshotFile);
  let previous;
  try {
    previous = JSON.parse(await readFile(output, "utf8"));
    validateSnapshot(previous);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const collections = await fetchCollections(config.bangumi, options);
  if (previous?.count > 0 && collections.length < previous.count * 0.85) {
    throw new Error(`收藏数量从 ${previous.count} 降至 ${collections.length}，下降超过 15%，保留旧快照`);
  }
  const payload = { updated_at: now().toISOString(), count: collections.length, collections };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return payload;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  updateMySnapshot().then((payload) => {
    console.log(`✅ 我的收藏完成，共 ${payload.count} 条`);
  }).catch((error) => {
    console.error("抓取失败：", error.message);
    process.exitCode = 1;
  });
}
