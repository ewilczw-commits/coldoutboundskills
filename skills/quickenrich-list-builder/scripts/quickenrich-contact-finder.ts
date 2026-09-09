#!/usr/bin/env tsx
/**
 * QuickEnrich API — title-first contact search → CSV.
 *
 * Usage:
 *   export QUICKENRICH_API_KEY=xxx
 *   npx tsx scripts/quickenrich-contact-finder.ts \
 *     --titles="VP Marketing;Head of Growth;CMO" \
 *     --countries=US \
 *     --headcounts="5 - 19;20 - 99" \
 *     --industries="Software Development;Information Technology & Services" \
 *     --bio-keywords="software;SaaS;platform" \
 *     --limit=2000 \
 *     --out=leads.csv
 *
 * NOTE: lists are semicolon-delimited, not comma-delimited — several QuickEnrich industry
 * labels themselves contain commas (e.g. "Technology, Information and Internet").
 *
 * Two-phase, matching QuickEnrich's own API design:
 *   1. POST /api/employees/contact-finder — free discovery, paginated via cursor.
 *      Runs as up to TWO independent passes that get merged/deduped (a union, not an AND):
 *        - --industries pass: exact-match against LinkedIn's assigned industry taxonomy
 *          (values must match GET /api/lookups/industries exactly)
 *        - --bio-keywords pass: open-text match against the company's own LinkedIn "About" copy
 *      This matters because LinkedIn's industry taxonomy tags companies by the VERTICAL they sell
 *      into (e.g. "Accounting", "Banking", "Hospitals and Health Care"), not by whether they're a
 *      software company — a vertical SaaS company is often mistagged under its customer's
 *      industry instead of "Software Development". bio_li catches those; industry_linkedin
 *      catches everything correctly tagged. Neither alone is complete, so this script runs both
 *      and merges. Pass only one of --industries / --bio-keywords to run a single pass, or
 *      neither to skip the industry axis entirely (title + headcount + country only).
 *   2. GET  /api/employees/search — 1 credit per lookup, resolves the actual email for each
 *      discovered contact via their LinkedIn URL. Only charged when a match is found.
 *
 * Output CSV columns match this repo's standard lead schema (see /prospeo-full-export,
 * /blitz-list-builder) for drop-in compatibility with /icp-prompt-builder, /list-quality-scorecard,
 * and /smartlead-campaign-upload-public:
 *   email, first_name, last_name, full_name, role_title, linkedin_url, city, state, country,
 *   company_name, company_domain, company_industry, company_headcount, company_linkedin, email_status
 */

import { writeFileSync } from "fs";
import * as readline from "readline";

const QUICKENRICH_API_KEY = process.env.QUICKENRICH_API_KEY;
const BASE_URL = "https://app.quickenrich.io/api";

if (!QUICKENRICH_API_KEY) {
  console.error("Missing env: QUICKENRICH_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  // Semicolon-delimited, not comma: several QuickEnrich industry labels themselves contain
  // commas (e.g. "Technology, Information and Internet"), which would break comma-splitting.
  const list = (flag: string): string[] => {
    const v = get(flag);
    return v ? v.split(";").map((s) => s.trim()).filter(Boolean) : [];
  };
  return {
    titles: list("--titles"),
    countries: list("--countries"),
    headcounts: list("--headcounts"), // exact-match range labels, e.g. "5 - 19" — see GET /api/lookups/employee-ranges
    industries: list("--industries"), // exact strings from GET /api/lookups/industries
    bioKeywords: list("--bio-keywords"), // open-text, matched against LinkedIn About copy
    limit: Number(get("--limit") ?? 2000),
    out: get("--out") ?? "leads.csv",
  };
}

function authHeaders() {
  return { Authorization: `Bearer ${QUICKENRICH_API_KEY}`, "Content-Type": "application/json" };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

async function contactFinderPage(filters: any, page: number, perPage: number): Promise<any> {
  const res = await withRetry(() =>
    fetch(`${BASE_URL}/employees/contact-finder`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...filters, page, per_page: perPage }),
    })
  );
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
  } else {
    return null;
  }
  const res = await withRetry(() =>
    fetch(`${BASE_URL}/employees/search?${params.toString()}`, { headers: authHeaders() })
  );
  if (!res.ok) {
    // 401/403 mean the API key itself is bad — stop the whole run, don't burn through candidates.
    if (res.status === 401 || res.status === 403) {
      throw new Error(`QuickEnrich email-search ${res.status}: ${await res.text()}`);
    }
    // Everything else (404 no match, 422 bad data on this one candidate — e.g. a malformed
    // LinkedIn URL in QuickEnrich's own dataset) is a per-candidate problem: skip and continue,
    // don't crash the batch over one bad row.
    if (res.status !== 404) {
      console.error(`\n  [skip] ${candidate.company_name || candidate.company_url || "unknown"}: ${res.status} ${(await res.text()).slice(0, 150)}`);
    }
    return null;
  }
  const json = await res.json();
  return json?.data || null;
}

function candidateKey(c: any): string {
  return c.employee_linkedin || `${c.company_url || ""}|${c.first_name || ""}|${c.last_name || ""}`;
}

async function discoverPass(filters: any, cap: number, label: string, into: Map<string, any>): Promise<void> {
  const perPage = 100; // API max
  console.error(`Discovering [${label}] (free — Contact Finder does not charge credits)...`);
  const first = await contactFinderPage(filters, 1, perPage);
  const total = first?.meta?.total || 0;
  const lastPage = first?.meta?.last_page || 0;

  if (total === 0) {
    console.error(`  [${label}] 0 matches.`);
    return;
  }
  console.error(`  [${label}] ${total} total matches — collecting up to ${cap}...`);

  let collected = 0;
  let cursor: string | undefined;
  let page = 1;
  let data = first;
  while (collected < cap) {
    for (const c of data?.data || []) {
      const key = candidateKey(c);
      if (!into.has(key)) {
        into.set(key, c);
        collected++;
      }
    }
    process.stderr.write(`  [${label}] page ${page}${lastPage ? `/${lastPage}` : ""}, ${collected}/${cap} new so far...\r`);
    cursor = data?.meta?.next_cursor;
    const hasMore = data?.meta?.has_more ?? page < lastPage;
    if (!hasMore || collected >= cap) break;
    page++;
    await new Promise((r) => setTimeout(r, 200));
    data = cursor ? await contactFinderPage({ ...filters, cursor }, page, perPage) : await contactFinderPage(filters, page, perPage);
  }
  console.error();
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

interface LeadRow {
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  role_title: string;
  linkedin_url: string;
  city: string;
  state: string;
  country: string;
  company_name: string;
  company_domain: string;
  company_industry: string;
  company_headcount: string;
  company_linkedin: string;
  email_status: string;
}

function mapResult(candidate: any, resolved: any | null): LeadRow {
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

function toCsv(rows: LeadRow[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const out = [headers.join(",")];
  for (const r of rows) {
    out.push(headers.map((h) => `"${String((r as any)[h] ?? "").replace(/"/g, '""')}"`).join(","));
  }
  return out.join("\n");
}

async function main() {
  const args = parseArgs();

  if (args.titles.length === 0) {
    console.error(
      'Usage: --titles="VP Marketing;Head of Growth" [--countries=US] [--headcounts="5 - 19;20 - 99"] [--industries="Software Development"] [--bio-keywords="software;SaaS"] [--limit=2000] [--out=leads.csv]'
    );
    console.error("Note: lists are semicolon-delimited (;), not comma-delimited — some industry labels contain commas.");
    console.error("Note: --industries values must match GET /api/lookups/industries exactly, or QuickEnrich returns 422.");
    console.error("      --headcounts values must match GET /api/lookups/employee-ranges exactly.");
    process.exit(1);
  }

  const baseFilters: any = {
    title: { include: args.titles },
    has_email: true, // skip candidates we can't resolve an email for — saves wasted email-search calls
  };
  if (args.countries.length > 0) baseFilters.country_code = { include: args.countries };
  if (args.headcounts.length > 0) baseFilters.number_of_employees = { include: args.headcounts };

  // Build the discovery passes. industry_linkedin and bio_li are two independent, imperfect axes
  // for "is this a software company" — run each as its own pass and merge/dedupe rather than
  // ANDing them together in one query (which would be an intersection, not a union).
  const passes: Array<{ label: string; filters: any }> = [];
  if (args.industries.length > 0) {
    passes.push({ label: "industry taxonomy", filters: { ...baseFilters, industry_linkedin: { include: args.industries } } });
  }
  if (args.bioKeywords.length > 0) {
    passes.push({ label: "bio_li keyword", filters: { ...baseFilters, bio_li: { include: args.bioKeywords } } });
  }
  if (passes.length === 0) {
    passes.push({ label: "base filters only", filters: baseFilters });
  }

  const merged = new Map<string, any>();
  const capPerPass = Math.ceil(args.limit / passes.length);
  for (const pass of passes) {
    await discoverPass(pass.filters, capPerPass, pass.label, merged);
  }
  // Top off from whichever pass still has room, in case one pass came up short of its cap.
  if (merged.size < args.limit) {
    for (const pass of passes) {
      if (merged.size >= args.limit) break;
      await discoverPass(pass.filters, args.limit - merged.size, `${pass.label} (top-off)`, merged);
    }
  }

  if (merged.size === 0) {
    console.error("QuickEnrich returned 0 results across all passes. Try removing filters, or check --industries against /api/lookups/industries.");
    process.exit(1);
  }

  const trimmed = Array.from(merged.values()).slice(0, args.limit);

  console.error(`\nDiscovery complete: ${trimmed.length} unique candidates merged across ${passes.length} pass(es).`);
  console.error(`Next step resolves actual emails via /api/employees/search — 1 credit per successful lookup.`);
  console.error(`Estimated cost: up to ${trimmed.length} credits (only charged when a match is found).`);
  const ok = await confirm(`Proceed with email resolution for ${trimmed.length} candidates? (y/N)`);
  if (!ok) {
    console.error("Cancelled — no credits spent.");
    process.exit(0);
  }

  const results: LeadRow[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    process.stderr.write(`Resolving ${i + 1}/${trimmed.length}...\r`);
    const resolved = await resolveEmail(trimmed[i]);
    if (resolved?.email) results.push(mapResult(trimmed[i], resolved));
    await new Promise((r) => setTimeout(r, 150));
  }
  console.error();

  // Dedupe by email
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const e = r.email.toLowerCase();
    if (!e || seen.has(e)) return false;
    seen.add(e);
    return true;
  });

  writeFileSync(args.out, toCsv(deduped));
  console.error(`\nWrote ${args.out} — ${deduped.length} leads with resolved emails.`);
  if (deduped.length < trimmed.length) {
    console.error(`(${trimmed.length - deduped.length} candidates had no resolvable email despite has_email=true)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
