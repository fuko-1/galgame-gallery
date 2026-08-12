import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("data/galgame-list.json");
const BASE = "https://bgm.tv/game/tag/Galgame?sort=collect&page=";
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9",
};
const SLEEP_MS = 350;
const MAX_PAGES = 700;   // 634 页 + 余量

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从单页 HTML 解析出所有条目 */
function parsePage(html) {
  const items = [];
  const liRegex = /<li id="item_(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    const id = Number(m[1]);
    const block = m[2];

    // 标题
    const titleM = block.match(/<a href="\/subject\/\d+" class="l">([\s\S]*?)<\/a>/);
    const name = titleM ? decodeEntities(titleM[1].trim()) : "";

    // 信息行：日期 / 平台 / 类型 / 会社
    const infoM = block.match(/<p class="info tip">([\s\S]*?)<\/p>/);
    let date = "", platform = "";
    if (infoM) {
      const parts = decodeEntities(infoM[1]).split("/").map(s => s.trim());
      date = /^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? parts[0] : "";
      platform = parts[1] || "";
    }

    // 封面
    const imgM = block.match(/<img src="([^"]+)" class="cover"/);
    let cover = imgM ? imgM[1] : "";
    if (cover.includes("no_icon_subject")) cover = "";
    if (cover.startsWith("/")) cover = "https://bgm.tv" + cover;
    if (cover.startsWith("//")) cover = "https:" + cover;

    // 评分：<span class="sstarsN"></span> 或 fade，以及评分人数
    let score = 0, total = 0;
    const starM = block.match(/<span class="starstop-s"><span class="starlight stop(\d+)"/);
    if (starM) score = Number(starM[1]);          // stop1~stop10
    const totalM = block.match(/\((\d+)人评分\)/);
    if (totalM) total = Number(totalM[1]);

    items.push({
      id,
      name,
      name_cn: "",
      date,
      platform,
      images: cover ? { small: cover, grid: cover } : undefined,
      rating: total > 0 ? { score, total } : undefined,
    });
  }
  return items;
}

/** 简单的 HTML 实体反转义 */
function decodeEntities(s) {
  return s
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

async function fetchPage(page) {
  const res = await fetch(BASE + page, { headers: UA });
  if (!res.ok) throw new Error(`第 ${page} 页 HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const map = new Map();
  let emptyStreak = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let html;
    try {
      html = await fetchPage(page);
    } catch (e) {
      console.error(`第 ${page} 页失败：`, e.message);
      await sleep(1500);
      html = await fetchPage(page);
    }
    const items = parsePage(html);
    for (const it of items) if (!map.has(it.id)) map.set(it.id, it);
    console.log(`第 ${page} 页：本页 ${items.length} 条，累计 ${map.size} 条`);

    if (items.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) { console.log("连续空页，判定抓完"); break; }
    } else {
      emptyStreak = 0;
    }
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
