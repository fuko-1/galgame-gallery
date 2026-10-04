// Optional live smoke test: a single tag page and a single API page; no file writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGalgamePage } from './scripts/fetch-galgame.mjs';

const config = JSON.parse(await readFile('config.json', 'utf8'));
async function fetchChecked(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'fuko-galgame-gallery/1.0 (https://github.com/fuko-1/galgame-gallery)' },
    signal: AbortSignal.timeout(25000),
  });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return response;
}

try {
  const tagUrl = new URL(`https://bgm.tv/game/tag/${encodeURIComponent(config.galgame.tag)}`);
  tagUrl.searchParams.set('sort', 'collects');
  tagUrl.searchParams.set('page', '1');
  const parsed = parseGalgamePage(await (await fetchChecked(tagUrl)).text(), { tag: config.galgame.tag, page: 1 });
  assert.ok(parsed.subjects.length > 0, '标签页没有条目');
  assert.ok(parsed.subjects.some(s => s.rating?.score > 0), '标签页未解析到有效数字评分');
  assert.ok(parsed.subjects.some(s => Object.values(s.images || {}).some(url => url.startsWith('https://lain.bgm.tv/'))), '未找到有效封面 URL');

  const apiUrl = new URL(`${config.bangumi.apiBase.replace(/\/$/, '')}/users/${encodeURIComponent(config.bangumi.username)}/collections`);
  apiUrl.searchParams.set('subject_type', '4');
  apiUrl.searchParams.set('type', '2');
  apiUrl.searchParams.set('limit', '1');
  apiUrl.searchParams.set('offset', '0');
  const body = await (await fetchChecked(apiUrl)).json();
  assert.ok(Number.isInteger(body.total) && body.total >= 0, '收藏 API 缺少 total');
  assert.ok(Array.isArray(body.data), '收藏 API 缺少 data');
  assert.ok(body.total === 0 || body.data.length > 0, '收藏 API 返回了不完整页');
  console.log(`真实数据源检查通过：标签首页 ${parsed.subjects.length} 条，已玩游戏 ${body.total} 条。`);
} catch (error) {
  console.error('真实数据源检查失败：', error.message);
  process.exitCode = 1;
}
