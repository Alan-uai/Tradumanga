export function canonicalizeSourceUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("A URL deve usar HTTP ou HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("URLs com credenciais embutidas não são aceitas.");
  }
  url.hash = "";
  const tracking = new Set(["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","mc_cid","mc_eid"]);
  for (const key of [...url.searchParams.keys()]) {
    if (tracking.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.toString();
}

export function assertSourceUrl(raw: string): string {
  return canonicalizeSourceUrl(raw);
}
