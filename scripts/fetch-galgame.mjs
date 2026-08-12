import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.bgm.tv/v0/search/subjects";
const OUT = path.resolve("data/galgame-list.json");
const PAGE = 100;          // 每页数量（放在请求体里）
const SLEEP_MS = 350;
const MAX_PAGES = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slim(s) {
  return {
    id: s.id,
    name: s.name,
    name_cn: s.name_cn,
    date: s.date || "",
    platform: s.platform || "",
    images: s.images ? { small: s.images.small, grid: s.images.grid } : undefined,
    rating: s.rating ? { score: s.rating.score, total: s.rating.total } : undefined,
  };
}

async function fetchPage(offset) {
  const body = {
    keyword: "",
    sort: "rank",
    filter: { type: [4], tag: ["Galgame"], air_date: [">=1900-01-01"] },
    limit: PAGE,           // ← limit 放这里
    offset: offset,        // ← offset 放这里
  };
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "fuko-galgame-gallery/1.0 (https://github.com/)",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`搜索接口返回 ${res.status}：${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE;
    let data;
    try {
      data = await fetchPage(offset);
    } catch (e) {
      console.error(`第 ${page + 1} 页失败：`, e.message);
      await sleep(1500);
      data = await fetchPage(offset);
    }
    const list = (data.data || []).map(slim);
    all.push(...list);
    console.log(`第 ${page + 1} 页：本页 ${list.length} 条，累计 ${all.length} 条`);
    if (list.length < PAGE) break;   // 不足一页说明抓完了
    await sleep(SLEEP_MS);
  }

  const map = new Map();
  for (const s of all) if (s && s.id) map.set(s.id, s);
  const subjects = [...map.values()];

  const payload = {
    updated_at: new Date().toISOString(),
    count: subjects.length,
    subjects,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload), "utf8");
  console.log(`✅ 完成，共 ${subjects.length} 条`);
}

main().catch((e) => {
  console.error("抓取失败：", e);
  process.exit(1);
});
