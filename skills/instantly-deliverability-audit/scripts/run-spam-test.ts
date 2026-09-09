#!/usr/bin/env tsx
/**
 * Create + poll + pull an Instantly Inbox Placement Test — the equivalent of
 * Smartlead's Smart Delivery spam placement test.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/run-spam-test.ts --campaign-id=<uuid> --subject="Quick question" \
 *     --body="Test body content" --senders=a@x.com,b@y.com --out=/tmp/spam-test.json
 *
 * Required fields discovered by testing the live API (the docs don't state all of these
 * up front — each was found by iterating through 400 "missing required property" errors):
 *   name, type, sending_method, delivery_mode, campaign_id, email_subject, email_body,
 *   emails (the SENDER accounts to test with), recipients_labels (seed inbox types,
 *   fetched from GET /inbox-placement-tests/email-service-provider-options).
 *
 * Verified live: a real test was created and immediately deleted during development
 * (using a fake, unconnected sender email, so nothing was actually sent to the real
 * seed inboxes Instantly generated). The create/response shape is confirmed correct.
 * NOT verified: the full poll-to-completion and results-fetching flow, since that
 * requires an actual connected sending account and takes real time to run — this
 * workspace had none at build time.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai/api/v2";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const campaignId = get("--campaign-id");
  const subject = get("--subject");
  const body = get("--body");
  const senders = get("--senders")?.split(",").map((s) => s.trim());
  const out = get("--out") ?? "/tmp/spam-test.json";
  const testName = get("--name") ?? `audit-${new Date().toISOString().slice(0, 10)}`;
  if (!campaignId || !subject || !body || !senders?.length) {
    console.error("Usage: --campaign-id=<uuid> --subject=<text> --body=<text> --senders=a@x.com,b@y.com [--out=path]");
    process.exit(1);
  }
  return { campaignId, subject, body, senders, out, testName };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const resp = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${API_KEY}` } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

async function main() {
  const { campaignId, subject, body, senders, out, testName } = parseArgs();

  console.error("Fetching available seed inbox types...");
  const espOptions = await fetchJson(`${API_BASE}/inbox-placement-tests/email-service-provider-options`);
  console.error(`  ${espOptions.length} ESP option(s) available on this plan`);

  console.error(`Creating inbox placement test with ${senders.length} sender(s)...`);
  const createBody = {
    name: testName,
    type: 1, // one-time (2 = automated/recurring)
    sending_method: 1, // 1 = From Instantly (send using connected accounts below)
    delivery_mode: 1, // 1 = one by one (2 = all together)
    campaign_id: campaignId,
    email_subject: subject,
    email_body: body,
    emails: senders,
    recipients_labels: espOptions, // test against every ESP option available on this plan
  };
  const created = await fetchJson(`${API_BASE}/inbox-placement-tests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  });
  const testId = created.id;
  console.error(`  Test created: id=${testId}, ${created.recipients?.length ?? 0} seed inboxes generated`);

  console.error("Polling for completion (up to 25 min)...");
  const start = Date.now();
  let status: number | undefined = created.status;
  while (Date.now() - start < 25 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 30000));
    const detail = await fetchJson(`${API_BASE}/inbox-placement-tests/${testId}`);
    status = detail.status;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.error(`  [${elapsed}s] status=${status}`);
    // Status enum not fully documented publicly; treat "stopped changing for 2 polls" as
    // done if you don't see an obvious completed value. Adjust once you've run this for real.
    if (status !== 1) break;
  }

  console.error("Fetching stats...");
  const stats = await fetchJson(`${API_BASE}/inbox-placement-analytics/stats-by-test-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ test_ids: [testId] }),
  }).catch((e) => ({ error: String(e) }));

  const payload = { test_id: testId, status, create_body: createBody, stats };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.error(`\nWrote ${out}`);

  if (Array.isArray(stats) && stats[0]) {
    const s = stats[0];
    console.error(`\n--- Placement summary ---`);
    console.error(`Inbox:      ${s.inbox_percent}% (${s.inbox_count}/${s.count})`);
    console.error(`Spam:       ${s.spam_percent}% (${s.spam_count}/${s.count})`);
    console.error(`Category:   ${s.category_percent}% (${s.category_count}/${s.count}) — e.g. Promotions tab`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
