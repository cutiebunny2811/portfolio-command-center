function attributeValue(attributes, name) {
  const match = String(attributes || "").match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return match?.[1] || "";
}

function factNumber(attributes, content) {
  const text = String(content || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#160;|&nbsp;/gi, " ")
    .replace(/[^0-9.()-]/g, "")
    .trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || attributeValue(attributes, "sign") === "-";
  const parsed = Number(text.replace(/[()]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  const scale = Number(attributeValue(attributes, "scale") || 0);
  return (negative ? -parsed : parsed) * (10 ** (Number.isFinite(scale) ? scale : 0));
}

export function coverPageSharesFromHtml(html) {
  const values = new Set();
  const factPattern = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gi;
  let match;
  while ((match = factPattern.exec(String(html || "")))) {
    if (!/^dei:EntityCommonStockSharesOutstanding$/i.test(attributeValue(match[1], "name"))) continue;
    const value = factNumber(match[1], match[2]);
    if (Number.isFinite(value) && value > 0) values.add(value);
  }

  const sorted = [...values].sort((left, right) => right - left);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const smallerTotal = sorted.slice(1).reduce((sum, value) => sum + value, 0);
  if (smallerTotal > 0 && Math.abs(sorted[0] - smallerTotal) / sorted[0] <= 0.02) return sorted[0];
  return sorted.reduce((sum, value) => sum + value, 0);
}

export function latestPrimaryFilingUrl(submission, cik) {
  const recent = submission?.filings?.recent || {};
  const forms = recent.form || [];
  const index = forms.findIndex((form) => ["10-Q", "10-K", "20-F", "40-F"].includes(String(form || "")));
  const accession = recent.accessionNumber?.[index];
  const primaryDocument = recent.primaryDocument?.[index];
  if (index < 0 || !accession || !primaryDocument) return null;
  const accessionPath = String(accession).replace(/-/g, "");
  const cikPath = String(cik).replace(/^0+/, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}/${primaryDocument}`;
}
