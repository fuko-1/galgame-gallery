import test from "node:test";
import assert from "node:assert/strict";
import { validateData } from "../scripts/validate-data.mjs";

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
