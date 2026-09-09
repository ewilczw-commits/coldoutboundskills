#!/usr/bin/env tsx
/**
 * Bulk apply signatures to Instantly accounts.
 *
 * Same default template and env vars as /smartlead-inbox-manager/scripts/set-signatures.ts:
 *   SENDER_FIRST_NAME, SENDER_LAST_NAME, SENDER_TITLE, SENDER_COMPANY_NAME, SENDER_PHYSICAL_ADDRESS
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/set-signatures.ts --all
 *   npx tsx scripts/set-signatures.ts --tag=active
 *   npx tsx scripts/set-signatures.ts --all --template="Cheers,\n{from_name}\n{title}\n{company}"
 *   npx tsx scripts/set-signatures.ts --all --template-file=./my-signature.txt
 *
 * Placeholders: {from_name} {from_email} {domain} {title} {company} {address}
 *
 * API: PATCH /accounts/{email} with { signature: "..." } — verified against Instantly's
 * live OpenAPI spec (signature is a plain string field), but NOT tested against a real
 * account mutation — this workspace had zero connected accounts at build time.
 *
 * DIFFERENCE FROM SMARTLEAD VERSION: Instantly has no separate `from_name` field on the
 * account object the way Smartlead does (no per-inbox display-name override exposed in
 * the account schema found). This script falls back straight to SENDER_FIRST_NAME +
 * SENDER_LAST_NAME for {from_name} on every account — there's no per-account persona
 * override available here.
 */

import { readFileSync } from "fs";
import { API_BASE, parseFlag, selectAccounts, runWithConcurrency, fetchJson } from "./_lib";

const DEFAULT_TEMPLATE = "{from_name}\n{title}\n{company}\n{address}";

function envOrThrow(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v && v.trim()) return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env: ${key}. Set it in .env — required for the default signature template.`);
}

function renderSignature(account: any, template: string, senderFullName: string, title: string, company: string, address: string): string {
  const email = account.email || "";
  const domain = email.split("@")[1] || "";
  return template
    .replace(/\{from_name\}/g, senderFullName)
    .replace(/\{from_email\}/g, email)
    .replace(/\{domain\}/g, domain)
    .replace(/\{title\}/g, title)
    .replace(/\{company\}/g, company)
    .replace(/\{address\}/g, address)
    .replace(/\\n/g, "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const templateFile = parseFlag(args, "--template-file");
  const templateArg = parseFlag(args, "--template");
  const template = templateFile ? readFileSync(templateFile, "utf8") : templateArg ?? DEFAULT_TEMPLATE;

  const usesTitle = /\{title\}/.test(template);
  const usesCompany = /\{company\}/.test(template);
  const usesAddress = /\{address\}/.test(template);
  const usesFromName = /\{from_name\}/.test(template);

  const firstName = usesFromName ? envOrThrow("SENDER_FIRST_NAME", "") : "";
  const lastName = usesFromName ? envOrThrow("SENDER_LAST_NAME", "") : "";
  const title = usesTitle ? envOrThrow("SENDER_TITLE") : "";
  const company = usesCompany ? envOrThrow("SENDER_COMPANY_NAME") : "";
  const address = usesAddress ? envOrThrow("SENDER_PHYSICAL_ADDRESS") : "";
  const senderFullName = [firstName, lastName].filter(Boolean).join(" ");

  console.error(`Selecting accounts...`);
  const accounts = await selectAccounts(args);
  console.error(`Matched ${accounts.length} accounts`);
  if (!accounts.length) return;

  const sample = renderSignature(accounts[0], template, senderFullName, title, company, address);
  console.error(`\nSample signature that will be applied to ${accounts[0].email}:\n---\n${sample}\n---`);
  console.error(`\nApplying to ${accounts.length} accounts in 5s... (Ctrl+C to abort)`);
  await new Promise((r) => setTimeout(r, 5000));

  let ok = 0;
  let fail = 0;
  await runWithConcurrency(accounts, 5, async (account, i) => {
    try {
      await fetchJson(`${API_BASE}/accounts/${encodeURIComponent(account.email)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: renderSignature(account, template, senderFullName, title, company, address) }),
      });
      ok++;
      if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${accounts.length} processed`);
    } catch (err) {
      fail++;
      console.error(`  [${account.email}] ${String(err).slice(0, 200)}`);
    }
  });

  console.error(`\nDone. ${ok} updated, ${fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
