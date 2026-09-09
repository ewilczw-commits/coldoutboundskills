#!/usr/bin/env tsx
/**
 * Pull account inventory from Instantly and write to CSV.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/audit-inboxes.ts --all --out=/tmp/audit/inboxes.csv
 *   npx tsx scripts/audit-inboxes.ts --tag=active --out=/tmp/audit/active.csv
 *
 * Field mapping notes (see /instantly-inbox-manager for the full account schema):
 *   status: -3 Sending Error, -2 Soft Bounce, -1 Connection Error, 1 Active, 2 Paused, 3 Maintenance
 *   warmup_status: -3 Permanent Suspension, -2 Spam Folder Unknown, -1 Banned, 0 Paused, 1 Active
 *   stat_warmup_score: 0-100 reputation score (no direct Smartlead-style "daily_sent_count" field
 *     is exposed on this endpoint — use GET /accounts/analytics/daily if you need exact volume)
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env var: INSTANTLY_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    all: args.includes("--all"),
    tag: get("--tag"),
    domain: get("--domain"),
    maxAccounts: get("--max-accounts") ? Number(get("--max-accounts")) : Infinity,
    out: get("--out") ?? "/tmp/audit/inboxes.csv",
  };
}

async function listAll(maxAccounts: number = Infinity): Promise<any[]> {
  const all: any[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const qs = new URLSearchParams({ limit: "100", include_tags: "true" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const resp = await fetch(`${API_BASE}/accounts?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text().catch(() => "")}`);
    const page = await resp.json();
    const items = page?.items ?? [];
    all.push(...items);
    console.error(`  fetched ${all.length} so far`);
    if (all.length >= maxAccounts) {
      all.length = Math.min(all.length, maxAccounts);
      break;
    }
    if (!page?.next_starting_after || items.length < 100) break;
    startingAfter = page.next_starting_after;
  }
  return all;
}

function rowFor(a: any) {
  const email = a.email || "";
  const domain = email.split("@")[1] || "";
  return {
    email,
    domain,
    first_name: a.first_name || "",
    tags: (a.tags ?? []).map((t: any) => t.label).join("|"),
    status: a.status ?? "",
    warmup_status: a.warmup_status ?? "",
    warmup_score: a.stat_warmup_score ?? "",
    warmup_limit: a.warmup?.limit ?? "",
    daily_limit: a.daily_limit ?? "",
    provider_code: a.provider_code ?? "",
  };
}

async function main() {
  const { all: wantAll, tag, domain, out, maxAccounts } = parseArgs();
  let accounts = await listAll(maxAccounts);
  if (tag) accounts = accounts.filter((a) => (a.tags ?? []).some((t: any) => t.label === tag));
  if (domain) accounts = accounts.filter((a) => (a.email || "").endsWith(`@${domain}`));
  if (!wantAll && !tag && !domain) {
    console.error("Provide --all, --tag=..., or --domain=...");
    process.exit(1);
  }
  const rows = accounts.map(rowFor);
  if (!rows.length) {
    console.error("No accounts matched.");
    return;
  }
  const header = Object.keys(rows[0]);
  const csv = [header.join(",")];
  for (const r of rows) {
    csv.push(header.map((h) => `"${String((r as any)[h]).replace(/"/g, '""')}"`).join(","));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv.join("\n"));
  console.error(`Wrote ${out} — ${rows.length} accounts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
