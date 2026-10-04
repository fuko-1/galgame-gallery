import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchCollections, updateMySnapshot } from "../scripts/fetch-mine.mjs";

const config = { username: "test user", apiBase: "https://api.bgm.tv/v0", snapshotFile: "mine.json" };
const settings = { sleepImpl: async () => {}, requestDelayMs: 0, timeoutMs: 1000, retries: 0, pageSize: 2 };
const collection = (id, subjectType = 4, status = 2) => ({
  subject_id: id, subject_type: subjectType, type: status, rate: 8,
  updated_at: "2026-10-01T00:00:00Z", comment: null, tags: [], private: false,
  subject: { id, type: subjectType, name: `Game ${id}`, name_cn: "", images: {}, score: 7.5 },
});
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function apiMock(items, change = (body) => body) {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requests.push(url);
    const subjectType = Number(url.searchParams.get("subject_type"));
    const status = Number(url.searchParams.get("type"));
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const matching = items.filter((item) => item.subject_type === subjectType && item.type === status);
    return response(change({ total: matching.length, limit, offset, data: matching.slice(offset, offset + limit) }, url));
  };
  return { fetchImpl, requests };
}
async function fixture(t, items) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "galgame-mine-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const snapshotPath = path.join(directory, "mine.json");
  const original = JSON.stringify({ updated_at: "2026-09-30T00:00:00Z", count: items.length, collections: items });
  await writeFile(configPath, JSON.stringify({ bangumi: config }));
  await writeFile(snapshotPath, original);
  return { directory, configPath, snapshotPath, original };
}

test("collects all pages and accepts genuinely empty type/status combinations", async () => {
  const items = [1, 2, 3, 4, 5].map((id) => collection(id));
  items.push(collection(6, 2, 1));
  const mock = apiMock(items);
  const result = await fetchCollections(config, { ...settings, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result.map((item) => item.subject_id).sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(mock.requests.length, 27);
  assert.ok(mock.requests.every((url) => url.pathname === "/v0/users/test%20user/collections"));
  assert.deepEqual(mock.requests.filter((url) => url.searchParams.get("subject_type") === "4"
    && url.searchParams.get("type") === "2").map((url) => url.searchParams.get("offset")), ["0", "2", "4"]);
});

test("retries transient errors finitely and does not retry a 404", async () => {
  const mock = apiMock([]);
  let attempts = 0;
  await fetchCollections(config, { ...settings, retries: 2, fetchImpl: (...args) => {
    attempts++;
    return attempts <= 2 ? response({}, 503) : mock.fetchImpl(...args);
  } });
  assert.equal(attempts, 27);
  attempts = 0;
  await assert.rejects(fetchCollections(config, { ...settings, retries: 2, fetchImpl: async () => {
    attempts++; return response({}, 503);
  } }), /HTTP 503/);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(fetchCollections(config, { ...settings, retries: 2, fetchImpl: async () => {
    attempts++; return response({}, 404);
  } }), /HTTP 404/);
  assert.equal(attempts, 1);
});

test("aborts an unresponsive request within its timeout", async () => {
  let aborted = false;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("request aborted")); }, { once: true });
  });
  await assert.rejects(fetchCollections(config, { ...settings, timeoutMs: 10, fetchImpl }), /aborted/);
  assert.equal(aborted, true);
});

test("rejects incomplete pages, changing totals, repeated IDs, and malformed fields", async (t) => {
  const items = [collection(1), collection(2), collection(3)];
  const cases = [
    ["missing data", (body) => ({ ...body, data: undefined }), /结构无效/],
    ["wrong offset", (body) => ({ ...body, offset: body.offset + 1 }), /结构无效/],
    ["unexpected empty", (body) => body.total ? { ...body, data: [] } : body, /分页不完整/],
    ["changing total", (body) => body.offset ? { ...body, total: body.total + 1 } : body, /total 改变/],
    ["duplicate IDs", (body) => body.offset ? { ...body, data: [collection(1)] } : body, /重复/],
    ["invalid subject", (body) => body.data.length ? { ...body, data: body.data.map((item) => ({ ...item, subject: null })) } : body, /subject 结构无效/],
  ];
  for (const [name, change, error] of cases) {
    await t.test(name, async () => {
      await assert.rejects(fetchCollections(config, { ...settings, fetchImpl: apiMock(items, change).fetchImpl }), error);
    });
  }
});

test("throws at a configured page safety limit instead of returning truncated data", async () => {
  await assert.rejects(fetchCollections(config, { ...settings, maxPages: 1,
    fetchImpl: apiMock([collection(1), collection(2), collection(3)]).fetchImpl }), /拒绝截断/);
});

test("fetches collections beyond the former 5100-entry cutoff", async () => {
  const items = Array.from({ length: 5102 }, (_, index) => collection(index + 1));
  const mock = apiMock(items);
  const result = await fetchCollections(config, { ...settings, pageSize: 100, fetchImpl: mock.fetchImpl });
  assert.equal(result.length, 5102);
  assert.equal(result.at(-1).subject_id, 5102);
  assert.ok(mock.requests.some((url) => url.searchParams.get("offset") === "5100"));
});

test("writes a complete snapshot to the configured destination and leaves no temporary files", async (t) => {
  const old = [collection(1)];
  const saved = await fixture(t, old);
  const items = [...old, collection(2)];
  const payload = await updateMySnapshot({ ...settings, configPath: saved.configPath,
    now: () => new Date("2026-10-04T00:00:00Z"), fetchImpl: apiMock(items).fetchImpl });
  assert.equal(payload.count, 2);
  assert.deepEqual(JSON.parse(await readFile(saved.snapshotPath, "utf8")), payload);
  assert.equal(payload.updated_at, "2026-10-04T00:00:00.000Z");
  assert.deepEqual((await readdir(saved.directory)).sort(), ["config.json", "mine.json"]);
});

test("preserves the existing file after API or validation failures", async (t) => {
  for (const failure of ["HTTP", "partial page", "duplicate", "bad JSON"]) {
    await t.test(failure, async (t) => {
      const items = [collection(1), collection(2), collection(3)];
      const saved = await fixture(t, items);
      let fetchImpl;
      if (failure === "HTTP") fetchImpl = async () => response({}, 503);
      if (failure === "partial page") fetchImpl = apiMock(items, (body) => body.total ? { ...body, data: [] } : body).fetchImpl;
      if (failure === "duplicate") fetchImpl = apiMock(items, (body) => body.offset ? { ...body, data: [collection(1)] } : body).fetchImpl;
      if (failure === "bad JSON") fetchImpl = async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } });
      await assert.rejects(updateMySnapshot({ ...settings, configPath: saved.configPath, fetchImpl }));
      assert.equal(await readFile(saved.snapshotPath, "utf8"), saved.original);
      assert.deepEqual((await readdir(saved.directory)).sort(), ["config.json", "mine.json"]);
    });
  }
});

test("rejects an overall drop above 15% including an empty result, while allowing exactly 15%", async (t) => {
  const old = Array.from({ length: 20 }, (_, index) => collection(index + 1));
  const saved = await fixture(t, old);
  for (const count of [0, 16]) {
    await assert.rejects(updateMySnapshot({ ...settings, configPath: saved.configPath,
      fetchImpl: apiMock(old.slice(0, count)).fetchImpl }), /下降超过 15%/);
    assert.equal(await readFile(saved.snapshotPath, "utf8"), saved.original);
  }
  const payload = await updateMySnapshot({ ...settings, configPath: saved.configPath,
    fetchImpl: apiMock(old.slice(0, 17)).fetchImpl });
  assert.equal(payload.count, 17);
});
