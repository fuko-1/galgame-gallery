import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  enrichMissingDetails, fetchGalgameSnapshot, fetchTextWithRetry, main, normalizeCover, normalizeDate,
  parseGalgamePage, tagPageUrl, validateSnapshot, writeSnapshotAtomic,
} from "../scripts/fetch-galgame.mjs";

// Captured from the public Bangumi Galgame user-tag page, 2026-10-04.
const live = await readFile(new URL("fixtures/galgame-live-page.html", import.meta.url), "utf8");
const silent = { log() {}, warn() {} };
const noSleep = async () => {};
const response = (body, status = 200) => new Response(body, { status });
const row = (id, { score = "7.6", info = "2013年12月18日 / PC / ADV", image = "/img/no_icon_subject.png", original = "Original title" } = {}) => `
  <li class="item" id="item_${id}"><a class="subjectCover"><img loading="lazy" class="cover" src="${image}"></a>
  <h3><a class="l" href="/subject/${id}">中文 &amp; 标题</a><small class="grey">${original}</small></h3>
  <p class="tip info">${info}</p><p class="rateInfo"><span class="starlight stars8"></span>
  <small class="fade">${score}</small><span class="tip_j">(1,234人评分)</span></p></li>`;
const page = (rows, current = 1, total = 1) => `<h1>游戏标签: Galgame</h1><ul>${rows}</ul>
  <div class="page_inner"><strong class="p_cur">${current}</strong>
  <a href="?sort=collects&page=${total}">${total}</a><span class="p_edge">(&nbsp;${current}&nbsp;/&nbsp;${total}&nbsp;)</span></div>`;
const snapshot = (subjects) => ({ count: subjects.length, subjects });
const config = { galgame: { tag: "Galgame" }, bangumi: { apiBase: "https://api.example.test/v0" } };
const options = { config, sleepImpl: noSleep, logger: silent, enrichLimit: 0 };

test("real HTML preserves fractional scores, original/Chinese names, and cover hosts", () => {
  const parsed = parseGalgamePage(live);
  assert.equal(parsed.subjects.length, 24);
  assert.equal(parsed.totalPages, 647);
  assert.equal(parsed.ratedRows, 24);
  assert.equal(parsed.parsedScores, 24);
  const wonderful = parsed.subjects.find((item) => item.id === 4639);
  assert.equal(wonderful.rating.score, 8.7);
  assert.equal(wonderful.name, "素晴らしき日々～不連続存在～");
  assert.equal(wonderful.name_cn, "美好的每一天 ～不连续的存在～");
  assert.equal(wonderful.images, undefined);
  assert.equal(parsed.subjects.find((item) => item.id === 1126).images.small,
    "https://lain.bgm.tv/r/400/pic/cover/l/ff/ee/1126_wtoHO.jpg");
  assert.equal(parsed.subjects.find((item) => item.id === 12280).date, "2011-04-28");
  assert.equal(parsed.subjects.find((item) => item.id === 1167).platform, "");
});

test("DOM parsing tolerates attribute order, lazy images, entities and missing platform", () => {
  const html = page(row(1, { info: "2008-10-30 / ADV（一般向け） / 制作会社" })
    .replace('src="/img/no_icon_subject.png"', 'src="/img/no_icon_subject.png" data-cfsrc="//lain.bgm.tv/cover.jpg"'));
  const item = parseGalgamePage(html).subjects[0];
  assert.equal(item.name_cn, "中文 & 标题");
  assert.equal(item.platform, "");
  assert.equal(item.images.small, "https://lain.bgm.tv/cover.jpg");
  assert.deepEqual(item.rating, { score: 7.6, total: 1234 });
});

test("dates normalize only valid calendar dates and preserve the first release date", () => {
  assert.equal(normalizeDate("2013年12月18日"), "2013-12-18");
  assert.equal(normalizeDate("2011-04-28、2014-06-26等"), "2011-04-28");
  assert.equal(normalizeDate("2024/2/29 (PC)"), "2024-02-29");
  assert.equal(normalizeDate("2023-02-29"), "");
  assert.equal(normalizeDate("未定"), "");
});

test("invalid and placeholder covers cannot be restored from the old cache", () => {
  assert.equal(normalizeCover("//lain.bgm.tv/a.jpg"), "https://lain.bgm.tv/a.jpg");
  assert.equal(normalizeCover("https://bgm.tv//lain.bgm.tv/a.jpg"), "");
  assert.equal(normalizeCover("javascript:alert(1)"), "");
  assert.equal(normalizeCover("/img/no_icon_subject.png"), "");
});

test("wrong identity, missing pagination, repeated pages, wrong sorting and empty pages fail", () => {
  assert.throws(() => parseGalgamePage("<h1>请登录</h1>"), /不是预期/);
  assert.throws(() => parseGalgamePage("<h1>游戏标签: Galgame</h1>" + row(1)), /分页结构/);
  assert.throws(() => parseGalgamePage(page(row(1)), { page: 2 }), /分页结构/);
  assert.throws(() => parseGalgamePage(page(row(1)).replace("sort=collects", "sort=title")), /未按标注数/);
  assert.throws(() => parseGalgamePage(page("")), /没有有效条目/);
});

test("the page limit and changing pagination cannot silently truncate a snapshot", async () => {
  await assert.rejects(fetchGalgameSnapshot({ ...options, maxPages: 1,
    fetchImpl: async () => response(page(row(1), 1, 2)) }), /超过上限/);
  let requests = 0;
  await assert.rejects(fetchGalgameSnapshot({ ...options,
    fetchImpl: async () => response(++requests === 1 ? page(row(1), 1, 2) : page(row(2), 2, 3)) }), /抓取期间总页数/);
});

test("a repeated result page cannot masquerade as complete pagination", async () => {
  let requests = 0;
  await assert.rejects(fetchGalgameSnapshot({ ...options,
    fetchImpl: async () => response(page(row(1), ++requests, 2)) }), /没有新增条目/);
});

test("missing every rating node is rejected before cached details can conceal the regression", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(i + 1)
    .replace(/<p class="rateInfo">[\s\S]*?<\/p>/, "")).join("");
  const personal = { collections: Array.from({ length: 100 }, (_, i) => ({
    subject_id: i + 1, subject_type: 4, subject: { score: 8 },
  })) };
  await assert.rejects(fetchGalgameSnapshot({ ...options, personal,
    fetchImpl: async () => response(page(rows)) }), /缺少足够的有效公共评分/);
});

test("API/valid cached fields fill gaps without reviving malformed covers or zero ratings", async () => {
  const previous = snapshot([
    { id: 1, name: "old", images: { small: "https://bgm.tv//lain.bgm.tv/bad.jpg" }, rating: { score: 0, total: 12 } },
    { id: 2, name: "old", images: { small: "https://lain.bgm.tv/cached.jpg" } },
    { id: 3, name: "old", images: { small: "https://bgm.tv//lain.bgm.tv/bad.jpg" } },
  ]);
  const personal = { collections: [{ subject_id: 1, subject_type: 4,
    subject: { name: "API original", name_cn: "API中文", date: "2013-12-18", score: 8.8,
      images: { small: "https://lain.bgm.tv/personal.jpg" } } }] };
  const result = await fetchGalgameSnapshot({ ...options, previous, personal,
    fetchImpl: async () => response(page(row(1) + row(2) + row(3))) });
  assert.equal(result.subjects[0].images.small, "https://lain.bgm.tv/personal.jpg");
  assert.equal(result.subjects[0].rating.score, 7.6); // Current HTML score remains authoritative.
  assert.equal(result.subjects[1].images.small, "https://lain.bgm.tv/cached.jpg");
  assert.equal(result.subjects[2].images, undefined);
});

test("API enrichment obeys the limit and caches successful details for later runs", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.startsWith("https://bgm.tv/")) return response(page(row(1) + row(2)));
    const id = Number(url.split("/").at(-1));
    return response(JSON.stringify({ id, type: 4, name: "Original", images: { small: "https://lain.bgm.tv/" + id + ".jpg" } }));
  };
  const first = await fetchGalgameSnapshot({ ...options, enrichLimit: 1, fetchImpl });
  assert.equal(requests.filter((url) => url.startsWith(config.bangumi.apiBase)).length, 1);
  assert.ok(first.subjects[0].details_checked_at);
  requests.length = 0;
  const next = await fetchGalgameSnapshot({ ...options, enrichLimit: 1, fetchImpl, previous: first });
  assert.equal(requests.filter((url) => url.startsWith(config.bangumi.apiBase)).length, 1);
  assert.ok(requests.some((url) => url.endsWith("/subjects/2")));
  assert.ok(next.subjects.every((item) => item.images));
});

test("unavailable public details do not stop later covers, but an API outage is bounded", async () => {
  const subjects = [1, 2, 3, 4].map(id => ({ id, name: "Subject" }));
  const now = new Date("2026-10-04T12:00:00Z");
  const requested = [];
  await enrichMissingDetails(subjects, { ...options, now, enrichLimit: 4,
    fetchImpl: async (url) => {
      const id = Number(url.split("/").at(-1));
      requested.push(id);
      return id < 4 ? response("not public", 404) : response(JSON.stringify({
        id, type: 4, images: { small: "https://lain.bgm.tv/public.jpg" },
      }));
    },
  });
  assert.deepEqual(requested, [1, 2, 3, 4]);
  assert.equal(subjects[3].images.small, "https://lain.bgm.tv/public.jpg");
  assert.ok(subjects.every(s => s.details_checked_at === now.toISOString()));
  const outage = [1, 2, 3, 4].map(id => ({ id, name: "Subject" }));
  let calls = 0;
  await enrichMissingDetails(outage, { ...options, enrichLimit: 4, retries: 0,
    fetchImpl: async () => { calls++; return response("down", 503); },
  });
  assert.equal(calls, 3);
  assert.ok(outage.every(s => !s.details_checked_at));
});

test("empty output, a >15% count drop and broken score extraction fail validation", async () => {
  assert.throws(() => validateSnapshot(snapshot([])), /快照为空/);
  assert.throws(() => validateSnapshot(snapshot([{ id: 1, name: "ok" }]), {
    previous: snapshot([{ id: 1 }, { id: 2 }]),
  }), /降幅超过/);
  assert.throws(() => validateSnapshot(snapshot([{ id: 1, name: "ok", rating: { score: 0, total: 20 } }])), /评分普遍无效/);
  await assert.rejects(fetchGalgameSnapshot({ ...options,
    fetchImpl: async () => response(page(row(1, { score: "" }))) }), /网页评分解析异常/);
});

test("network retry is bounded and honors timeouts without retrying permanent 404s", async () => {
  let calls = 0;
  const result = await fetchTextWithRetry("https://example.test", { sleepImpl: noSleep,
    fetchImpl: async () => ++calls < 3 ? response("busy", 503) : response("ok") });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(fetchTextWithRetry("https://example.test", { sleepImpl: noSleep,
    fetchImpl: async () => { calls++; return response("missing", 404); } }), /404/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchTextWithRetry("https://example.test", { sleepImpl: noSleep, timeoutMs: 5, retries: 1,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      calls++; signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    }) }), /timeout/);
  assert.equal(calls, 2);
});

test("main honors configured filenames and a bad refresh preserves the old file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "galgame-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("galgame-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const configured = { ...config, galgame: { ...config.galgame, snapshotFile: "custom-gallery.json" },
    bangumi: { ...config.bangumi, snapshotFile: "custom-mine.json" } };
  await writeFile(path.join(root, "config.json"), JSON.stringify(configured));
  await writeFile(path.join(root, "custom-mine.json"), JSON.stringify({ collections: [{ subject_id: 1, subject_type: 4,
    subject: { images: { small: "https://lain.bgm.tv/configured.jpg" } } }] }));
  await main({ ...options, cwd: root, args: [], fetchImpl: async () => response(page(row(1))) });
  const target = path.join(root, "custom-gallery.json");
  const good = await readFile(target, "utf8");
  assert.equal(JSON.parse(good).subjects[0].images.small, "https://lain.bgm.tv/configured.jpg");
  await assert.rejects(main({ ...options, cwd: root, args: [], fetchImpl: async () => response("<h1>请登录</h1>") }), /不是预期/);
  assert.equal(await readFile(target, "utf8"), good);
  await writeSnapshotAtomic(target, JSON.parse(good));
  assert.ok((await readdir(root)).every((name) => !name.endsWith(".tmp")));
  assert.equal(new URL(tagPageUrl("Galgame", 1)).searchParams.get("sort"), "collects");
});
