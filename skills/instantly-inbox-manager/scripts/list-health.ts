#!/usr/bin/env tsx
/**
 * Account health dashboard — prints summary + optional CSV.
 *
 * Usage:
 *   npx tsx scripts/list-health.ts --all
 *   npx tsx scripts/list-health.ts --tag=insurance --out=health.csv
 *   npx tsx scripts/list-health.ts --filter=reputation:good --out=good-accounts.csv
 *
 * Filters:
 *   --filter=reputation:good|fair|bad|unknown
 *   --filter=warmup:on|off
 *   --filter=health:healthy|warming|blocked|active|connection_failed
 *
 * Field mapping from Instantly's account schema (verified via live OpenAPI spec):
 *   status: -3 Sending Error, -2 Soft Bounce, -1 Connection Error, 1 Active, 2 Paused, 3 Maintenance
 *   warmup_status: -3 Permanent Suspension, -2 Spam Folder Unknown, -1 Banned, 0 Paused, 1 Active
 *   stat_warmup_score: 0-100 reputation score (this repo's "reputation" column)
 *
 * NOTE: unlike Smartlead's daily_sent_count, Instantly's account list doesn't expose a
 * per-day sent count directly — use GET /accounts/analytics/daily for that if you need
 * exact send volume (not implemented in this script; open an issue/extend if needed).
 */

import { writeFileSync } from "fs";
import { parseFlag, selectAccounts, hasFlag, InstantlyAccount } from "./_lib";

interface HealthRow {
  email: string;
  domain: string;
  tags: string;
  warmup: string;
  reputation: string;
  warmup_score: number | string;
  daily_limit: number | string;
  account_status: string;
  health_status: string;
}

function reputationFromScore(score: number | null | undefined): string {
  if (score == null) return "unknown";
  if (score >= 80) return "good";
  if (score >= 50) return "fair";
  return "bad";
}

function accountToHealthRow(a: InstantlyAccount): HealthRow {
  const domain = a.email.split("@")[1] || "";
  const warmupOn = a.warmup_status === 1;
  const blocked = a.warmup_status === -1 || a.warmup_status === -3;
  const connectionFailed = (a.status ?? 0) < 0;
  let health_status = "healthy";
  if (connectionFailed) health_status = "connection_failed";
  else if (blocked) health_status = "blocked";
  else if (warmupOn && (a.stat_warmup_score ?? 0) < 30) health_status = "warming";
  else if (!warmupOn) health_status = "active";
  return {
    email: a.email,
    domain,
    tags: (a.tags ?? []).map((t) => t.label).join(","),
    warmup: warmupOn ? "on" : "off",
    reputation: reputationFromScore(a.stat_warmup_score),
    warmup_score: a.stat_warmup_score ?? "",
    daily_limit: a.daily_limit ?? "",
    account_status: String(a.status ?? ""),
    health_status,
  };
}

function applyFilter(row: HealthRow, filter: string): boolean {
  const [k, v] = filter.split(":");
  if (k === "reputation") return row.reputation === v;
  if (k === "warmup") return row.warmup === v;
  if (k === "health") return row.health_status === v;
  throw new Error(`Unknown filter: ${filter}`);
}

function toCsv(rows: HealthRow[]): string {
  const header = Object.keys(rows[0] ?? {
    email: "", domain: "", tags: "", warmup: "", reputation: "", warmup_score: "",
    daily_limit: "", account_status: "", health_status: "",
  });
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => `"${String((row as any)[h]).replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const out = parseFlag(args, "--out");
  const filter = parseFlag(args, "--filter");

  if (!hasFlag(args, "--all") && !parseFlag(args, "--tag") && !parseFlag(args, "--domain") && !parseFlag(args, "--emails")) {
    args.push("--all");
  }

  const accounts = await selectAccounts(args);
  let rows = accounts.map(accountToHealthRow);
  if (filter) rows = rows.filter((r) => applyFilter(r, filter));

  const total = rows.length;
  const warmupOn = rows.filter((r) => r.warmup === "on").length;
  const active = rows.filter((r) => r.warmup === "off").length;
  const blocked = rows.filter((r) => r.health_status === "blocked").length;
  const failedConn = rows.filter((r) => r.health_status === "connection_failed").length;
  const repGood = rows.filter((r) => r.reputation === "good").length;
  const repFair = rows.filter((r) => r.reputation === "fair").length;
  const repBad = rows.filter((r) => r.reputation === "bad").length;

  console.log(`\nAccount Health Dashboard\n`);
  console.log(`Total accounts: ${total}`);
  console.log(`  Warmup on:        ${warmupOn}`);
  console.log(`  Active (off):     ${active}`);
  console.log(`  Blocked:          ${blocked}`);
  console.log(`  Conn failed:      ${failedConn}`);
  console.log(`\nReputation (stat_warmup_score):`);
  console.log(`  Good:  ${repGood}`);
  console.log(`  Fair:  ${repFair}`);
  console.log(`  Bad:   ${repBad}`);

  console.log(`\nAction items:`);
  if (blocked) console.log(`  - ${blocked} accounts blocked/suspended — investigate before sending`);
  if (repBad) console.log(`  - ${repBad} accounts with bad reputation — consider pausing`);
  if (failedConn) console.log(`  - ${failedConn} accounts with connection failures — reconnect or replace`);
  if (!blocked && !repBad && !failedConn) console.log(`  - None; everything looks healthy.`);

  if (out) {
    writeFileSync(out, toCsv(rows));
    console.log(`\nWrote CSV to ${out} (${rows.length} rows)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
