import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.textContent = "";
    this.options = [];
    const classes = new Set();
    this.classList = {
      contains: name => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    };
  }
  set innerHTML(value) { this.markup = value; this.children = []; this.image = null; }
  get innerHTML() { return this.markup || ""; }
  appendChild(child) { this.children.push(...(child.fragment ? child.children : [child])); }
  after(sibling) { this.nextSibling = sibling; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }
  dispatch(name, target = this) { this.listeners.get(name)?.forEach(callback => callback({ target })); }
  querySelector(selector) {
    if (selector !== ".card-cover img" || !this.innerHTML.includes("<img ")) return null;
    return this.image ||= new Element();
  }
  remove() { this.removed = true; }
}

const configuration = {
  bangumi: { username: "another-user", nickname: "测试用户", profileUrl: "https://bgm.tv/user/another-user", snapshotFile: "custom/mine.json" },
  twodfan: { profileUrl: "https://2dfan.com/users/123", searchUrlTemplate: "https://2dfan.com/subjects/search?keyword={title}&from=gallery" },
  galgame: { tag: "Galgame", snapshotFile: "custom/games.json" },
};

function start() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  for (const match of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    elements.get(match[1]).options = [...match[2].matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)]
      .map(option => ({ value: option[1], textContent: option[2] }));
  }
  const tabs = ["mine", "unplayed"].map(name => {
    const element = elements.get(`tab-${name}`);
    element.dataset.tab = name;
    return element;
  });
  const pending = new Map();
  const timeoutControllers = new WeakMap();
  const requested = [];
  const document = {
    baseURI: "https://example.test/gallery/index.html",
    getElementById: id => elements.get(id),
    querySelectorAll: selector => selector === ".tab" ? tabs : [],
    createElement: () => new Element(),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
  };
  const context = vm.createContext({
    document, URL, console, window: { scrollTo() {} },
    AbortSignal: {
      timeout(milliseconds) {
        assert.equal(milliseconds, 20_000);
        const controller = new AbortController();
        timeoutControllers.set(controller.signal, controller);
        return controller.signal;
      },
    },
    fetch: (url, { signal }) => {
      requested.push(url);
      return new Promise((resolve, reject) => {
        pending.set(url, { resolve, reject, signal });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  vm.runInContext(source, context, { filename: "app.js" });
  return {
    document, requested, elements,
    node: id => elements.get(id),
    tab(name) { elements.get(`tab-${name}`).dispatch("click"); },
    change(id, value) {
      const element = elements.get(id);
      element.value = value;
      element.dispatch(id === "search-box" ? "input" : "change");
    },
    cards(name) { return elements.get(`grid-${name}`).children; },
    pager(name) { return elements.get(`grid-${name}`).nextSibling; },
    page(name, action) {
      const pager = this.pager(name);
      const button = pager.innerHTML.match(new RegExp(`<button[^>]*data-act="${action}"([^>]*)>`));
      assert.ok(button, `The ${action} button must exist`);
      pager.dispatch("click", { closest: () => ({ disabled: button[1].includes("disabled"), dataset: { act: action } }) });
    },
    size(name, value) { this.pager(name).dispatch("change", { value: String(value), classList: { contains: name => name === "pg-select" } }); },
    async reply(url, payload, status = 200) {
      assert.ok(pending.has(url), `Expected request for ${url}`);
      pending.get(url).resolve({ ok: status >= 200 && status < 300, status, json: async () => payload });
      pending.delete(url);
      await flush();
    },
    async fail(url) { pending.get(url).reject(new Error("network unavailable")); pending.delete(url); await flush(); },
    async timeout(url) {
      timeoutControllers.get(pending.get(url).signal).abort(new DOMException("Timeout", "TimeoutError"));
      pending.delete(url);
      await flush();
    },
    evaluate: code => vm.runInContext(code, context),
  };
}

function subject(id, extra = {}) {
  return { id, name: `游戏 ${id}`, type: 4, date: "2025-01-01", ...extra };
}
function collection(id, extra = {}) {
  return { subject: subject(id), type: 2, rate: 8, updated_at: "2026-01-01", ...extra };
}
async function loaded(mine = [collection(1)], gal = [subject(2)]) {
  const app = start();
  await app.reply("config.json", configuration);
  await app.reply("custom/mine.json", { collections: mine, updated_at: "2026-10-01" });
  await app.reply("custom/games.json", { subjects: gal, updated_at: "2026-10-02" });
  return app;
}

test("configuration controls the title, links and both snapshot paths", async () => {
  const app = await loaded();
  assert.deepEqual(app.requested, ["config.json", "custom/mine.json", "custom/games.json"]);
  assert.equal(app.document.title, "测试用户 的 Galgame 收藏");
  assert.equal(app.node("link-bangumi").href, configuration.bangumi.profileUrl);
  assert.equal(app.node("link-2dfan").href, configuration.twodfan.profileUrl);
  assert.match(app.cards("mine")[0].innerHTML, /from=gallery/);
  assert.match(app.cards("mine")[0].innerHTML, /玩过/);
});

test("personal cards render while the catalogue is pending and survive its failure", async () => {
  const app = start();
  await app.reply("config.json", configuration);
  await app.reply("custom/mine.json", { collections: [collection(1)] });
  assert.equal(app.cards("mine").length, 1);
  assert.equal(app.node("status-msg").classList.contains("hidden"), true);
  await app.fail("custom/games.json");
  assert.equal(app.cards("mine").length, 1);
  assert.equal(app.node("status-msg").classList.contains("hidden"), true);
  app.tab("unplayed");
  assert.match(app.node("status-msg").textContent, /Galgame 清单加载失败/);
  app.change("filter-type", "3");
  assert.match(app.node("status-msg").textContent, /Galgame 清单加载失败/);
  app.tab("mine");
  assert.equal(app.cards("mine").length, 1);
});

test("a failed personal snapshot never labels the entire catalogue uncollected", async () => {
  const app = start();
  await app.reply("config.json", configuration);
  app.tab("unplayed");
  await app.reply("custom/games.json", { subjects: [subject(1), subject(2)] });
  await app.fail("custom/mine.json");
  assert.equal(app.cards("unplayed").length, 0);
  assert.match(app.node("status-msg").textContent, /无法排除已收藏/);
  app.change("search-box", "游戏");
  assert.match(app.node("status-msg").textContent, /无法排除已收藏/);
});

test("switching tabs before config or snapshots finish renders the selected tab", async () => {
  const app = start();
  app.tab("unplayed");
  await app.reply("config.json", configuration);
  await app.reply("custom/games.json", { subjects: [subject(1), subject(2)] });
  assert.match(app.node("status-msg").textContent, /加载个人收藏/);
  await app.reply("custom/mine.json", { collections: [collection(1)] });
  assert.equal(app.cards("unplayed").length, 1);
  assert.match(app.cards("unplayed")[0].innerHTML, /游戏 2/);
  assert.equal(app.node("status-msg").classList.contains("hidden"), true);
  assert.equal(app.node("grid-unplayed").classList.contains("hidden"), false);
});

test("tabs preserve their own filters, query, sort, page and page size", async () => {
  const mine = Array.from({ length: 130 }, (_, index) => collection(index + 1));
  const gal = Array.from({ length: 280 }, (_, index) => subject(index + 1000));
  const app = await loaded(mine, gal);
  app.change("search-box", "游戏");
  app.change("filter-status", "all");
  app.change("sort-by", "date");
  app.size("mine", 100);
  app.page("mine", "next");
  assert.equal(app.cards("mine").length, 30);
  app.tab("unplayed");
  assert.equal(app.node("search-box").value, "");
  assert.equal(app.node("sort-by").value, "rate");
  assert.equal(app.node("tool-status-wrap").hidden, true);
  assert.equal(app.node("tool-type-wrap").hidden, true);
  assert.equal(app.node("sort-by").options.find(option => option.value === "date").textContent, "发售日期");
  app.page("unplayed", "next");
  app.page("unplayed", "next");
  app.tab("mine");
  assert.equal(app.node("search-box").value, "游戏");
  assert.equal(app.node("sort-by").value, "date");
  assert.equal(app.node("filter-status").value, "all");
  assert.match(app.pager("mine").innerHTML, /第 2 \/ 2 页/);
  app.size("mine", 50);
  app.tab("unplayed");
  assert.match(app.pager("unplayed").innerHTML, /第 3 \/ 6 页/);
  app.page("unplayed", "prev");
  assert.match(app.pager("unplayed").innerHTML, /第 2 \/ 6 页/);
  app.change("search-box", "游戏 1000");
  assert.match(app.pager("unplayed").innerHTML, /第 1 \/ 1 页/);
});

test("out-of-range pages are persisted after clamping so previous navigates immediately", async () => {
  const app = await loaded([], Array.from({ length: 120 }, (_, index) => subject(index + 1)));
  app.tab("unplayed");
  app.evaluate("state.views.unplayed.page = 200; renderActive();");
  assert.match(app.pager("unplayed").innerHTML, /第 3 \/ 3 页/);
  app.page("unplayed", "prev");
  assert.match(app.pager("unplayed").innerHTML, /第 2 \/ 3 页/);
});

test("personal searches include comments and original titles, with status and type filtering", async () => {
  const app = await loaded([
    collection(1, { comment: "特别喜欢的路线", rate: 7 }),
    collection(2, { subject: subject(2, { name: "Original TITLE", name_cn: "中文标题" }), rate: 9 }),
    collection(3, { type: 1, rate: 10 }),
    collection(4, { subject: subject(4, { type: 2 }), rate: 10 }),
  ]);
  assert.equal(app.cards("mine").length, 2);
  assert.match(app.cards("mine")[0].innerHTML, /中文标题/);
  app.change("search-box", " 喜欢 ");
  assert.equal(app.cards("mine").length, 1);
  app.change("search-box", "original title");
  assert.equal(app.cards("mine").length, 1);
  assert.match(app.cards("mine")[0].innerHTML, /中文标题/);
  app.change("search-box", "");
  app.change("filter-status", "1");
  assert.match(app.cards("mine")[0].innerHTML, /想玩/);
  app.change("filter-type", "2");
  assert.equal(app.node("filter-status").options.find(option => option.value === "1").textContent, "想看");
});

test("uncollected excludes every collection status and sorts numeric scores before vote counts", async () => {
  const mine = [1, 2, 3, 4, 5].map(type => collection(type, { type }));
  const app = await loaded(mine, [
    ...[1, 2, 3, 4, 5].map(id => subject(String(id))),
    subject(6, { rating: { score: 7.5, total: 1000 }, date: "2026-01-01" }),
    subject(7, { rating: { score: "9.1", total: 10 }, date: "2020-01-01" }),
    subject(8),
  ]);
  app.tab("unplayed");
  assert.equal(app.cards("unplayed").length, 3);
  assert.match(app.cards("unplayed")[0].innerHTML, /游戏 7/);
  assert.match(app.cards("unplayed")[0].innerHTML, /9\.1/);
  app.change("sort-by", "date");
  assert.match(app.cards("unplayed")[0].innerHTML, /游戏 6/);
  assert.match(app.node("unplayed-note").textContent, /全部收藏状态/);
});

test("missing and failed covers share a placeholder, unsafe URLs cannot create attributes", async () => {
  const app = await loaded([], [
    subject(1, { name: '<img src=x onerror="evil()">', images: { common: 'https://example.test/cover.jpg?q="&other=1', large: "https://example.test/full.jpg" } }),
    subject(2, { images: { large: "javascript:evil()" } }),
    subject(3),
  ]);
  app.tab("unplayed");
  const cards = app.cards("unplayed");
  assert.equal(cards.length, 3);
  assert.ok(cards.every(card => card.innerHTML.includes("暂无封面")));
  assert.match(cards[0].innerHTML, /cover\.jpg/);
  assert.doesNotMatch(cards[0].innerHTML, /full\.jpg/);
  assert.match(cards[0].innerHTML, /&amp;other=1/);
  assert.match(cards[0].innerHTML, /&lt;img/);
  assert.doesNotMatch(cards[1].innerHTML, /javascript:/);
  assert.equal(cards[1].querySelector(".card-cover img"), null);
  const image = cards[0].querySelector(".card-cover img");
  image.dispatch("error");
  assert.equal(image.removed, true);
  assert.match(cards[0].innerHTML, /cover-placeholder/);
});

test("configuration failure stays visible through tab and control changes", async () => {
  const app = start();
  await app.reply("config.json", {}, 404);
  assert.match(app.node("status-msg").textContent, /配置加载失败/);
  app.tab("unplayed");
  app.change("search-box", "test");
  assert.match(app.node("status-msg").textContent, /配置加载失败/);
  assert.deepEqual(app.requested, ["config.json"]);
});

test("unknown or invalid vote counts are omitted while a known zero is preserved", async () => {
  const totals = [undefined, null, -1, 1.5, Infinity, 0, 23];
  const app = await loaded([], totals.map((total, index) => subject(index + 1, { rating: { score: 8, total } })));
  app.tab("unplayed");
  for (const [index, total] of totals.entries()) {
    const card = app.cards("unplayed").find(card => card.innerHTML.includes(`游戏 ${index + 1}</a>`));
    assert.match(card.innerHTML, /8\.0/);
    if (Number.isInteger(total) && total >= 0) assert.ok(card.innerHTML.includes(`(${total}人)`));
    else assert.doesNotMatch(card.innerHTML, /\([^<]*人\)/);
  }
});

test("a timed-out catalogue reports an error without hiding personal cards", async () => {
  const app = start();
  await app.reply("config.json", configuration);
  await app.reply("custom/mine.json", { collections: [collection(1)] });
  await app.timeout("custom/games.json");
  assert.equal(app.cards("mine").length, 1);
  assert.equal(app.node("status-msg").classList.contains("hidden"), true);
  app.tab("unplayed");
  assert.match(app.node("status-msg").textContent, /超时（20 秒）/);
  assert.equal(app.cards("unplayed").length, 0);
});
