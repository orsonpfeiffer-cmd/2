// Decides which brands an article is about, from its headline and summary.
//
// A brand counts when:
//   - it is named in the headline, or
//   - it is named at least twice in the summary (one mention = passing mention), or
//   - the source is dedicated to the brand and names it once (or `trustBrand` is set).
// Phrases in `ignore` (Volvo Trucks, Porsche SE, stadium names...) are removed first.
export function matchBrands(article, source, config) {
  const title = article.title || '';
  const summary = article.summary || '';
  if (config.excludeTitle.some((re) => re.test(title))) return [];

  const found = [];
  for (const brand of config.brands) {
    const t = stripIgnored(title, brand);
    const s = stripIgnored(summary, brand);
    const titleHits = count(t, brand.mention);
    const summaryHits = count(s, brand.mention);
    const dedicated = source.brands?.includes(brand.id);

    let match = titleHits > 0 || summaryHits >= 2;
    if (!match && dedicated) match = source.trustBrand || summaryHits > 0;
    if (match && brand.excludeTitle.some((re) => re.test(title))) match = false;
    if (match) found.push(brand.id);
  }
  return found;
}

function stripIgnored(text, brand) {
  let out = text;
  for (const re of brand.ignore) out = out.replace(re, ' ');
  return out;
}

function count(text, re) {
  return text ? (text.match(re) || []).length : 0;
}
