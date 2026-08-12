const API = "https://api.bgm.tv/v0";
const UA = { "User-Agent": "fuko-test/1.0" };

// 方式1：搜索 API + tag 过滤（当前方案，确认是否真只有36）
async function test1() {
  const res = await fetch(`${API}/search/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify({ keyword: "", sort: "rank", filter: { type: [4], tag: ["Galgame"] }, limit: 100, offset: 0 }),
  });
  const d = await res.json();
  console.log("[方式1 搜索API+tag] total =", d.total, " 本页 =", (d.data || []).length);
}

// 方式2：搜索 API，关键词=Galgame，不限 tag，看总数
async function test2() {
  const res = await fetch(`${API}/search/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify({ keyword: "Galgame", sort: "rank", filter: { type: [4] }, limit: 100, offset: 0 }),
  });
  const d = await res.json();
  console.log("[方式2 搜索API+关键词] total =", d.total, " 本页 =", (d.data || []).length);
}

// 方式3：搜索 API + tag，用 meta_tags 字段名（v0 的另一个写法）
async function test3() {
  const res = await fetch(`${API}/search/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify({ keyword: "", sort: "rank", filter: { type: [4], meta_tags: ["Galgame"] }, limit: 100, offset: 0 }),
  });
  const d = await res.json();
  console.log("[方式3 搜索API+meta_tags] total =", d.total, " 本页 =", (d.data || []).length);
}

(async () => {
  for (const [name, fn] of [["方式1", test1], ["方式2", test2], ["方式3", test3]]) {
    try { await fn(); } catch (e) { console.log(`[${name}] 错误:`, e.message); }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("=== 测试完成 ===");
})();
