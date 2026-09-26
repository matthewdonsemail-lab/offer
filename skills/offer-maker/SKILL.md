---
name: offer-maker
description: Build and edit offer funnels in offer — Twenty agencyOffers schema, editor tabs, quiz/calendly/pixel wiring, and preview flow. Use when creating offers, adding funnel fields, or debugging saves and previews.
---

# Offer Maker

An **offer** is one `agencyOffers` record in Twenty CRM plus a public funnel at
`/preview/general/:id`: landing hero + video + qualifier quiz → contact form →
`agencyLead` (QUALIFIED/DISQUALIFIED) → Calendly booking → booked thank-you
with videos. Everything is authored in the Offer Detail editor
(`frontend/src/pages/OfferDetailPage.tsx`) and persisted as `RAW_JSON`/`TEXT`
configs on the offer record.

## Object model (`agencyOffers`)

| Field | Type | Notes |
|-------|------|-------|
| title / name | TEXT | `name` doubles as `prospectId` lookup (`filter=name[eq]:id`) |
| heroH1 | TEXT | raw HTML from RichEditor, rendered verbatim |
| heroLede | RICH_TEXT | `{markdown, blocknote}` — markdown holds HTML + `{{area}}` |
| videoUrl | LINKS | `{primaryLinkLabel, primaryLinkUrl, secondaryLinks[]}` |
| status | SELECT | `DRAFT`/`ACTIVE`/`PAUSED` — **UPPER_CASE required** |
| ctaType | SELECT | `CONSULTATION`/`PRICING`/`CUSTOM` — **UPPER_CASE required**, stored only (funnel always ends in booking) |
| quizConfig | RAW_JSON | `QuizQuestion[]` with `dq`/`fbLead`/`nextQuestion` per option |
| thankYouConfig | RAW_JSON | badge, heading, `video` URL, video grid |
| disqualifiedConfig | RAW_JSON | same + `calendlyEmbed` (full inline widget HTML) |
| calendlyUrl | TEXT | qualified Calendly embed HTML (or bare URL) |
| metaPixelId | TEXT | per-offer Meta Pixel ID, empty = disabled |
| utmSwaps | RAW_JSON | `{default, rules[]}` per-UTM text overrides |

`agencyLeads` created by the funnel carry `qualificationStatus`
(`QUALIFIED` green / `DISQUALIFIED` red); contact details live in `note`
(the `EMAILS` type is finicky — never write it directly).

## Workflows

### Create a new offer field

1. Add an idempotent `backend/src/scripts/ensure-<name>-field.ts` (copy
   `ensure-quiz-field.ts`): `createOneField` on `agencyOffer`, then verify.
   SELECT option values **must** be UPPER_CASE or Twenty rejects them.
2. Whitelist the field in `backend/src/routes/offers.ts` POST **and** PATCH.
3. Add editor UI in the matching `OfferDetailPage` tab + hydrate in its
   `useEffect` + include in `buildData`.
4. Run it: `bun run --cwd backend src/scripts/ensure-<name>-field.ts`.

### Save errors (`Object agencyOffer doesn't have any "<field>"`)

The UI saves full payload first, then retries without extras on that 400 —
the toast still says success. If the console shows the retry warning, the
field is missing in Twenty: write/run the ensure script above instead of
working around it.

### Preview flow

- Preview route `/preview/:industryId/:id` (alias `/preview/offers/:id`, token
  forwarded if logged in); public funnel `/offer/:slug?` (mode `public`, no
  auth — visual payload from `GET /api/public/offers/:slug`, leads to
  `POST /api/public/leads`, editor chrome hidden). Editor saves broadcast
  `offer:saved:<id>` (localStorage + postMessage); preview also polls 20s.
- `{{area}}` resolves **only** from explicit `?area=` — never from a prospect,
  never hardcoded. No area → dashed `{{area}}` token. Use
  `frontend/src/lib/resolveTokens.ts` (single resolver for builder + preview).
- Bare `(like yours)` renders as a yellow `<mark>`; content already inside
  `<mark>` is left alone.
- Empty `heroLede` renders nothing (there is intentionally no fallback copy).
- `fbq('track', 'Lead')` fires only for quiz options with FB-lead checked,
  and only when `metaPixelId` is set.

### Booked state

`Quiz.tsx` listens for `calendly.event_scheduled` (origin-checked) → persists
`quiz_booking_${offerId}` → thank-you badge/heading + videos (1 main + 2×2
grid from `video` + grid items, falling back to the main demo video).
`PreviewPage` swaps the hero H1, hides the hero video + quiz, and scrolls to
the booked video. The floating pill has **Simulate booking** (same state, no
real booking) and **Reset quiz** (deletes the test lead, clears flags).

## Conventions

- No native `<select>` — dropdowns use `@floating-ui/react` + `FloatingPortal`.
- No backend internals in prospect-facing copy (no QUALIFIED/DISQUALIFIED
  badges, no `agencyLead`/Twenty mentions in `Quiz`).
- Loading states use the `Spokes` spinner, never "Loading..." text.
- `tsc` is clean (`npx tsc --noEmit --skipLibCheck`) — keep it that way;
  narrow `undefined` with guards, don't assert.
- `.env.local` holds secrets and is git-ignored — never commit it, never
  print keys. `TWENTY_BASE_URL` has no `/rest` suffix.
