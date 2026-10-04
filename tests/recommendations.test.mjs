import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recommendGames, titleKeys, validateRecommendationMetadata } from "../recommendations.js";

const game = (id, extra = {}) => ({ id, name: `Story ${id}`, date: "2024-01-01", rating: { score: 8, total: 100 }, ...extra });
const collection = (id, extra = {}) => ({ subject_id: id, subject_type: 4, subject: game(id), type: 2, rate: 9, ...extra });
const record = (id, extra = {}) => ({ work_id: id, tags: ["悬疑"], writers: [], developers: [],
  is_galgame: true, collection: false, prequels: [], parents: [], date: "2024-01-01", ...extra });
const meta = records => ({ schema_version: 1, count: Object.keys(records).length, subjects: records, persons: { 10: "Writer A", 11: "Writer B" } });
const ids = result => result.items.map(i => i.subject.id);

test("completed stories and alternative versions are excluded, sequels stay eligible", () => {
  const metadata = meta({ 1: record(1), 2: record(2, { work_id: 1 }), 3: record(3, { prequels: [1] }) });
  const result = recommendGames([game(1), game(2), game(3)], [collection(1)], metadata);
  assert.deepEqual(ids(result), [3]);
  assert.equal(result.stats.excludedVersions, 1);
  assert.equal(result.items[0].kind, "sequel");
  assert.match(result.items[0].reasons[0], /续集/);
});

test("playing a port also excludes the original, but does not exclude its sequel", () => {
  const metadata = meta({ 1: record(1), 2: record(2, { work_id: 1 }), 3: record(3, { prequels: [1] }) });
  assert.deepEqual(ids(recommendGames([game(1), game(3)], [collection(2)], metadata, { mode: "sequels" })), [3]);
});

test("title fallback strips edition markers without deleting sequel numbers or subtitles", () => {
  assert.deepEqual(titleKeys({ name: "Story ～ HD Remastered Edition" }), titleKeys({ name: "Story" }));
  const metadata = meta({ 1: record(1), 2: record(2), 3: record(3), 4: record(4) });
  const result = recommendGames([game(2, { name: "Game Full Voice Edition" }), game(3, { name: "Game 2" }),
    game(4, { name: "Game: After Story" })], [collection(1, { subject: game(1, { name: "Game" }) })], metadata);
  assert.deepEqual(new Set(ids(result)), new Set([3, 4]));
  assert.notDeepEqual(titleKeys({ name: "Game II" }), titleKeys({ name: "Game I" }));
});

test("wishes are eligible; playing, on-hold and dropped stories and their versions are blocked", () => {
  const metadata = meta(Object.fromEntries([1, 2, 3, 4, 5].map(id => [id, record(id)])));
  metadata.subjects[5].work_id = 2;
  const result = recommendGames([1, 2, 3, 4, 5].map(id => game(id)), [collection(1, { type: 1 }), collection(2, { type: 3 }),
    collection(3, { type: 4 }), collection(4, { type: 5 })], metadata);
  assert.deepEqual(ids(result), [1]);
  assert.match(result.items[0].reasons.join(" "), /想玩/);
});

test("unplayed versions appear once, hiding applies to the entire work", () => {
  const metadata = meta({ 1: record(1), 2: record(2, { work_id: 1 }), 3: record(3) });
  assert.equal(recommendGames([game(1), game(2), game(3)], [], metadata).items.length, 2);
  assert.deepEqual(ids(recommendGames([game(1), game(2), game(3)], [], metadata, { hiddenWorkIds: [1] })), [3]);
});

test("high personal writer ratings change ranking and provide a verifiable reason", () => {
  const metadata = meta({ 1: record(1, { writers: [10] }), 2: record(2, { writers: [10] }), 3: record(3, { writers: [11] }) });
  const subjects = [game(2, { rating: { score: 7.8, total: 100 } }), game(3, { rating: { score: 8, total: 100 } })];
  const personal = recommendGames(subjects, [collection(1, { rate: 10 })], metadata);
  assert.equal(personal.items[0].subject.id, 2);
  assert.match(personal.items[0].reasons[0], /Writer A.*Story 1.*10 分/);
  assert.equal(recommendGames(subjects, [collection(1, { rate: 10 })], metadata, { mode: "quality" }).items[0].subject.id, 3);
});

test("low personal ratings reduce preference; unrated history does not invent a favorite", () => {
  const metadata = meta({ 1: record(1, { writers: [10], tags: [] }), 2: record(2, { writers: [10], tags: [] }), 3: record(3, { tags: [] }) });
  assert.equal(recommendGames([game(2), game(3)], [collection(1, { rate: 2 })], metadata).items[0].subject.id, 3);
  const result = recommendGames([game(2)], [collection(1, { rate: 0 })], metadata);
  assert.equal(result.stats.favorites, 0);
  assert.match(result.items[0].reasons[0], /^Bangumi/);
});

test("sequels mode includes sequels and side stories, not unrelated shared staff", () => {
  const metadata = meta({ 1: record(1), 2: record(2, { prequels: [1] }), 3: record(3, { parents: [1] }), 4: record(4) });
  const result = recommendGames([game(2), game(3), game(4)], [collection(1)], metadata, { mode: "sequels" });
  assert.deepEqual(new Set(ids(result)), new Set([2, 3]));
  assert.equal(result.items.find(i => i.subject.id === 3).kind, "side_story");
});

test("future releases, unknown metadata, bundles, demos and insufficient ratings are excluded", () => {
  const metadata = meta({ 1: record(1), 2: record(2, { collection: true }), 3: record(3, { is_galgame: false }),
    4: record(4), 5: record(5), 6: record(6) });
  const result = recommendGames([game(1, { date: "2099-01-01" }), game(2), game(3), game(4, { name: "Game 体験版" }),
    game(5, { rating: { score: 10, total: 1 } }), game(6), game(7)], [], metadata, { today: "2026-10-05" });
  assert.deepEqual(ids(result), [6]);
});

test("replayed versions count once in the taste profile", () => {
  const metadata = meta({ 1: record(1), 2: record(2, { work_id: 1 }), 3: record(3) });
  const result = recommendGames([game(3)], [collection(1), collection(2)], metadata);
  assert.equal(result.stats.played, 1);
  assert.equal(result.stats.favorites, 1);
});

test("malformed relationship data cannot silently enable unsafe recommendations", () => {
  assert.throws(() => validateRecommendationMetadata({ subjects: {} }), /格式/);
  assert.throws(() => validateRecommendationMetadata(meta({ 1: record(1, { work_id: null }) })), /关系/);
  assert.throws(() => validateRecommendationMetadata(meta({ 1: record(1, { prequels: ["2"] }) })), /关系/);
});

test("official real metadata excludes Aokana's other version while allowing its followups", () => {
  const metadata = JSON.parse(readFileSync(new URL("../data/recommendation-metadata.json", import.meta.url)));
  assert.equal(metadata.subjects[540024].work_id, metadata.subjects[76912].work_id);
  const result = recommendGames([game(540024), game(175526)], [collection(76912)], metadata, { mode: "sequels" });
  assert.deepEqual(ids(result), [175526]);
});
