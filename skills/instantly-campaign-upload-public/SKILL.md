---
name: instantly-campaign-upload-public
description: Upload a CSV of leads + a variants YAML (produced by /campaign-copywriting) to Instantly as a DRAFT campaign. Alternative to /smartlead-campaign-upload-public for Instantly users — same variants.yaml schema, same leads.csv schema. Handles tag-based inbox selection, A/B/C variant assembly, and batch lead upload. ALWAYS creates in DRAFT (Instantly status=0) — you review in the Instantly UI and hit Start manually. Use after /campaign-copywriting, just before the campaign goes live.
---

# Instantly Campaign Upload

Takes a `variants.yaml` (written by `/campaign-copywriting`) and a `leads.csv` (from your list-building skills) and creates a DRAFT campaign in Instantly. You review the result in the Instantly UI and press Start manually.

This is the Instantly equivalent of `/smartlead-campaign-upload-public` — same input schemas, same DRAFT-only philosophy, different API underneath. If you're on Smartlead, use that skill instead.

**This skill does NOT ship any email copy.** Copy comes from `/campaign-copywriting`. This skill is the mechanical upload layer — API calls only.

## Why DRAFT only

Cold email launches should never happen from a script. Instantly campaigns are created with `status: 0` (Draft) by default — the API has no "activate at creation" flag, so this happens naturally. You review in the Instantly UI:
- Subject lines + body previews
- Inbox assignments (correct tag? correct count?)
- Lead count and a few random lead rows
- Schedule (timezone + hours + throttle)

Then hit Start in the UI.

## Inputs

Identical to `/smartlead-campaign-upload-public` — see that skill's `references/leads-csv-schema.md` for the full `leads.csv` column spec, and `references/variants-schema.yaml` for the `variants.yaml` schema. This skill reads the exact same files; you don't need separate copies for Smartlead vs Instantly.

## Usage

```bash
export INSTANTLY_API_KEY=xxx
npx tsx scripts/upload.ts \
  --leads=profiles/<slug>/campaigns/<campaign-slug>/leads.csv \
  --variants=profiles/<slug>/campaigns/<campaign-slug>/variants.yaml
```

Output:
```
Campaign <uuid> created in DRAFT

Review + Start:
  -> https://app.instantly.ai/app/campaign/<uuid>

This script does NOT auto-activate. Review the campaign in the Instantly UI and hit Start when satisfied.
```

## Script flow

1. Load env (`INSTANTLY_API_KEY` required)
2. Parse `leads.csv` — validate required columns, count rows
3. Parse `variants.yaml` — same minimal parser as the Smartlead version
4. Select accounts by tag (`GET /accounts?include_tags=true`), filter to `status: 1` (Active) and not banned/suspended, sort by `timestamp_updated` ascending (LRU proxy — see gotcha below)
5. `POST /campaigns` — **one call** creates the campaign with schedule, sequences, and `email_list` all embedded (Instantly doesn't need Smartlead's separate `/sequences`, `/email-accounts`, `/schedule` calls)
6. Batch-upload leads via `POST /leads/add` (100 per batch, verified up to 1,000/batch max)
7. Print campaign URL. **Do NOT activate.**

## Two real API quirks this script handles (verified live before shipping)

### 1. Timezone aliasing

Instantly's `campaign_schedule.schedules[].timezone` only accepts ~102 specific IANA strings — a deduped list, not the full IANA database. Common US zone names are silently **rejected** even though they're valid IANA elsewhere:

| Your variants.yaml says | Instantly actually wants |
|---|---|
| `America/New_York` | `America/Detroit` (identical rules, different label) |
| `America/Denver` | `America/Boise` (identical rules) |
| `America/Phoenix` | `America/Creston` (fixed MST, no DST — identical rules) |
| `America/Chicago` | `America/Chicago` (no change) |
| `America/Los_Angeles` | **No equivalent exists.** Confirmed by checking the full 102-value enum — Pacific time isn't represented by any zone in Instantly's list. |

The script auto-aliases the first three. If you specify a Pacific-time zone, it errors out with a clear message rather than silently picking a wrong-offset substitute — you'll need to pick a different zone and manually adjust `start_hour`/`end_hour`, or set up that schedule by hand in the Instantly UI.

If Instantly adds Pacific-time support later, or you find a zone works, add it to `TIMEZONE_ALIASES` in `scripts/upload.ts`.

### 2. Body HTML stripping

A bare `<br/>` or `<br>` mixed with un-wrapped plain text in a body field gets **silently stripped by Instantly's API** — everything except the tag itself disappears. Verified directly: sending `"Hello there<br/>Second line"` came back as `"<br />"` — the actual words were gone.

`<br/>` only survives when wrapped inside a block element (`<div>`, `<p>`). This script always wraps every body in `<div>...</div>` with `<br/>` between lines, which was verified to preserve content correctly.

## Gotchas

- **Tag must exist and be applied to accounts first.** Use `/instantly-inbox-manager` to tag accounts as `active` before running this upload.
- **No true LRU sort.** Instantly's account list doesn't expose a per-day sent-count field the way Smartlead does. This script sorts by `timestamp_updated` ascending as an approximation, not a true send-volume LRU.
- **Inbox count.** If `inbox_selection.count` exceeds tagged accounts, the script attaches all available and warns.
- **Leads CSV size.** `POST /leads/add` caps at 1,000 leads/request; this script batches at 100 for parity with the Smartlead script and gentler rate-limit behavior.
- **Email duplicates.** Instantly's `/leads/add` response reports `duplicated_leads` — the script surfaces this count. Still, dedupe your CSV first with `/list-quality-scorecard`.
- **This script was validated end-to-end against the live Instantly API** (campaign creation, timezone/day mapping, body wrapping, bulk lead upload) — but inbox selection specifically was tested against an **empty** workspace (no connected accounts existed at build time). The selection logic itself is straightforward filtering, but test it against your real tagged accounts before trusting it at scale.

## What to do next

**Open the Instantly URL printed at the end. Review the campaign. Hit Start when satisfied.** The script deliberately does not auto-activate.

After Start:
- Wait 21 days, then run `/positive-reply-scoring` on the campaign to measure (note: that skill currently targets Smartlead only).
- Every Monday: run `/email-deliverability-audit --days=7` (currently Smartlead-only; Instantly equivalent not yet built).

**Or wait:** if the best-practice check flagged issues, go back to `/campaign-copywriting` and revise before uploading.

## Related skills

- `/campaign-copywriting` — produces `variants.yaml`
- `/instantly-inbox-manager` — required prep: accounts must be tagged `active` before upload
- `/smartlead-campaign-upload-public` — the Smartlead equivalent; same input schemas
- `/list-quality-scorecard` — dedupe + verify leads.csv before upload

## Files

- `scripts/upload.ts` — the upload script
- Uses `/smartlead-campaign-upload-public/references/variants-schema.yaml` and `references/leads-csv-schema.md` — no separate copies maintained here, to avoid schema drift between the two platforms' upload skills.
