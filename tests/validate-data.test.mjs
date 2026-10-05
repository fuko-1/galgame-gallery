import test from "node:test";
import assert from "node:assert/strict";
import { validateClassification, validateData } from "../scripts/validate-data.mjs";

function samples() {
  return {
    gal: { count: 100, updated_at: "2026-10-04T12:00:00Z", subjects: Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, name: `作品 ${i + 1}`, rating: { score: 7.5, total: 20 },
    })) },
    mine: { count: 1, updated_at: "2026-10-04T12:00:00Z", collections: [
      { subject: { id: 1, type: 4 }, type: 2, rate: 8 },
    ] },
  };
}

test("valid snapshots preserve public/individual score distinction and compute the difference", () => {
  const { gal, mine } = samples();
  assert.deepEqual(validateData(gal, mine), { subjects: 100, collections: 1, publicScores: 100, covers: 0, uncollected: 99 });
});
test("the observed all-zero score regression cannot be published", () => {
  const { gal, mine } = samples();
  gal.subjects.forEach(s => { s.rating.score = 0; });
  assert.throws(() => validateData(gal, mine), /有效分数/);
});
test("API details may provide a real score without a public vote count", () => {
  const { gal, mine } = samples();
  delete gal.subjects[0].rating.total;
  assert.equal(validateData(gal, mine).publicScores, 99);
});
test("the observed double-domain cover URL cannot be published", () => {
  const { gal, mine } = samples();
  gal.subjects[0].images = { small: "https://bgm.tv//lain.bgm.tv/pic/cover/l/test.jpg" };
  assert.throws(() => validateData(gal, mine), /两个域名/);
});
test("empty or duplicate snapshots cannot pass publication checks", () => {
  const { gal, mine } = samples();
  gal.subjects[1].id = 1;
  assert.throws(() => validateData(gal, mine), /重复/);
  assert.throws(() => validateData({ ...gal, count: 0, subjects: [] }, mine), /不得为空/);
});

test("publication rejects stale, missing or inconsistent type classification", () => {
  const metadata = { classification_version: 1, source: { digest: "fixture" }, subjects: { 1: { is_galgame: true }, 2: { is_galgame: false } } };
  const stamp = { version: 1, source_digest: "fixture" };
  const gal = { count: 3, subjects: [{ id: 1, is_galgame: true }, { id: 2, is_galgame: false }, { id: 3, is_galgame: false }], galgame_classification: { ...stamp, accepted_count: 1 } };
  const mine = { collections: [{ subject_type: 4, subject: { id: 2, is_galgame: false } }], galgame_classification: stamp };
  assert.deepEqual(validateClassification(gal, mine, metadata), { galgames: 1, filtered: 2 });
  assert.throws(() => validateClassification({ ...gal, galgame_classification: undefined }, mine, metadata), /尚未完成/);
  assert.throws(() => validateClassification({ ...gal, subjects: [{ id: 2, is_galgame: true }] }, mine, metadata), /不一致/);
  assert.throws(() => validateClassification(gal, { ...mine, collections: [{ subject_type: 4, subject: { id: 2 } }] }, metadata), /不一致/);
  assert.throws(() => validateClassification(gal, mine, { ...metadata, source: { digest: "other" } }), /来源不一致/);
});
