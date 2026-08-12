const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

async function test() {
  const res = await fetch("https://bgm.tv/game/tag/Galgame?sort=collect&page=1", { headers: UA });
  const html = await res.text();

  // 找到列表区域。Bangumi 标签页条目一般在 class="item" 的 li 里
  const liMatch = html.match(/<li[^>]*class="[^"]*item[^"]*"[^>]*>([\s\S]*?)<\/li>/);
  if (liMatch) {
    console.log("=== 单个条目 HTML（截取前 1500 字）===");
    console.log(liMatch[0].slice(0, 1500));
  } else {
    console.log("没找到 li.item，打印 subject 链接附近内容：");
    const idx = html.indexOf("/subject/");
    console.log(html.slice(idx - 200, idx + 1300));
  }
  console.log("=== 结束 ===");
}

test().catch(e => console.log("错误:", e.message));
