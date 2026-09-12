import { FETCH_TIMEOUT_MS } from "../constants.ts";
import type { DomainConfig } from "../config.ts";

export function extractCandidateUrl(toolName: string, params: unknown): string | null {
  const p = params as Record<string, unknown>;
  if (toolName === "web_fetch" || toolName === "browser") {
    return typeof p?.url === "string" ? p.url : null;
  }
  return null;
}

function hostnameMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const pat = pattern.toLowerCase().replace(/^\*\./, "");
  return h === pat || h.endsWith(`.${pat}`);
}

// Avoids re-querying the same host repeatedly within a session; failures are
// never cached, only successful lookups (a transient API error next time
// should still get a fresh attempt rather than being stuck at "unknown").
const urlhausCache = new Map<string, { malicious: boolean; ts: number }>();
const URLHAUS_CACHE_TTL_MS = 10 * 60 * 1000;

async function checkUrlhausReputation(hostname: string): Promise<boolean | null> {
  const cached = urlhausCache.get(hostname);
  if (cached && Date.now() - cached.ts < URLHAUS_CACHE_TTL_MS) return cached.malicious;
  try {
    const res = await fetch("https://urlhaus-api.abuse.ch/v1/host/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `host=${encodeURIComponent(hostname)}`,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json() as { query_status?: string };
    // "ok" means the host was found in URLhaus's malicious-URL database
    const malicious = data.query_status === "ok";
    urlhausCache.set(hostname, { malicious, ts: Date.now() });
    return malicious;
  } catch {
    // Reputation lookup is a best-effort extra signal, not the sole gate —
    // fail open on network errors rather than blocking every fetch when
    // the third-party API is unreachable.
    return null;
  }
}

// URLhaus only indexes hosts tied to *known* malware — a domain registered
// yesterday purely for one targeted phishing/exfiltration attempt is very
// unlikely to be listed there yet. Domain age (via RDAP) is a free, keyless
// signal for exactly that gap: legitimate businesses are rarely days old,
// disposable attack infrastructure often is.
//
// Queried the standards-compliant way (RFC 7484/9224 bootstrap + RFC 9083
// event parsing) rather than depending on any single convenience proxy:
// IANA's bootstrap file maps each TLD to its authoritative RDAP server.
let rdapBootstrapPromise: Promise<Map<string, string>> | null = null;

async function loadRdapBootstrap(): Promise<Map<string, string>> {
  if (!rdapBootstrapPromise) {
    rdapBootstrapPromise = (async () => {
      const map = new Map<string, string>();
      try {
        const res = await fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) {
          const data = await res.json() as { services?: Array<[string[], string[]]> };
          for (const [tlds, urls] of data.services ?? []) {
            const base = urls?.[0];
            if (!base) continue;
            for (const tld of tlds) map.set(tld.toLowerCase(), base);
          }
        }
      } catch { /* leave map empty — age check becomes a no-op below */ }
      return map;
    })();
  }
  return rdapBootstrapPromise;
}

// null means "couldn't determine" (unsupported TLD, privacy-redacted RDAP
// record, registry unreachable) — never treated as suspicious, only a
// successfully-parsed young age is.
const domainAgeCache = new Map<string, { ageDays: number | null; ts: number }>();
const DOMAIN_AGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function checkDomainAgeDays(hostname: string): Promise<number | null> {
  const cached = domainAgeCache.get(hostname);
  if (cached && Date.now() - cached.ts < DOMAIN_AGE_CACHE_TTL_MS) return cached.ageDays;

  const ageDays = await (async (): Promise<number | null> => {
    try {
      const labels = hostname.toLowerCase().split(".");
      const tld = labels[labels.length - 1];
      const base = (await loadRdapBootstrap()).get(tld);
      if (!base) return null;
      // Simplified "last two labels" registrable-domain guess — wrong for
      // multi-part public suffixes (co.uk, com.au, github.io, ...), where it
      // queries the shared second-level suffix instead of the actual site.
      // That risks a false negative (an old shared suffix masking a brand-new
      // subdomain under it), not a false positive, and only for those TLDs —
      // a full Public Suffix List is the correct fix but out of scope here.
      const registrableDomain = labels.slice(-2).join(".");
      const url = `${base.endsWith("/") ? base : `${base}/`}domain/${registrableDomain}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const data = await res.json() as { events?: Array<{ eventAction?: string; eventDate?: string }> };
      const registration = data.events?.find(e => e.eventAction === "registration")?.eventDate;
      if (!registration) return null;
      const registeredAt = new Date(registration).getTime();
      if (Number.isNaN(registeredAt)) return null;
      return Math.floor((Date.now() - registeredAt) / (24 * 60 * 60 * 1000));
    } catch {
      return null;
    }
  })();

  domainAgeCache.set(hostname, { ageDays, ts: Date.now() });
  return ageDays;
}

export async function checkDomainBorder(url: string, cfg: DomainConfig | undefined): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `Could not parse URL for domain check: ${url}`;
  }

  if (cfg?.allow && cfg.allow.length > 0) {
    const allowed = cfg.allow.some(p => hostnameMatches(hostname, p));
    return allowed ? null : `Domain "${hostname}" is not on the configured allow-list.`;
  }

  if (cfg?.deny?.some(p => hostnameMatches(hostname, p))) {
    return `Domain "${hostname}" is on the configured deny-list.`;
  }

  if (cfg?.reputationCheck !== false) {
    const malicious = await checkUrlhausReputation(hostname);
    if (malicious) return `Domain "${hostname}" is flagged as malicious by URLhaus (abuse.ch).`;
  }

  // Off by default: legitimate new businesses exist, so this is a real
  // false-positive risk the operator opts into, unlike reputationCheck above.
  if (cfg?.minAgeDays && cfg.minAgeDays > 0) {
    const ageDays = await checkDomainAgeDays(hostname);
    if (ageDays !== null && ageDays < cfg.minAgeDays) {
      return `Domain "${hostname}" was registered ${ageDays} day(s) ago, under the configured minimum of ${cfg.minAgeDays} day(s).`;
    }
  }

  return null;
}
