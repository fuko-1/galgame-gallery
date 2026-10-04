const score = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const title = subject => subject.name_cn || subject.name || "未知作品";
const editionPattern = /\b(?:(?:(?:hd\s+)?remaster(?:ed)?|hd|remake|full\s*voice(?:d)?|complete|definitive|enhanced|anniversary|memorial|integral)(?:\s+(?:edition|version))?|elite)\b|リマスター(?:版)?|リメイク(?:版)?|フルボイス(?:版)?|全年[龄齢](?:版)?|全[语語]音(?:版)?|重[制製](?:版)?|高清(?:版)?|移植(?:版)?|完整版|完全版|(?:PC|PS[1-5PV]?|PS\s*Vita|Switch|Windows|Steam|Android|iOS)\s*版/gi;
const genericTag = /^(?:galgame|gal|游戏|adv|avg|visualnovel|视觉小说|pc|windows|ps\d|psp|psv|switch|ns|steam|android|ios|r18|18禁|全年龄|汉化|神作|[\d.]+)$/i;
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/** Strip edition markers only; sequel numbers and story subtitles remain intact. */
export function titleKeys(subject) {
  return [...new Set([subject.name, subject.name_cn].filter(Boolean)
    .map(name => normalize(name.normalize("NFKC").replace(editionPattern, ""))).filter(key => key.length >= 3))];
}

export function validateRecommendationMetadata(metadata) {
  if (metadata?.schema_version !== 1 || !metadata.subjects || !metadata.persons ||
      metadata.count !== Object.keys(metadata.subjects).length || !metadata.count) {
    throw new Error("推荐元数据格式不正确");
  }
  for (const [id, record] of Object.entries(metadata.subjects)) {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(record.work_id) || record.work_id < 1 ||
        typeof record.is_galgame !== "boolean" || typeof record.collection !== "boolean" ||
        !Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== "string") ||
        ["writers", "developers", "prequels", "parents"].some(field =>
          !Array.isArray(record[field]) || record[field].some(value => !Number.isSafeInteger(value) || value < 1))) {
      throw new Error(`作品 ${id} 的推荐关系不正确`);
    }
  }
  return metadata;
}

function features(record) {
  return [
    ...(record?.writers || []).map(id => `writer:${id}`),
    ...(record?.developers || []).map(id => `developer:${id}`),
    ...(record?.tags || []).filter(tag => !genericTag.test(normalize(tag))).map(tag => `tag:${normalize(tag)}`),
  ];
}

/** Pure local ranking: no browser requests, account writes, or remote AI service. */
export function recommendGames(subjects, collections, metadata, {
  mode = "personal", hiddenWorkIds = [], today = new Date().toISOString().slice(0, 10),
} = {}) {
  const records = metadata.subjects;
  const gameCollections = collections.filter(c => Number(c.subject_type ?? c.subject?.type) === 4);
  const unavailable = gameCollections.filter(c => [2, 3, 4, 5].includes(Number(c.type)));
  const done = gameCollections.filter(c => Number(c.type) === 2);
  const workId = subject => records[subject.id]?.work_id || subject.id;
  const blockedIds = new Set(unavailable.map(c => Number(c.subject_id ?? c.subject.id)));
  const blockedWorks = new Set(unavailable.map(c => workId(c.subject)));
  const blockedTitles = new Set(unavailable.flatMap(c => titleKeys(c.subject)));
  const hidden = new Set(hiddenWorkIds.map(Number));
  const wishes = new Set(gameCollections.filter(c => Number(c.type) === 1).map(c => workId(c.subject)));
  const playedWorks = new Map();
  for (const c of done) {
    const key = workId(c.subject);
    if (!playedWorks.has(key) || score(c.rate) > score(playedWorks.get(key).rate)) playedWorks.set(key, c);
  }
  // Replaying another version must not count as another independent preference.
  const profile = new Map();
  for (const c of playedWorks.values()) {
    if (!score(c.rate)) continue;
    for (const feature of new Set(features(records[c.subject.id]))) {
      const entry = profile.get(feature) || { sum: 0, count: 0, favorite: null };
      entry.sum += score(c.rate) - 7;
      entry.count++;
      if (score(c.rate) >= 8 && (!entry.favorite || score(c.rate) > score(entry.favorite.rate))) entry.favorite = c;
      profile.set(feature, entry);
    }
  }
  const frequency = new Map();
  for (const record of Object.values(records)) {
    for (const feature of new Set(features(record))) frequency.set(feature, (frequency.get(feature) || 0) + 1);
  }
  const preference = (record, prefix, cap) => Math.max(-cap, Math.min(cap,
    features(record).filter(f => f.startsWith(prefix)).reduce((sum, f) => {
      const p = profile.get(f);
      if (!p) return sum;
      const rarity = Math.min(3, Math.log(1 + metadata.count / (frequency.get(f) || 1)));
      return sum + p.sum / (p.count + 2) * rarity * 0.18;
    }, 0)));
  const candidates = new Map();
  let excludedVersions = 0;
  for (const subject of subjects) {
    const record = records[subject.id];
    if (!record || !record.is_galgame || record.collection || hidden.has(record.work_id)) continue;
    if (blockedIds.has(subject.id)) continue;
    if (blockedWorks.has(record.work_id) || titleKeys(subject).some(key => blockedTitles.has(key))) {
      excludedVersions++;
      continue;
    }
    if (/体験版|体验版|試玩版|试玩版|\bdemo\b/i.test(subject.name)) continue;
    const released = subject.date || record.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(released || "") || released > today) continue;
    const votes = score(subject.rating?.total), rating = score(subject.rating?.score);
    if (votes < 20 || rating < 6 || rating > 10) continue;
    const sequel = record.prequels.map(id => playedWorks.get(id)).filter(Boolean)
      .sort((a, b) => score(b.rate) - score(a.rate))[0];
    const parent = !sequel && record.parents.map(id => playedWorks.get(id)).filter(Boolean)
      .sort((a, b) => score(b.rate) - score(a.rate))[0];
    if (mode === "sequels" && !sequel && !parent) continue;
    const reasons = [];
    if (sequel || parent) {
      const previous = sequel || parent;
      reasons.push(`你已玩《${title(previous.subject)}》${score(previous.rate) ? `（${previous.rate} 分）` : ""}的${sequel ? "续集" : "外传 / 后续故事"}`);
    }
    if (mode !== "quality") {
      const matches = features(record).filter(f => profile.get(f)?.favorite)
        .sort((a, b) => {
          const weight = f => (f.startsWith("writer:") ? 3 : f.startsWith("developer:") ? 2 : 1)
            + profile.get(f).sum / (profile.get(f).count + 2);
          return weight(b) - weight(a);
        });
      const feature = matches[0];
      if (feature) {
        const favorite = profile.get(feature).favorite;
        const [kind, id] = feature.split(":");
        const label = kind === "writer" ? `同一剧本作者：${metadata.persons[id] || "未知"}`
          : kind === "developer" ? `同一开发商：${metadata.persons[id] || "未知"}`
          : `共同题材：${record.tags.find(t => normalize(t) === id) || id}`;
        reasons.push(`${label}；你给《${title(favorite.subject)}》${favorite.rate} 分`);
      }
    }
    if (wishes.has(record.work_id)) reasons.push("已经在你的想玩清单中");
    if (!reasons.length) reasons.push(`Bangumi ${rating.toFixed(1)} 分，${votes} 人评分`);
    const quality = (rating * votes + 7 * 80) / (votes + 80);
    const affinity = preference(record, "writer:", 1.1) + preference(record, "developer:", 0.7) + preference(record, "tag:", 0.7);
    const followup = sequel || parent;
    const followupBonus = followup ? (score(followup.rate) >= 8 ? 1.2 : score(followup.rate) >= 6 ? 0.5 : -0.7) : 0;
    const ranking = quality + (mode === "quality" ? 0 : affinity + followupBonus + (wishes.has(record.work_id) ? 0.3 : 0));
    const item = { subject, workId: record.work_id, reasons: reasons.slice(0, 2),
      kind: sequel ? "sequel" : parent ? "side_story" : "discovery", ranking };
    const previous = candidates.get(record.work_id);
    if (!previous || ranking > previous.ranking || (ranking === previous.ranking && subject.id < previous.subject.id)) candidates.set(record.work_id, item);
  }
  const ranked = [...candidates.values()].sort((a, b) => b.ranking - a.ranking || a.subject.id - b.subject.id);
  // Keep the first batch varied without losing any eligible result.
  const items = [], deferred = [], developerCounts = new Map();
  for (const item of ranked) {
    const developers = records[item.subject.id].developers;
    if (mode !== "sequels" && developers.length && developers.every(id => (developerCounts.get(id) || 0) >= 2)) {
      deferred.push(item);
      continue;
    }
    items.push(item);
    developers.forEach(id => developerCounts.set(id, (developerCounts.get(id) || 0) + 1));
  }
  return { items: [...items, ...deferred], stats: { played: playedWorks.size, excludedVersions,
    candidates: candidates.size, favorites: [...playedWorks.values()].filter(c => score(c.rate) >= 8).length } };
}
