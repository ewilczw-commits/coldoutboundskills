#!/usr/bin/env tsx
/**
 * Bulk add/remove tags on Instantly accounts.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/tag-inboxes.ts --tag=new --add-tag=insurance
 *   npx tsx scripts/tag-inboxes.ts --tag=insurance --remove-tag=insurance --add-tag=active
 *   npx tsx scripts/tag-inboxes.ts --emails=a@x.com,b@y.com --add-tag=active
 *
 * Selector flags: --all, --emails=..., --domain=..., --tag=..., --emails-from-csv=path
 * Actions (can combine): --add-tag=label, --remove-tag=label
 *
 * DIFFERENCES FROM /smartlead-inbox-manager:
 *   - Instantly tags are workspace-level objects (POST /custom-tags), not free-text
 *     strings — this script creates the tag automatically if it doesn't exist yet
 *     (see resolveOrCreateTag in _lib.ts).
 *   - No color support — Instantly's CustomTag schema has no color field.
 *   - Assign/unassign is a single bulk call (POST /custom-tags/toggle-resource) rather
 *     than Smartlead's "replace the whole tag list" per-account pattern.
 *   - Account tagging uses email addresses as resource_ids — confirmed by probing the
 *     endpoint with a fake email and getting a "not found" (not a format) error. See
 *     the comment on toggleAccountTag in _lib.ts. Not yet round-tripped against a real
 *     account, since this workspace had zero connected accounts at build time.
 */

import { parseFlag, selectAccounts, toggleAccountTag } from "./_lib";

async function main() {
  const args = process.argv.slice(2);
  const addTag = parseFlag(args, "--add-tag");
  const removeTag = parseFlag(args, "--remove-tag");
  if (!addTag && !removeTag) {
    console.error("Provide --add-tag=label and/or --remove-tag=label");
    process.exit(1);
  }

  console.error(`Selecting accounts...`);
  const accounts = await selectAccounts(args);
  console.error(`Matched ${accounts.length} accounts`);
  if (!accounts.length) return;

  console.error(`Actions: add=${addTag ?? "-"}  remove=${removeTag ?? "-"}`);
  console.error(`Proceeding in 3s...`);
  await new Promise((r) => setTimeout(r, 3000));

  const emails = accounts.map((a) => a.email);

  try {
    if (removeTag) {
      await toggleAccountTag(emails, removeTag, false);
      console.error(`  Unassigned "${removeTag}" from ${emails.length} accounts`);
    }
    if (addTag) {
      await toggleAccountTag(emails, addTag, true);
      console.error(`  Assigned "${addTag}" to ${emails.length} accounts`);
    }
    console.error(`\nDone.`);
  } catch (err) {
    console.error(`\nFAILED: ${String(err).slice(0, 300)}`);
    console.error(`If this is an unexpected error, check the resource_ids-format assumption documented in _lib.ts's toggleAccountTag.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
