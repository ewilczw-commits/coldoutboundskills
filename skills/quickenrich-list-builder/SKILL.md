---
name: quickenrich-list-builder
description: Use the QuickEnrich API for title-first contact search when you want a free-discovery-then-pay-per-email workflow, or specifically need to catch vertical SaaS companies that LinkedIn's industry taxonomy mis-tags (e.g. a fintech/proptech/healthtech SaaS company tagged under its customer's industry instead of "Software"). Outputs a CSV ready for /icp-prompt-builder and /smartlead-campaign-upload-public. Use when your targeting is title-first and industry taxonomy alone risks under-counting your real TAM.
---

# QuickEnrich List Builder

QuickEnrich splits contact discovery into two steps: a **free** discovery search (`contact-finder`) that returns candidates without charging credits, and a **paid** resolution step (`email-search`, 1 credit per match) that turns a discovered candidate into an actual email address. This makes it cheap to size a market before spending anything, and it's a useful complement to Prospeo when you specifically need to catch vertical SaaS companies that industry taxonomies miss.

## Why this exists alongside /prospeo-full-export

Both are title-first search. The difference that matters:

- **LinkedIn's `industry_linkedin` taxonomy tags a company by the vertical it sells into**, not by whether it's a software company. A health-tech SaaS company can be tagged `"Hospitals and Health Care"` instead of `"Software Development"`. Filtering by industry alone silently drops these companies from your list.
- QuickEnrich's `bio_li` field (the company's own LinkedIn "About" text) is **open-text**, not exact-match — so this script also runs a pass matching on words like "software"/"SaaS"/"platform" directly against how the company describes itself, independent of its assigned industry tag.
- The script runs **both passes and merges/dedupes them** (a union, not an AND) so you get everything correctly tagged by industry *plus* everything self-described as software but mistagged.

If you don't care about this distinction (e.g. you're targeting a non-software vertical where taxonomy tagging is accurate), Prospeo is equally valid and may have better coverage for that vertical — this skill's edge is specifically the vertical-SaaS blind spot.

## Prerequisites

- QuickEnrich API key (env: `QUICKENRICH_API_KEY`) — sign up at https://app.quickenrich.io
- API docs: https://app.quickenrich.io/docs

## Inputs

All list-valued flags are **semicolon-delimited (`;`), not comma-delimited** — several QuickEnrich industry labels themselves contain commas (e.g. `"Technology, Information and Internet"`), which would break comma-splitting.

- `--titles="A;B;C"` — semicolon-separated job titles (e.g. `"VP Marketing;Head of Growth;CMO"`)
- `--countries=US` — semicolon-separated ISO 2-letter country codes
- `--headcounts="5 - 19;20 - 99"` — semicolon-separated exact-match range labels. **Must match `GET /api/lookups/employee-ranges` exactly** (valid values as of writing: `"< 5"`, `"5 - 19"`, `"20 - 99"`, `"100 - 249"`, `"250 - 499"`, `"500 - 999"`, `"1000 - 4999"`, `"5000 - 9999"`, `">10000"`, `"Not Available"`)
- `--industries="A;B"` — semicolon-separated industry labels. **Must match `GET /api/lookups/industries` exactly**, or the API returns a 422. Run the lookup first if unsure of exact naming.
- `--bio-keywords="software;SaaS;platform"` — semicolon-separated open-text keywords matched against the company's LinkedIn About copy. Optional but recommended — see "Why this exists" above.
- `--limit=2000` — max leads to resolve emails for (this is your credit ceiling — see Cost below)
- `--out=leads.csv` — output path

Pass only `--industries`, only `--bio-keywords`, both, or neither (neither = title/headcount/country only, no industry-axis filter at all — will be very broad, use with caution).

## Outputs

CSV with columns: `email, first_name, last_name, full_name, role_title, linkedin_url, city, state, country, company_name, company_domain, company_industry, company_headcount, company_linkedin, email_status` — matches this repo's standard lead schema (same as `/prospeo-full-export`), so it plugs directly into `/icp-prompt-builder`, `/list-quality-scorecard`, and `/smartlead-campaign-upload-public` with no reformatting.

## Usage

```bash
export QUICKENRICH_API_KEY=xxx

# Size the market first, for free — check total counts before spending anything.
# (Run the same filters with --limit=1 and watch the console output; discovery never charges credits.)

# Full run: title-first search across both the industry-taxonomy axis and the
# self-described-software axis, merged and deduped
npx tsx scripts/quickenrich-contact-finder.ts \
  --titles="Founder;CEO;Co-Founder;CMO;VP Marketing;Head of Growth;Head of Demand Generation" \
  --countries=US \
  --headcounts="5 - 19;20 - 99" \
  --industries="Software Development;Technology, Information and Internet;IT Services and IT Consulting;Information Technology & Services" \
  --bio-keywords="software;SaaS;platform" \
  --limit=500 \
  --out=leads.csv
```

The script prints discovery counts and asks for `y/N` confirmation **before spending any credits** on email resolution — nothing is charged until you confirm.

## API overview

**Lookups** (use these to get exact-match values before filtering):
```
GET /api/lookups/industries              → array of valid industry_linkedin strings
GET /api/lookups/employee-ranges         → array of valid number_of_employees strings
GET /api/lookups/company-services?q=     → service autocomplete
```

**Discovery** (free — never charges credits):
```
POST /api/employees/contact-finder
Body: { title: {include: [...]}, country_code: {include: [...]}, number_of_employees: {include: [...]},
        industry_linkedin: {include: [...]}, bio_li: {include: [...]}, has_email: true, page, per_page }
Response: { data: [{ first_name, last_name, title, employee_linkedin, company_url, company_name,
                      industry, employee_count, city, region_code, country_code, ... }],
            meta: { total, last_page, next_cursor, has_more, credits_used: 0 } }
```

**Email resolution** (1 credit per successful match):
```
GET /api/employees/search?linkedin_url=...
Response: { data: { email, first_name, last_name, title, employee_linkedin, email_verification_date, ... },
            meta: { credits_used, remaining_credits } }
```

Auth: `Authorization: Bearer <QUICKENRICH_API_KEY>` on every request.

## Rate limiting

Per QuickEnrich's published limits: 1,000 req/min for search/phone/email endpoints, 300 req/min for domain search, 120 req/min for Contact Finder, 6,000 req/min on GTM Unlimited plans across all endpoints. The script sleeps 150-200ms between calls, well under these ceilings for normal use.

## Common gotchas

- **`industry_linkedin` and `headcounts` are exact-match, not fuzzy.** A near-miss string returns a 422, not a partial match. Always pull `GET /api/lookups/industries` and `/api/lookups/employee-ranges` first if you're not certain of exact values.
- **Industry taxonomy under-counts vertical SaaS.** This is the whole reason the `--bio-keywords` pass exists — see "Why this exists" above. Skipping it will silently miss fintech/proptech/healthtech/insurtech-style companies.
- **Dropping the industry axis entirely (`--industries` and `--bio-keywords` both empty) is very broad.** Without any industry-axis filter, "Founder"/"CEO" + headcount + country matches literally any small business in that country, not just your target vertical. Only do this deliberately.
- **`has_email: true` is hardcoded** in the discovery filter to avoid wasting resolution calls on candidates QuickEnrich has no email data for. This does mean the discovery count already excludes contacts without any email on file — that's intentional, not a bug.
- **The two-pass merge is a union of results, not an intersection.** If you pass both `--industries` and `--bio-keywords`, expect the total unique count to be somewhere between the larger single-pass count and the sum of both — check the console output, which reports per-pass totals before merging.

## Required step: Qualify with /icp-prompt-builder

**This is a required step. Do not skip it**, same as every other list-building skill in this repo.

Before spending resolution credits on more than a small sample, run `/icp-prompt-builder` against ~50 discovered candidates (discovery is free, so you can sample generously before resolving):

1. Evaluates the first 10 with an AI qualification prompt
2. You give corrections ("this one should be NO, wrong vertical")
3. Refines the prompt, runs the next 10
4. Stops after 2 rounds with zero corrections — prompt is tuned
5. Apply the tuned prompt before spending resolution credits on the full batch

**Why it's required:** discovery is free, but each resolved email costs a credit. If 40% of your discovered pool is wrong-fit (a real risk with the `--bio-keywords` pass, which is intentionally loose), you burn credits resolving emails for companies that will never convert.

## Cost

Discovery (`contact-finder`) is **always free** — 0 credits regardless of volume. Only `email-search` charges, and only on a successful match (1 credit each). Check `meta.remaining_credits` in any response to see your balance before committing to a large resolution run.

## Output → next step

1. **Qualify** — run `/icp-prompt-builder` on a discovery sample before resolving (see above)
2. **Resolve** — run the script for real with your tuned filters
3. **Deduplicate** — the script already dedupes by email, but re-check after merging with other sources
4. **Grade** — run `/list-quality-scorecard` on the output CSV
5. **Upload** — pass to Smartlead via `/smartlead-campaign-upload-public`

## Scripts

- `scripts/quickenrich-contact-finder.ts` — two-pass discovery + email resolution, single script

## What to do next

**Run `/list-quality-scorecard`** on the output CSV before sending. If quality looks off (data quality note: QuickEnrich occasionally returns inconsistent geo data — a US-filtered result with a non-US-looking city/state is a known quirk worth spot-checking), tighten filters and re-run discovery (free) before spending more resolution credits.

**Or wait:** if `/icp-prompt-builder` showed a low qualification rate on your discovery sample, your filters are too loose — tighten `--bio-keywords` or add `--industries` back before resolving more emails.

## Related skills

- `/prospeo-full-export` — the other title-first list builder; better default choice when industry taxonomy isn't a known blind spot for your vertical
- `/icp-prompt-builder` — required qualification step before spending resolution credits
- `/list-quality-scorecard` — grade the output CSV before sending
- `/blitz-list-builder` — domain-first alternative when you already know target companies
- `/disco-like` — lookalike company discovery from seed domains
- `/smartlead-campaign-upload-public` — upload the final qualified CSV
