// Same-story detection: two headlines are the same story when, after dropping filler
// words and brand names, they share enough distinctive words.

const STOP = new Set(`a an the and or but of to in on for with at by from as is are was were be been being it its
this that these those new all more most just first now how why what when who whos here heres you your we our they
their has have had will would can get gets got into out over up about after before than then so not no yes vs via
also says said report reports video photos photo gallery watch look looks officially official launch launched
launches reveal revealed reveals unveil unveiled unveils debut debuts announce announced announces update updated
car cars model models brand year s e`.split(/\s+/));

function stem(w) {
  if (/^\d/.test(w)) return w;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function makeStopwords(config) {
  const stop = new Set(STOP);
  for (const b of config.brands) for (const a of b.aliases) stop.add(a.toLowerCase());
  return stop;
}

export function titleKey(title, stop) {
  const words = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '')
    .replace(/(\d),(\d{3})/g, '$1$2') // 50,000 → 50000
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !stop.has(w))
    .map(stem)
    .filter((w) => w && !stop.has(w));
  return [...new Set(words)].join(' ');
}

export function sameStory(keyA, keyB) {
  if (!keyA || !keyB) return false;
  const A = new Set(keyA.split(' '));
  const B = new Set(keyB.split(' '));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  const jaccard = inter / union;
  const overlap = inter / Math.min(A.size, B.size);
  if (inter >= 3 && (jaccard >= 0.5 || overlap >= 0.8)) return true;
  return inter >= 2 && jaccard === 1;
}

// Which article leads a cluster: newsroom > outlet > Google News, then has an image, then earliest.
const RANK = { official: 3, outlet: 2, aggregator: 1 };
export function pickPrimary(members) {
  return [...members].sort(
    (a, b) =>
      (RANK[b.source_type] || 0) - (RANK[a.source_type] || 0) ||
      (b.image ? 1 : 0) - (a.image ? 1 : 0) ||
      a.published_at - b.published_at ||
      (a.id < b.id ? -1 : 1),
  )[0];
}
