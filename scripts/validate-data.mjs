import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateRecommendationMetadata } from "../recommendations.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function validateEnvelope(snapshot, key) {
  check(Array.isArray(snapshot?.[key]), `${key} 必须是数组`);
  check(snapshot.count === snapshot[key].length, `${key} 数量与 count 不一致`);
  check(snapshot.count > 0, `${key} 不得为空`);
  check(Number.isFinite(Date.parse(snapshot.updated_at)), `${key} 缺少有效更新时间`);
}

function checkImages(images, id) {
  for (const value of Object.values(images || {})) {
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`条目 ${id} 封面 URL 无效`); }
    check(["https:", "http:"].includes(url.protocol), `条目 ${id} 封面协议无效`);
    check(!/^\/+lain\.bgm\.tv\//.test(url.pathname), `条目 ${id} 封面错误地拼接了两个域名`);
    check(!url.pathname.includes("no_icon_subject"), `条目 ${id} 不应把占位图保存为封面`);
  }
}

/** Validate the exact JSON contract consumed by the static page before publishing. */
export function validateData(galgame, mine) {
  validateEnvelope(galgame, "subjects");
  validateEnvelope(mine, "collections");
  const ids = new Set();
  let rated = 0, scores = 0, covers = 0;
  for (const s of galgame.subjects) {
    check(Number.isSafeInteger(s.id) && s.id > 0 && !ids.has(s.id), `清单 ID 无效或重复：${s.id}`);
    ids.add(s.id);
    check(typeof s.name === "string" && s.name.trim().length > 0, `条目 ${s.id} 缺少标题`);
    checkImages(s.images, s.id);
    if (Object.values(s.images || {}).some(Boolean)) covers++;
    if (s.rating) {
      check(s.rating.total === undefined || (Number.isInteger(s.rating.total) && s.rating.total >= 0), `条目 ${s.id} 评分人数无效`);
      check(Number.isFinite(s.rating.score) && s.rating.score >= 0 && s.rating.score <= 10, `条目 ${s.id} 评分无效`);
      if (s.rating.total >= 10) rated++;
      if (s.rating.total >= 10 && s.rating.score > 0) scores++;
    }
  }
  // Small/no-vote subjects may legitimately have no public score. A broadly broken
  // parser must not turn every well-voted subject into a zero while still passing CI.
  if (galgame.count >= 100) {
    check(rated >= Math.min(100, galgame.count * 0.05), "清单缺少足够的公共评分数据，可能解析失败");
    check(scores / rated >= 0.8, "大部分有足够评分人数的条目没有有效分数，拒绝发布");
  }
  const collectionIds = new Set();
  for (const c of mine.collections) {
    const id = c.subject?.id;
    check(Number.isSafeInteger(id) && id > 0 && !collectionIds.has(id), `收藏 ID 无效或重复：${id}`);
    collectionIds.add(id);
    check([1, 2, 3, 4, 5].includes(c.type), `收藏 ${id} 状态无效`);
    check([1, 2, 3, 4, 6].includes(c.subject.type), `收藏 ${id} 类型无效`);
    check(Number.isFinite(c.rate) && c.rate >= 0 && c.rate <= 10, `收藏 ${id} 个人评分无效`);
    checkImages(c.subject.images, id);
  }
  return { subjects: ids.size, collections: collectionIds.size, publicScores: scores, covers,
    uncollected: galgame.subjects.filter(s => !collectionIds.has(s.id)).length };
}

export async function main() {
  const config = JSON.parse(await readFile("config.json", "utf8"));
  const [galgame, mine, recommendations] = await Promise.all([
    readFile(config.galgame.snapshotFile, "utf8").then(JSON.parse),
    readFile(config.bangumi.snapshotFile, "utf8").then(JSON.parse),
    readFile(config.recommendations.snapshotFile, "utf8").then(JSON.parse),
  ]);
  validateRecommendationMetadata(recommendations);
  check(Number.isFinite(Date.parse(recommendations.source?.date)), "推荐档案缺少有效来源日期");
  check(galgame.subjects.filter(s => recommendations.subjects[s.id]).length >= galgame.count * 0.85, "推荐元数据覆盖率不足 85%");
  console.log("数据校验通过：", JSON.stringify(validateData(galgame, mine)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error("数据校验失败：", error.message); process.exitCode = 1; });
}
