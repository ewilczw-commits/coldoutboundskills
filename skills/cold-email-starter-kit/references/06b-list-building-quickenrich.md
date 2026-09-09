---
name: quickenrich-list-builder
description: Alternative to 06-list-building-prospeo.md — title-first contact search via QuickEnrich, with a free discovery step and pay-per-resolved-email pricing, plus a pass that catches vertical SaaS companies LinkedIn's industry taxonomy mistags.
---

# 06b — List Building with QuickEnrich

Alternative to Prospeo for title-first search. Read `06-list-building-prospeo.md` first if you haven't — this doc only covers what's different.

## Why reach for this instead of Prospeo

- **Free discovery.** QuickEnrich splits search into a free discovery step (`contact-finder`) and a paid resolution step (`employees/search`, 1 credit per resolved email). You can size a market — see the total match count — before spending anything. Prospeo charges 1 credit per page regardless of whether you resolve emails.
- **Catches vertical SaaS Prospeo-style industry filters miss.** LinkedIn's industry taxonomy tags a company by the vertical it sells *into* (e.g. "Accounting", "Banking", "Hospitals and Health Care"), not by whether it's a software company. A fintech/proptech/healthtech SaaS company is often mistagged under its customer's industry instead of "Software Development" — this happens on both Prospeo and QuickEnrich, since it's a LinkedIn data issue, not a provider issue. QuickEnrich's `bio_li` field (the company's own LinkedIn "About" text) is open-text, not exact-match, so `scripts/quickenrich-contact-finder.ts` runs a second discovery pass matching words like "software"/"SaaS"/"platform" directly against how the company describes itself — independent of its assigned industry tag — then merges both passes (a union, not an intersection).

If you don't need that distinction (e.g. you're targeting a non-software vertical where taxonomy tagging isn't a concern), Prospeo is equally valid and may have better raw coverage.

## Setup (First Time Only)

1. Sign up at [app.quickenrich.io](https://app.quickenrich.io)
2. Copy your API key from the dashboard
3. Add it to `.env`: `QUICKENRICH_API_KEY=your_key_here`

## How to Use

```bash
npx tsx scripts/quickenrich-contact-finder.ts \
  --title "VP Marketing" --title "Head of Growth" --title "CMO" \
  --country US \
  --headcount "5 - 19" --headcount "20 - 99" \
  --industry "Software Development" --industry "Information Technology & Services" \
  --bio-keyword "software" --bio-keyword "SaaS" --bio-keyword "platform" \
  --limit 2000 \
  --output leads.csv
```

Repeat `--title`, `--country`, `--headcount`, `--industry`, or `--bio-keyword` flags for multiple values (matches this repo's `--flag "value"` convention — see `prospeo-full-export.ts`).

The script prints discovery counts and asks for `y/N` confirmation **before spending any credits** — nothing is charged until you confirm.

## Filter Reference

`--industry` and `--headcount` are **exact-match**, not fuzzy. A near-miss string returns a 422. Pull the valid values first:

```bash
curl -H "Authorization: Bearer $QUICKENRICH_API_KEY" https://app.quickenrich.io/api/lookups/industries
curl -H "Authorization: Bearer $QUICKENRICH_API_KEY" https://app.quickenrich.io/api/lookups/employee-ranges
```

Valid `--headcount` values as of writing: `"< 5"`, `"5 - 19"`, `"20 - 99"`, `"100 - 249"`, `"250 - 499"`, `"500 - 999"`, `"1000 - 4999"`, `"5000 - 9999"`, `">10000"`, `"Not Available"`.

`--bio-keyword` is open-text — no lookup needed, just plain words matched against company LinkedIn "About" copy.

## API Overview

**Discovery (free):**
```
POST https://app.quickenrich.io/api/employees/contact-finder
Auth: Authorization: Bearer <QUICKENRICH_API_KEY>
Body: { title: {include:[...]}, country_code: {include:[...]}, number_of_employees: {include:[...]},
        industry_linkedin: {include:[...]}, bio_li: {include:[...]}, has_email: true, page, per_page }
Response: { data: [...], meta: { total, last_page, next_cursor, has_more, credits_used: 0 } }
```

**Resolution (1 credit per match):**
```
GET https://app.quickenrich.io/api/employees/search?linkedin_url=...
Response: { data: { email, email_verification_date, ... }, meta: { credits_used, remaining_credits } }
```

## Common Gotchas

- **Industry taxonomy under-counts vertical SaaS** — this is the whole reason `--bio-keyword` exists. Skipping it will silently miss fintech/proptech/healthtech-style companies.
- **Dropping both `--industry` and `--bio-keyword` is very broad** — without an industry-axis filter, title + headcount + country matches any small business in that country, not just software. Only do this deliberately.
- **A couple of geo data quirks have been observed** — occasionally a US-filtered result returns a non-US-looking city/state. Worth a spot-check via `/list-quality-scorecard`, same as any provider's output.

## Required step: Qualify with /icp-prompt-builder

Same requirement as every other list-building path in this repo — see `06-list-building-prospeo.md` for why. Discovery is free here, so sample generously before spending resolution credits.

## Cost Estimation

Discovery is always free regardless of volume. Only resolved emails cost credits (1 each, only on a successful match). Check `meta.remaining_credits` in any response before committing to a large run.

## Requirements

Same as `06-list-building-prospeo.md` — Node.js 18+, `tsx`, no other dependencies.

## Related

- `06-list-building-prospeo.md` — the default title-first option
- `/quickenrich-list-builder` — the standalone skill version of this same script, for use outside the starter-kit tutorial flow
- `/icp-prompt-builder` — required qualification step before spending resolution credits
- `/list-quality-scorecard` — grade the output CSV before sending
