#!/usr/bin/env tsx
/**
 * QuickEnrich client for contacts.ts's Phase 4 waterfall — the tail-end fallback
 * after GetLeads → Blitz → Prospeo. Two-step API: free discovery (`contact-finder`,
 * batched by company_url) then paid resolution (`employees/search`, 1 credit per
 * match) for domains still uncovered after every earlier tier.
 *
 * Key: env QUICKENRICH_API_KEY (sign up at https://app.quickenrich.io).
 * OPTIONAL: with no key, `hasQuickenrichKey()` returns false and contacts.ts skips
 * the stage — same pattern as getleads-client.ts's hasGetleadsKey().
 *
 * Unlike /quickenrich-list-builder (the standalone skill, which asks for interactive
 * y/N confirmation before spending credits), this runs unattended — consistent with
 * how contacts.ts already calls paid Prospeo/Blitz tiers without a per-call prompt.
 * The lane's earlier READY gate (human review before Phase 4 runs at all) is the
 * approval checkpoint here, not a runtime confirm().
 *
 * CLI:
 *   npx tsx quickenrich-client.ts <domains-file> '<titles-csv>' --out=file.csv
 */
import { readFileSync, writeFileSync } from "fs";

const BASE_URL = "https://app.quickenrich.io/api";

function resolveKey(): string | null {
  return process.env.QUICKENRICH_API_KEY || null;
}

/** True when a QuickEnrich key is available. Callers use this to SKIP the stage. */
export function hasQuickenrichKey(): boolean { return resolveKey() != null; }

function requireKey(): string {
  const k = resolveKey();
  if (!k) throw new Error("QUICKENRICH_API_KEY not set — sign up at https://app.quickenrich.io");
  return k;
}

function authHeaders() {
  return { Authorization: `Bearer ${requireKey()}`, "Content-Type": "application/json" };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); }
  }
  throw lastErr;
}

async function contactFinderPage(filters: any, page: number, perPage: number): Promise<any> {
  const res = await withRetry(() => fetch(`${BASE_URL}/employees/contact-finder`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ ...filters, page, per_page: perPage }),
  }));
  if (!res.ok) throw new Error(`QuickEnrich contact-finder ${res.status}: ${await res.text()}`);
  return res.json();
}

async function resolveEmail(candidate: any): Promise<any | null> {
  const params = new URLSearchParams();
  if (candidate.employee_linkedin) {
    params.set("linkedin_url", candidate.employee_linkedin);
  } else if (candidate.company_url && candidate.first_name && candidate.last_name) {
    params.set("company_url", candidate.company_url);
    params.set("first_name", candidate.first_name);
    params.set("last_name", candidate.last_name);
  } else return null;
  const res = await withRetry(() => fetch(`${BASE_URL}/employees/search?${params.toString()}`, { headers: authHeaders() }));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`QuickEnrich email-search ${res.status}: ${await res.text()}`);
    // 404 (no match) or 422 (bad data on this one candidate, e.g. a malformed LinkedIn
    // URL in QuickEnrich's own dataset) — skip this candidate, don't fail the batch.
    return null;
  }
  const json = await res.json();
  return json?.data || null;
}

export interface QuickenrichRow {
  first_name: string; last_name: string; job_title: string; linkedin_url: string;
  domain: string; company_name: string; email: string; email_status: string;
}

/**
 * Discover + resolve contacts at the given domains matching the given titles.
 * Batches company_url into groups of 100 (QuickEnrich per_page max) per discovery
 * page; discovery is free, only resolveEmail spends credits, and only for
 * candidates has_email flagged true.
 */
export async function quickenrichContactsForDomains(domains: string[], titles: string[]): Promise<QuickenrichRow[]> {
  if (!domains.length) return [];
  const rows: QuickenrichRow[] = [];
  // company_url is open-text include — batch to keep request bodies reasonable.
  for (let i = 0; i < domains.length; i += 200) {
    const batch = domains.slice(i, i + 200);
    const filters = { title: { include: titles }, company_url: { include: batch }, has_email: true };
    let page = 1;
    let data = await contactFinderPage(filters, page, 100);
    const lastPage = data?.meta?.last_page || 1;
    const candidates: any[] = [];
    while (true) {
      candidates.push(...(data?.data || []));
      const hasMore = data?.meta?.has_more ?? page < lastPage;
      if (!hasMore) break;
      page++;
      await new Promise((r) => setTimeout(r, 200));
      data = data?.meta?.next_cursor
        ? await contactFinderPage({ ...filters, cursor: data.meta.next_cursor }, page, 100)
        : await contactFinderPage(filters, page, 100);
    }
    for (const c of candidates) {
      const resolved = await resolveEmail(c);
      if (resolved?.email) {
        rows.push({
          first_name: resolved.first_name || c.first_name || "",
          last_name: resolved.last_name || c.last_name || "",
          job_title: resolved.title || c.title || "",
          linkedin_url: resolved.employee_linkedin || c.employee_linkedin || "",
          domain: c.company_url || "",
          company_name: c.company_name || "",
          email: resolved.email,
          email_status: resolved.email_verification_date ? "verified" : "unverified",
        });
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return rows;
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const [domainsFile, titlesCsv] = process.argv.slice(2);
    const outArg = process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);
    if (!domainsFile || !titlesCsv || !outArg) {
      console.error("Usage: quickenrich-client.ts <domains-file> '<titles-csv>' --out=file.csv");
      process.exit(1);
    }
    if (!hasQuickenrichKey()) { console.error("No QuickEnrich key: set QUICKENRICH_API_KEY in .env"); process.exit(1); }
    const domains = readFileSync(domainsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const titles = titlesCsv.split(",").map((t) => t.trim()).filter(Boolean);
    const rows = await quickenrichContactsForDomains(domains, titles);
    const headers = ["first_name", "last_name", "job_title", "linkedin_url", "domain", "company_name", "email", "email_status"];
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => `"${String((r as any)[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    writeFileSync(outArg, csv);
    console.log(`${rows.length} rows → ${outArg}`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
