// When I Was: offline feed ranker for the static export (ES module, no dependencies).
// Mirrors research/queries/feed.sql. Inputs: core.json, one shard (shards/<year>/<band>.json), optional places.json.
//   import { bandFor, shardPath, rankFeed } from './rank.js'
//   const year = birthYear + age, band = bandFor(core, age)
//   const shard = await (await fetch(`/data/${shardPath(year, band)}`)).json()
//   const cards = rankFeed({ core, shard, places, age, gender: 'girl', placeId: 'us-p-1743536', faith: true })
export const bandFor = (core, age) => (core.bands.find(([, lo, hi]) => age >= lo && age <= hi) || core.bands.at(-1))[0];
export const shardPath = (year, band, tier = 'top') => `shards/${year}/${band}${tier === 'more' ? '.more' : ''}.json`;

// Deep scroll: fetch shardPath(year, band, 'more') and merge it into the top shard, then re-run rankFeed with a larger
// limit. The 'more' tier is self-contained (its own items list); merging remaps its item indexes.
export function mergeShards(top, more) {
  if (!more) return top;
  const items = top.items.slice(), index = new Map(items.map((it, i) => [it[0], i]));
  const remap = more.items.map((it) => { if (!index.has(it[0])) { index.set(it[0], items.length); items.push(it); } return index.get(it[0]); });
  return { ...top, tier: 'all', items, windows: top.windows.concat(more.windows.map((w) => [remap[w[0]], ...w.slice(1)])), media: top.media };
}

// place_id -> geo weight for the person's place and all its ancestors (city -> county -> state -> region -> nation)
export function geoChain(core, places, placeId) {
  const chain = new Map([[null, 1.0]]);           // null = national ('us') windows
  if (!places || !placeId) return chain;
  let i = places.id.indexOf(placeId);
  while (i >= 0) {
    const t = places.type[i];
    if (places.id[i] !== 'us') chain.set(places.id[i], core.geo_weight[t] ?? 1.0);
    i = places.parent[i];
  }
  return chain;
}

export function virtueScore(core, item, W) {
  let p = 1;
  for (const [v, s] of item[8]) p *= 1 - Math.min(0.95, W.virtue_combine_scale * (core.virtues[v]?.weight ?? 1) * s);
  return item[8].length ? 1 - p : 0;
}

const r1 = (x) => Math.round(x * 10) / 10;

export function rankFeed({ core, shard, places = null, age, gender = '', placeId = null, faith = false,
                           hasKids = false, familyOnly = false, sportsFan = false, limit = 60, weights = {} }) {
  const W = { ...core.weights, ...weights };
  const gi = Math.max(0, core.genders.indexOf(gender || ''));
  const geo = geoChain(core, places, placeId);
  const best = new Map();                           // dedupe key -> best row
  for (const w of shard.windows) {
    const [ii, af, at, place, role, minAge, ...rest] = w;
    if (age < af || age > at || age < minAge || !geo.has(place)) continue;
    const roleName = core.roles[role];
    if (roleName === 'parent-of-kid' && !hasKids) continue;
    const it = shard.items[ii], flags = it[5];
    if (familyOnly && !(flags & 1)) continue;
    const s = rest[gi] ?? (rest[3] ? W.other_segment_popularity : W.default_popularity);
    const aff = it[9][gi] ?? W.neutral_affinity, rec = it[6] ?? 0.5, virt = virtueScore(core, it, W);
    const g = geo.get(place);
    const score = r1(s * g
      * (roleName === 'revival' ? W.role_weight_revival : roleName === 'rerun' ? W.role_weight_rerun : 1)
      * (W.aff_floor + W.aff_span * aff) * (W.recall_floor + W.recall_span * rec)
      * ((flags & 1) ? W.family_safe_boost : 1) * ((flags & 2) ? 1 + W.gratitude_weight : 1)
      * (1 + W.virtue_weight * virt) * (1 - W.vice_weight * it[7])
      * ((flags & 4) ? (faith ? W.faith_boost_churchgoer : W.faith_soften_other) : 1)
      * (it[11] == null || sportsFan ? 1 : W.sports_casual_floor + (1 - W.sports_casual_floor) * it[11]));   // casual recall
    const key = it[1].toLowerCase();
    const prev = best.get(key);
    if (!prev || score > prev.score || (score === prev.score && it[0] < prev.it[0])) best.set(key, { it, score, geo: g, role: roleName, place, virt });
  }
  const lanes = new Map();
  for (const r of best.values()) {
    const cat = core.categories[r.it[2]], lane = r.geo > 1 ? 'local' : cat;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push({ ...r, cat, lane });
  }
  const out = [];
  for (const [lane, rows] of lanes) {
    rows.sort((a, b) => b.score - a.score || (a.it[0] < b.it[0] ? -1 : 1));
    rows.forEach((r, k) => {
      const lrr = core.lane_rules[r.cat] || {};       // like feed.sql: each row's own category rule caps its lane rank
      if (k + 1 > (lrr.max_cards ?? 1e6)) return;
      out.push({ id: r.it[0], name: r.it[1], quoted: !!r.it[10], subtitle: r.it[4], caption: r.it[3], category: r.cat, lane,
                 display: lrr.display === 'caption' && r.it[3] ? r.it[3] : r.it[1], place: r.place, role: r.role,
                 rank_score: r1(r.score * (lrr.weight ?? 1)), lane_rank: k + 1,
                 order: k * (r.cat === 'sports' && sportsFan ? (W.sports_fan_stride ?? 1) : (lrr.stride ?? 1)) + 1 + (lrr.offset ?? 0),
                 virtue: r.virt, vice: r.it[7], gratitude: !!(r.it[5] & 2), family_safe: !!(r.it[5] & 1) });
    });
  }
  out.sort((a, b) => a.order - b.order || b.rank_score - a.rank_score || (a.id < b.id ? -1 : 1));
  return out.slice(0, limit);
}

// Sparse, gentle reflections (mirrors scripts/feed.py with_reflections): one after every W.reflection_every_n_cards cards
// (0 = off), age-appropriate, deterministic per person so a refresh doesn't reshuffle; gratitude-themed after a gratitude card.
export function interleaveReflections(core, cards, birthYear, age, weights = {}) {
  const W = { ...core.weights, ...weights }, n = Math.round(W.reflection_every_n_cards ?? 12);
  const refl = core.reflections.filter((r) => r.min_age <= age && age <= r.max_age).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!n || !refl.length) return cards;
  let k = (birthYear * 31 + age) % refl.length;
  const out = [];
  cards.forEach((c, i) => {
    out.push(c);
    if ((i + 1) % n === 0) {
      const grat = refl.filter((r) => r.theme === 'gratitude'), pool = c.gratitude && grat.length ? grat : refl;
      out.push({ reflection: pool[k % pool.length] }); k++;
    }
  });
  return out;
}
