#!/usr/bin/env tsx
/**
 * Bulk enable/disable warmup on Instantly accounts.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/set-warmup.ts --mode=enable --tag=new --warmup-limit=40 --reply-rate=20 --increment=2
 *   npx tsx scripts/set-warmup.ts --mode=disable --tag=active
 *   npx tsx scripts/set-warmup.ts --mode=insurance --tag=insurance
 *
 * Selector flags (pick one): --all, --emails=a@x.com,b@y.com, --domain=example.com, --tag=active, --emails-from-csv=path
 * Mode:
 *   --mode=enable       warmup on, full ramp (default: limit=40, reply-rate=20, increment=2)
 *   --mode=disable      warmup off
 *   --mode=insurance    warmup on, low maintenance (limit=15, reply-rate=20, increment=disabled)
 *
 * IMPORTANT DIFFERENCE FROM /smartlead-inbox-manager: Instantly's warmup ramp is a
 * discrete level enum (--increment=disabled|0|1|2|3|4), NOT a literal per-day email
 * count like Smartlead's --ramp=5. There is no documented mapping between "level 2"
 * and an exact daily increment — Instantly controls that internally. Don't try to
 * translate a specific Smartlead ramp number 1:1 into an Instantly increment level.
 *
 * Two-step API flow (verified against Instantly's live OpenAPI spec, but NOT tested
 * against a real account — this workspace had zero connected accounts at build time):
 *   1. PATCH /accounts/{email} with { warmup: { limit, reply_rate, increment } } — per account
 *   2. POST /accounts/warmup/enable or /disable with { emails: [...] } — one bulk call
 */

import { API_BASE, API_KEY, parseFlag, selectAccounts, runWithConcurrency, fetchJson } from "./_lib";

async function main() {
  const args = process.argv.slice(2);
  const mode = parseFlag(args, "--mode");
  if (!mode || !["enable", "disable", "insurance"].includes(mode)) {
    console.error("Usage: --mode=enable|disable|insurance [selector flags] [--warmup-limit=N] [--reply-rate=N] [--increment=disabled|0-4]");
    process.exit(1);
  }

  const warmupLimit = Number(parseFlag(args, "--warmup-limit") ?? (mode === "insurance" ? 15 : 40));
  const replyRate = Number(parseFlag(args, "--reply-rate") ?? "20");
  const increment = parseFlag(args, "--increment") ?? (mode === "insurance" ? "disabled" : "2");

  console.error(`Selecting accounts...`);
  const accounts = await selectAccounts(args);
  console.error(`Matched ${accounts.length} accounts. Mode: ${mode}`);
  if (accounts.length === 0) {
    console.error("No accounts matched; nothing to do.");
    return;
  }

  const emails = accounts.map((a) => a.email);

  if (mode === "disable") {
    console.error(`Disabling warmup for ${emails.length} accounts in 3s... (Ctrl+C to abort)`);
    await new Promise((r) => setTimeout(r, 3000));
    await fetchJson(`${API_BASE}/accounts/warmup/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });
    console.error(`Done. Warmup disabled for ${emails.length} accounts.`);
    return;
  }

  console.error(`Config: limit=${warmupLimit}, reply_rate=${replyRate}, increment=${increment}`);
  console.error(`Applying config then enabling warmup for ${emails.length} accounts in 3s... (Ctrl+C to abort)`);
  await new Promise((r) => setTimeout(r, 3000));

  let ok = 0;
  let fail = 0;
  await runWithConcurrency(accounts, 5, async (account, i) => {
    try {
      await fetchJson(`${API_BASE}/accounts/${encodeURIComponent(account.email)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warmup: { limit: warmupLimit, reply_rate: replyRate, increment } }),
      });
      ok++;
      if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${accounts.length} configured`);
    } catch (err) {
      fail++;
      console.error(`  [${account.email}] ${String(err).slice(0, 200)}`);
    }
  });
  console.error(`Config applied: ${ok} ok, ${fail} failed.`);

  await fetchJson(`${API_BASE}/accounts/warmup/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emails }),
  });
  console.error(`\nDone. Warmup enabled for ${emails.length} accounts.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
