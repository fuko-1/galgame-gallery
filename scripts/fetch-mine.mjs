import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USER = "koberi";   // 你的 Bangumi 用户名
const OUT = path.resolve("data/my-collections.json");
const PAGE = 100;
const SLEEP_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 收藏状态 1想看 2看过 3在看 4搁置 5抛弃；条目类型 1书 2动画 3音乐 4游戏 6三次元
const STATUSES = [1, 2, 3, 4, 5];
const TYPES = [1, 2, 3, 4, 6];

async function fetchStatus(subjectType, type) {
  const out = [];
  let offset = 0;
  for (;;) {
    const url =
      `https://api.bgm.tv/v0/users/${USER}/collections` +
      `?subject_type=${subjectType}&type=${type}&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "fuko-galgame-gallery/1.0" },
    });
    if (!res.ok) throw new Error(`collections ${subjectType}/${type} 返回 ${res.status}`);
    const data = await res.json();
    const list = data.data || [];
    out.push(...list);
    if (list.length < PAGE) break;
    offset += PAGE;
    if (offset > 5000) break;
    await sleep(SLEEP_MS);
  }
  return out;
}

async function main() {
  const all = [];
  for (const t of TYPES) {
    for (const s of STATUSES) {
      const list = await fetchStatus(t, s);
      all.push(...list);
    }
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify({ updated_at: new Date().toISOString(), count: all.length, collections: all }),
    "utf8"
  );
  console.log(`✅ 我的收藏完成，共 ${all.length} 条`);
}

main().catch((e) => {
  console.error("抓取失败：", e);
  process.exit(1);
});
