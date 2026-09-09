#!/usr/bin/env tsx
/**
 * Aggregate classified replies into positive reply rate metrics — Instantly version.
 *
 * Identical scoring logic to the Smartlead version (same labels, same formulas,
 * same benchmarks). Only difference: fetches total_sent from Instantly's
 * GET /campaigns/analytics?id=<uuid> (emails_sent_count field) instead of
 * Smartlead's /campaigns/{id}/statistics.
 *
 * Input: JSON array of { lead_id, label, confidence?, reason? } from Claude classification.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/aggregate-scores.ts --replies=/tmp/classified-replies.json --campaign-id=<uuid>
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const replies = get("--replies");
  const campaignId = get("--campaign-id");
  const out = get("--out");
  if (!replies || !campaignId) {
    console.error("Usage: --replies=/tmp/classified-replies.json --campaign-id=<uuid> [--out=path]");
    process.exit(1);
  }
  return { replies, campaignId, out };
}

const POSITIVE_LABELS = new Set(["positive_interested", "positive_soft", "positive_referral"]);
const EXCLUDED_FROM_DENOMINATOR = new Set(["ooo", "bounce"]);

async function fetchCampaignStats(campaignId: string): Promise<{ sent: number; replyCountAutomatic: number }> {
  if (!API_KEY) throw new Error("INSTANTLY_API_KEY not set");
  const qs = new URLSearchParams({ id: campaignId });
  const resp = await fetch(`${API_BASE}/campaigns/analytics?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
  const data = await resp.json();
  // Response is an array (one entry per campaign_id queried), even for a single id.
  const row = Array.isArray(data) ? data[0] : data;
  return {
    sent: Number(row?.emails_sent_count ?? 0),
    replyCountAutomatic: Number(row?.reply_count_automatic ?? 0),
  };
}

function pct(n: number, d: number): string {
  if (d === 0) return "0.00%";
  return `${((n / d) * 100).toFixed(2)}%`;
}

async function main() {
  const { replies: replyPath, campaignId, out } = parseArgs();
  const classified: { lead_id: string; label: string; confidence?: number; reason?: string }[] =
    JSON.parse(readFileSync(replyPath, "utf8"));

  const { sent, replyCountAutomatic } = await fetchCampaignStats(campaignId);

  const buckets: Record<string, number> = {};
  for (const r of classified) {
    buckets[r.label] = (buckets[r.label] ?? 0) + 1;
  }

  const totalReplies = classified.length;
  const excluded = Object.entries(buckets)
    .filter(([label]) => EXCLUDED_FROM_DENOMINATOR.has(label))
    .reduce((s, [, n]) => s + n, 0);
  const netReplies = totalReplies - excluded;
  const positive = Object.entries(buckets)
    .filter(([label]) => POSITIVE_LABELS.has(label))
    .reduce((s, [, n]) => s + n, 0);
  const hostile = buckets["negative_hostile"] ?? 0;
  const unsub = buckets["unsubscribe"] ?? 0;

  const report = {
    campaign_id: campaignId,
    generated_at: new Date().toISOString(),
    total_sent: sent,
    total_replies: totalReplies,
    net_replies: netReplies,
    excluded_ooo_bounce: excluded,
    buckets,
    positive_replies: positive,
    positive_reply_rate: sent ? positive / sent : 0,
    positive_share_of_replies: netReplies ? positive / netReplies : 0,
    hostile_rate: sent ? hostile / sent : 0,
    unsub_rate: sent ? unsub / sent : 0,
    // Cross-check only — this skill classifies independently via Claude rather than
    // trusting either platform's built-in detection. A big gap between this and our
    // own `ooo` bucket count is worth a second look.
    instantly_auto_detected_replies: replyCountAutomatic,
  };

  console.log(`\nCampaign ${campaignId} — Positive Reply Scoring\n`);
  console.log(`Total sent:              ${sent.toLocaleString()}`);
  console.log(`Total replies:           ${totalReplies.toLocaleString()} (${pct(totalReplies, sent)})`);
  console.log(`  ooo/bounce (excluded):    ${excluded}`);
  console.log(`  Net replies:             ${netReplies}`);
  console.log(`\nBreakdown:`);
  const order = [
    "positive_interested", "positive_soft", "positive_referral", "neutral_question",
    "negative_notnow", "negative_notfit", "negative_hostile", "unsubscribe", "ooo", "bounce", "other",
  ];
  for (const label of order) {
    if (buckets[label] !== undefined) {
      console.log(`  ${label.padEnd(22)} ${String(buckets[label]).padStart(4)}`);
    }
  }
  console.log(`\nPositive reply rate:     ${pct(positive, sent)}  (${positive} / ${sent.toLocaleString()})`);
  console.log(`Positive % of replies:   ${pct(positive, netReplies)}  (${positive} / ${netReplies})`);
  console.log(`Negative hostile rate:   ${pct(hostile, sent)}`);
  console.log(`Unsub rate:              ${pct(unsub, sent)}`);
  console.log(`\nInstantly's own auto-reply detection: ${replyCountAutomatic} (cross-check only, not used in scoring above)`);

  console.log(`\nBenchmarks (B2B cold email):`);
  console.log(`  Good positive reply rate: ≥1%`);
  console.log(`  Great: ≥2%`);
  console.log(`  Hostile >0.3% or unsub >2% → deliverability risk, pause campaign`);

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nWrote JSON report to ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
