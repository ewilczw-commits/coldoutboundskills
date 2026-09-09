#!/usr/bin/env tsx
// Full two-pass QuickEnrich contact search → CSV. Alternative to prospeo-full-export.ts —
// see references/06b-list-building-quickenrich.md for when to reach for this one instead.
// Run: npx tsx scripts/quickenrich-contact-finder.ts --title "VP Marketing" --title "Head of Growth" \
//        --country US --headcount "5 - 19" --headcount "20 - 99" --industry "Software Development" \
//        --bio-keyword "software" --bio-keyword "SaaS" --limit 2000
//
// Two-phase, matching QuickEnrich's API design:
//   1. /api/employees/contact-finder — free discovery, paginated via cursor.
//      Runs as up to TWO independent passes that get merged/deduped (a union, not an AND):
//        - --industry pass: exact-match against LinkedIn's assigned industry taxonomy
//        - --bio-keyword pass: open-text match against the company's own LinkedIn "About" copy
//      This matters because LinkedIn's industry taxonomy tags companies by the VERTICAL they
//      sell into (e.g. "Accounting", "Banking"), not by whether they're a software company — a
//      vertical SaaS company is often mistagged. bio_li catches those; industry_linkedin catches
//      everything correctly tagged. Neither alone is complete, so we run both and merge.
//   2. /api/employees/search — 1 credit per lookup, resolves the actual email for each
//      discovered contact. Only charged when a match is found.
//
// Output: leads.csv (same column schema as prospeo-full-export.ts, for downstream compatibility
// with icp-prompt-builder / list-quality-scorecard / smartlead-campaign-upload-public)

import { env, required, parseArgs, writeCsv, sleep, retry, multiFlag, confirm } from "./_lib.ts";

const BASE_URL = "https://app.quickenrich.io/api";

function authHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function contactFinderPage(filters: any, page: number, perPage: number, apiKey: string): Promise<any> {
  const res = await retry(() => fetch(`${BASE_URL}/employees/contact-finder`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ ...filters, page, per_page: perPage }),
  }));
  if (!res.ok) throw new Error(`QuickEnrich contact-finder ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function resolveEmail(candidate: any, apiKey: string): Promise<any | null> {
  const params = new URLSearchParams();
  if (candidate.employee_linkedin) {
    params.set("linkedin_url", candidate.employee_linkedin);
  } else if (candidate.company_url && candidate.first_name && candidate.last_name) {
    params.set("company_url", candidate.company_url);
    params.set("first_name", candidate.first_name);
    params.set("last_name", candidate.last_name);
  } else {
    return null;
  }
  const res = await retry(() => fetch(`${BASE_URL}/employees/search?${params.toString()}`, {
    headers: authHeaders(apiKey),
  }));
  if (!res.ok) {
    // 401/403 mean the API key itself is bad — worth failing loudly, not silently skipping.
    if (res.status === 401 || res.status === 403) throw new Error(`QuickEnrich email-search ${res.status}: ${await res.text()}`);
    // 404 (no match) or 422 (bad data on this one candidate — e.g. a malformed LinkedIn URL
    // in QuickEnrich's own dataset) are per-candidate problems: skip, don't crash the batch.
    return null;
  }
  const json = await res.json();
  return json?.data || null;
}

function mapResult(candidate: any, resolved: any | null): Record<string, string> {
  const d = resolved || {};
  // contact-finder already returns rich company/location data; email-search only adds the
  // resolved personal email (and can override name/title if it has fresher data).
  return {
    email: d.email || "",
    first_name: d.first_name || candidate.first_name || "",
    last_name: d.last_name || candidate.last_name || "",
    full_name: [d.first_name || candidate.first_name, d.last_name || candidate.last_name].filter(Boolean).join(" "),
    role_title: d.title || candidate.title || "",
    linkedin_url: d.employee_linkedin || candidate.employee_linkedin || "",
    city: candidate.city || "",
    state: candidate.region_code || "",
    country: candidate.country_code || "",
    company_name: candidate.company_name || "",
    company_domain: candidate.company_url || "",
    company_industry: candidate.industry || "",
    company_headcount: candidate.employee_count || "",
    company_linkedin: candidate.company_linked || "",
    email_status: d.email_verification_date ? "verified" : "",
  };
}

function candidateKey(c: any): string {
  return c.employee_linkedin || `${c.company_url || ""}|${c.first_name || ""}|${c.last_name || ""}`;
}

async function discoverPass(filters: any, cap: number, apiKey: string, label: string, into: Map<string, any>): Promise<void> {
  const perPage = 100; // API max
  console.log(`Discovering [${label}] (free — Contact Finder does not charge credits)...`);
  const first = await contactFinderPage(filters, 1, perPage, apiKey);
  const total = first?.meta?.total || 0;
  const lastPage = first?.meta?.last_page || 0;

  if (total === 0) {
    console.log(`  [${label}] 0 matches.`);
    return;
  }
  console.log(`  [${label}] ${total} total matches — collecting up to ${cap}...`);

  let collected = 0;
  let cursor: string | undefined;
  let page = 1;
  let data = first;
  while (collected < cap) {
    for (const c of (data?.data || [])) {
      const key = candidateKey(c);
      if (!into.has(key)) { into.set(key, c); collected++; }
    }
    process.stdout.write(`  [${label}] page ${page}${lastPage ? `/${lastPage}` : ""}, ${collected}/${cap} new so far...\r`);
    cursor = data?.meta?.next_cursor;
    const hasMore = data?.meta?.has_more ?? (page < lastPage);
    if (!hasMore || collected >= cap) break;
    page++;
    await sleep(200);
    data = cursor
      ? await contactFinderPage({ ...filters, cursor }, page, perPage, apiKey)
      : await contactFinderPage(filters, page, perPage, apiKey);
  }
  console.log();
}

async function main() {
  const { flags } = parseArgs();
  const titles = multiFlag(flags, "title");
  const countries = multiFlag(flags, "country");
  const headcounts = multiFlag(flags, "headcount"); // exact-match range labels — GET /api/lookups/employee-ranges
  const industries = multiFlag(flags, "industry"); // exact strings — GET /api/lookups/industries
  const bioKeywords = multiFlag(flags, "bio-keyword"); // open-text against company LinkedIn About copy
  const limit = parseInt((flags.limit as string) || "2000");
  const output = (flags.output as string) || "leads.csv";

  if (titles.length === 0) {
    console.error("Usage: --title 'VP Marketing' --title 'Head of Growth' [--country US] [--headcount '5 - 19'] [--industry 'Software Development'] [--bio-keyword 'software' --bio-keyword 'SaaS'] [--limit 2000] [--output leads.csv]");
    console.error("Note: --industry values must match /api/lookups/industries exactly, --headcount must match /api/lookups/employee-ranges exactly, or QuickEnrich returns 422.");
    process.exit(1);
  }

  const apiKey = required("QUICKENRICH_API_KEY");

  const baseFilters: any = {
    title: { include: titles },
    has_email: true, // skip candidates we can't resolve an email for — saves wasted email-search calls
  };
  if (countries.length > 0) baseFilters.country_code = { include: countries };
  if (headcounts.length > 0) baseFilters.number_of_employees = { include: headcounts };

  const passes: Array<{ label: string; filters: any }> = [];
  if (industries.length > 0) passes.push({ label: "industry taxonomy", filters: { ...baseFilters, industry_linkedin: { include: industries } } });
  if (bioKeywords.length > 0) passes.push({ label: "bio_li keyword", filters: { ...baseFilters, bio_li: { include: bioKeywords } } });
  if (passes.length === 0) passes.push({ label: "base filters only", filters: baseFilters });

  const merged = new Map<string, any>();
  const capPerPass = Math.ceil(limit / passes.length);
  for (const pass of passes) await discoverPass(pass.filters, capPerPass, apiKey, pass.label, merged);
  if (merged.size < limit) {
    for (const pass of passes) {
      if (merged.size >= limit) break;
      await discoverPass(pass.filters, limit - merged.size, apiKey, `${pass.label} (top-off)`, merged);
    }
  }

  if (merged.size === 0) {
    console.error("QuickEnrich returned 0 results across all passes. Try removing filters, or check --industry against /api/lookups/industries.");
    process.exit(1);
  }

  const trimmed = Array.from(merged.values()).slice(0, limit);

  console.log(`\nDiscovery complete: ${trimmed.length} unique candidates merged across ${passes.length} pass(es).`);
  console.log(`Next step resolves actual emails via /api/employees/search — 1 credit per successful lookup.`);
  console.log(`Estimated cost: up to ${trimmed.length} credits (only charged when a match is found).`);
  const ok = await confirm(`Proceed with email resolution for ${trimmed.length} candidates? (y/N)`);
  if (!ok) { console.log("Cancelled — no credits spent."); process.exit(0); }

  const results: Record<string, string>[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const candidate = trimmed[i];
    process.stdout.write(`Resolving ${i + 1}/${trimmed.length}...\r`);
    const resolved = await resolveEmail(candidate, apiKey);
    if (resolved?.email) results.push(mapResult(candidate, resolved));
    await sleep(150);
  }
  console.log();

  const seen = new Set<string>();
  const deduped = results.filter(r => {
    if (!r.email || seen.has(r.email.toLowerCase())) return false;
    seen.add(r.email.toLowerCase());
    return true;
  });

  writeCsv(output, deduped);
  console.log(`\n✅ Saved ${deduped.length} leads to ${output}`);
  if (deduped.length < trimmed.length) {
    console.log(`(${trimmed.length - deduped.length} candidates had no resolvable email despite has_email=true)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
