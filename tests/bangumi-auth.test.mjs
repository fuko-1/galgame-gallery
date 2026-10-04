import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authorizationHeaders, loadAccessToken, normalizeAccessToken, verifyAccessToken } from "../scripts/bangumi-auth.mjs";
import { enrichMissingDetails, fetchGalgameSnapshot, fetchTextWithRetry, main } from "../scripts/fetch-galgame.mjs";

const token = "test-token-not-a-real-credential";
const silent = { log() {}, warn() {} };
const noSleep = async () => {};
const body = (value, status = 200) => new Response(JSON.stringify(value), { status });
const config = { bangumi: { apiBase: "https://api.bgm.tv/v0" } };
const run = promisify(execFile);

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gallery-auth-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gallery-auth-test-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("authorization is confined to the official HTTPS API and cannot be redirected", async () => {
  let calls = 0;
  assert.deepEqual(authorizationHeaders("https://api.bgm.tv/v0/subjects/1", token), { Authorization: "Bearer " + token });
  for (const url of ["http://api.bgm.tv/v0/me", "https://api.bgm.tv.evil.test/v0/me", "https://bgm.tv/game/tag/Galgame", "https://api.bgm.tv/other", "https://user@api.bgm.tv/v0/me"]) {
    await assert.rejects(fetchTextWithRetry(url, { accessToken: token,
      fetchImpl: async () => { calls++; return body({}); } }), /只允许发送到/);
  }
  assert.equal(calls, 0);
  await fetchTextWithRetry("https://api.bgm.tv/v0/subjects/1", { accessToken: token,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer " + token);
      return body({});
    } });
});

test("empty authorization preserves public mode and malformed credentials are rejected without echoing them", () => {
  assert.deepEqual(authorizationHeaders("https://example.test", ""), {});
  assert.equal(normalizeAccessToken("  " + token + "\n"), token);
  for (const value of ["invalid token", "secret\r\nInjected: 1", "x".repeat(4097)]) {
    assert.throws(() => normalizeAccessToken(value), error => !error.message.includes(value) && /格式无效/.test(error.message));
  }
});

test("saved Windows authorization loads automatically; environment takes precedence", async () => {
  let decrypts = 0;
  assert.equal(await loadAccessToken({ env: { BANGUMI_ACCESS_TOKEN: token }, runImpl: async () => { decrypts++; } }), token);
  assert.equal(decrypts, 0);
  assert.equal(await loadAccessToken({ env: {}, platform: "linux" }), "");
  assert.equal(await loadAccessToken({ env: { LOCALAPPDATA: "outside-public-site" }, platform: "win32",
    accessImpl: async filename => assert.ok(filename.endsWith("bangumi-token.dpapi")),
    runImpl: async (_exe, args, options) => {
      decrypts++;
      assert.ok(args.includes("-NonInteractive"));
      assert.equal(options.windowsHide, true);
      return { stdout: token };
    } }), token);
  assert.equal(decrypts, 1);
  assert.equal(await loadAccessToken({ env: { LOCALAPPDATA: "missing" }, platform: "win32",
    accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } }), "");
});

test("failed decryption and authenticated network errors do not leak captured credentials", async () => {
  await assert.rejects(loadAccessToken({ env: { LOCALAPPDATA: "outside" }, platform: "win32",
    accessImpl: async () => {}, runImpl: async () => { throw new Error(token); } }),
  error => !String(error).includes(token) && /无法解密/.test(error.message));
  await assert.rejects(fetchTextWithRetry("https://api.bgm.tv/v0/me", { accessToken: token, retries: 0,
    fetchImpl: async () => { throw new Error(token); } }), error => !String(error).includes(token));
});

test("authorization verifies the intended account, handles expiry, and never returns private profile fields", async () => {
  const me = { id: 123, username: "koberi", email: "private@example.test" };
  const result = await verifyAccessToken(token, { username: "koberi", fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.bgm.tv/v0/me");
    assert.equal(options.redirect, "error");
    return body(me);
  } });
  assert.deepEqual(result, { id: 123, username: "koberi" });
  await assert.rejects(verifyAccessToken(token, { username: "koberi", fetchImpl: async () => body({ id: 1, username: "other" }) }), /账号.*不一致/);
  await assert.rejects(verifyAccessToken(token, { fetchImpl: async () => body({}, 401) }), /授权已失效/);
  await assert.rejects(verifyAccessToken(token, { fetchImpl: async () => body({}, 403) }), /拒绝/);
  await assert.rejects(verifyAccessToken(token, { fetchImpl: async () => body({}) }), /缺少有效账号/);
});

test("new authorization immediately retries anonymous 404s and prioritizes recommended covers", async () => {
  const now = new Date("2026-10-05T00:00:00Z");
  const subjects = [1, 2, 3].map(id => ({ id, name: "Game", details_checked_at: now.toISOString() }));
  const requests = [];
  await enrichMissingDetails(subjects, { config, now, accessToken: token, enrichLimit: 2,
    priorityIds: [3, 2], logger: silent, sleepImpl: noSleep,
    fetchImpl: async (url, options) => {
      const id = Number(url.split("/").at(-1));
      requests.push(id);
      assert.equal(options.headers.Authorization, "Bearer " + token);
      return body({ id, type: 4, images: { small: "https://lain.bgm.tv/" + id + ".jpg" } });
    } });
  assert.deepEqual(requests, [3, 2]);
  assert.equal(subjects[2].details_access, "authorized");
  assert.ok(!JSON.stringify(subjects).includes(token));
  await enrichMissingDetails([{ id: 4, name: "Still missing", details_access: "authorized", details_checked_at: now.toISOString() }], {
    config, now, accessToken: token, logger: silent, fetchImpl: async () => assert.fail("recent authorized miss should be cached"),
  });
});

test("expiry during enrichment fails immediately and is not cached as a missing cover", async () => {
  const subjects = [1, 2].map(id => ({ id, name: "Game" }));
  let calls = 0;
  await assert.rejects(enrichMissingDetails(subjects, { config, accessToken: token, logger: silent,
    fetchImpl: async () => { calls++; return body({}, 401); } }), /授权已失效/);
  assert.equal(calls, 1);
  assert.ok(subjects.every(subject => !subject.details_checked_at));
});

test("HTML tag crawling stays anonymous even when API enrichment is authorized", async () => {
  const html = '<h1>游戏标签: Galgame</h1><li id="item_1"><h3><a class="l" href="/subject/1">Game</a></h3></li>' +
    '<div class="page_inner"><strong class="p_cur">1</strong><span class="p_edge">(1 / 1)</span></div>';
  const result = await fetchGalgameSnapshot({ config, accessToken: token, logger: silent, sleepImpl: noSleep,
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://bgm.tv/")) {
        assert.equal(options.headers.Authorization, undefined);
        return new Response(html);
      }
      assert.equal(options.headers.Authorization, "Bearer " + token);
      return body({ id: 1, type: 4, images: { small: "https://lain.bgm.tv/cover.jpg" } });
    } });
  assert.equal(result.subjects[0].images.small, "https://lain.bgm.tv/cover.jpg");
});

test("Windows DPAPI actually decrypts the saved credential in a new process", { skip: process.platform !== "win32" }, async t => {
  const root = await temporaryRoot(t);
  const directory = path.join(root, "galgame-gallery");
  await mkdir(directory);
  // This is an invalid test credential; never touch the user's real store.
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$env:PSModulePath = Join-Path $PSHOME 'Modules'; ConvertFrom-SecureString (ConvertTo-SecureString 'test-token-not-a-real-credential' -AsPlainText -Force)"], { windowsHide: true });
  assert.ok(!stdout.includes(token));
  await writeFile(path.join(directory, "bangumi-token.dpapi"), stdout);
  assert.equal(await loadAccessToken({ env: { ...process.env, LOCALAPPDATA: root, BANGUMI_ACCESS_TOKEN: "" } }), token);
});

test("cover-only updates preserve the catalogue and expiry never overwrites its existing file", async t => {
  const root = await temporaryRoot(t);
  await writeFile(path.join(root, "config.json"), JSON.stringify({ ...config, bangumi: { ...config.bangumi, username: "koberi" },
    galgame: { snapshotFile: "gallery.json" } }));
  const original = { count: 1, updated_at: "2026-10-04T00:00:00Z", source: { type: "bangumi_user_tag" }, subjects: [{ id: 1, name: "Game", rating: { score: 8 } }] };
  const filename = path.join(root, "gallery.json");
  await writeFile(filename, JSON.stringify(original));
  const result = await main({ cwd: root, args: ["--enrich-only"], accessToken: token, logger: silent, sleepImpl: noSleep,
    fetchImpl: async url => url.endsWith("/me") ? body({ id: 123, username: "koberi" })
      : body({ id: 1, type: 4, images: { small: "https://lain.bgm.tv/cover.jpg" } }) });
  assert.equal(result.updated_at, original.updated_at);
  assert.deepEqual(result.source, original.source);
  assert.equal(result.count, 1);
  assert.equal(result.subjects[0].rating.score, 8);
  assert.ok(result.subjects[0].images.small);
  const saved = await readFile(filename, "utf8");
  assert.ok(!saved.includes(token));
  await assert.rejects(main({ cwd: root, args: ["--enrich-only"], accessToken: token,
    fetchImpl: async () => body({}, 401) }), /授权已失效/);
  assert.equal(await readFile(filename, "utf8"), saved);
});
