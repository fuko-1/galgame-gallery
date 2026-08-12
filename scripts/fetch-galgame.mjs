import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.bgm.tv/v0/search/subjects";
const OUT = path.resolve("data/galgame-list.json");
const PAGE = 100;
const SLEEP_MS = 400;
const MAX_PAGES = 500;

// Galgame 相关标签（覆盖全一点，合并去重）
const TAGS = ["Galgame", "galgame", "GALGAME", "视觉小说", "ADV", "文字冒险"];

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

async function fetchPage(tag, offset) {
  const body = {
    keyword: "",
    sort: "rank",
    filter: { type: [4], tag: [tag] },
    limit: PAGE,
    offset: offset,
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

async function fetchTag(tag) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE;
    let data;
    try {
      data = await fetchPage(tag, offset);
    } catch (e) {
      console.error(`[${tag}] 第 ${page + 1} 页失败：`, e.message);
      await sleep(1500);
      data = await fetchPage(tag, offset);
    }
    const list = (data.data || []).map(slim);
    out.push(...list);
    if (list.length < PAGE) break;
    await sleep(SLEEP_MS);
  }
  console.log(`[${tag}] 抓到 ${out.length} 条`);
  return out;
}

async function main() {
  const map = new Map();
  for (const tag of TAGS) {
    const list = await fetchTag(tag);
    for (const s of list) if (s && s.id) map.set(s.id, s);
    await sleep(SLEEP_MS);
  }
  const subjects = [...map.values()];

  const payload = {
    updated_at: new Date().toISOString(),
    count: subjects.length,
    subjects,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload), "utf8");
  console.log(`✅ 全站 Galgame 完成，共 ${subjects.length} 条`);
}

main().catch((e) => {
  console.error("抓取失败：", e);
  process.exit(1);
});
