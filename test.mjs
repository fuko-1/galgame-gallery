const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

async function test() {
  const url = "https://bgm.tv/game/tag/Galgame?sort=collect&page=1";
  const res = await fetch(url, { headers: UA });
  console.log("HTTP 状态:", res.status);
  const html = await res.text();
  console.log("HTML 长度:", html.length);

  // 提取条目 id：链接形如 /subject/12345
  const ids = [...html.matchAll(/\/subject\/(\d+)/g)].map(m => m[1]);
  const uniq = [...new Set(ids)];
  console.log("本页提取到条目 id 数量:", uniq.length);
  console.log("前几个 id:", uniq.slice(0, 10).join(", "));

  // 看看有没有被 Cloudflare 拦
  if (html.includes("Just a moment") || html.includes("challenge") || html.length < 2000) {
    console.log("⚠️ 可能被 Cloudflare 拦截了！HTML 开头:");
    console.log(html.slice(0, 500));
  } else {
    console.log("✅ 看起来正常抓到网页了");
  }
}

test().catch(e => console.log("错误:", e.message));
