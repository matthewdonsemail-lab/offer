# Open Offer Builder

> 🎥 **Watch the walkthrough:** https://x.com/matthewsoldit/status/2097482754724389058

Hi — I'm **Matthew**, a Sales Engineer. I like contributing and building out
GTM systems that let me do what I want **for free** — and I like sharing what
I make and what I can do. This repo is one of those builds: a complete
offer-funnel system on top of Twenty CRM, open source, no gatekeeping.

If you want me to try and figure out stuff for what *you're* doing — a funnel,
an integration, some gnarly Twenty schema problem — let me know.

---

Offer-funnel builder backed by Twenty CRM. Each offer is a full funnel — landing hero + video + qualifier quiz → contact capture → Calendly booking → booked thank-you with videos — with a disqualified path for poor-fit prospects. Everything is authored in the Offer Detail editor and stored on the `agencyOffers` object in Twenty.

## Architecture

Three processes talk to each other. The browser only ever talks to the
frontend; the frontend talks to the backend over `/api/*`; the backend is the
only thing that touches Twenty (REST for records, Metadata API for schema,
Postgres for login verification).

```mermaid
flowchart LR
    Browser["Browser"]
    FE["Frontend<br/>Vite + React :3000"]
    BE["Backend<br/>Express + TS :4000"]
    REST["Twenty REST API<br/>records"]
    META["Twenty Metadata API<br/>schema"]
    PG[("Twenty Postgres<br/>core.user")]

    Browser --> FE
    FE -->|"GET/POST/PATCH /api/*<br/>JWT bearer"| BE
    FE -->|"POST /api/leads<br/>public, no auth"| BE
    BE --> REST
    BE --> META
    BE -->|"bcrypt password check"| PG
```

How it works, end to end:

- **Authoring:** the Offer Detail editor (`OfferDetailPage.tsx`) holds one tab
  per concern (landing, thank-you, disqualified, settings, UTM, proposals).
  Saving whitelists fields and `POST`/`PATCH`es a single `agencyOffers`
  record — configs travel as `RAW_JSON`, embeds/links as `TEXT`/`LINKS`.
  Basic Info has three cells: **Title**, **Preview as prospect** (ephemeral —
  tailors the preview only, never persisted), and **Industry** (persisted as
  the `industryId` SELECT value; one offer serves an entire industry).
- **Serving:** the public preview (`PreviewPage.tsx`) fetches that one record
  and renders hero, video, and quiz from it. No CMS, no build step — editing
  the offer changes the funnel immediately. Industry funnels resolve
  prospect → campaign → offer via `GET /api/public/offers/by-prospect/:key`
  and serve the industry's single offer with the prospect's own video/city.
- **Capture:** quiz answers + contact form `POST /api/leads` (the one public
  route), creating an `agencyLead` tagged `QUALIFIED`/`DISQUALIFIED`.
- **Booking:** the Calendly widget lives inside `Quiz.tsx`; its
  `event_scheduled` message flips the funnel into the booked state.

Auth follows the same split — the browser never sees Postgres:

```mermaid
flowchart TD
    Login["LoginPage<br/>email + password"]
    Verify["twenty-pg.ts<br/>SELECT core.user + bcrypt.compare"]
    PG[("Twenty Postgres")]
    JWT["JWT signed, 7 day expiry"]
    Guard["authMiddleware<br/>all /api/* except POST /api/leads"]
    Denied["401 Invalid credentials"]

    Login --> Verify
    Verify --> PG
    PG --> Verify
    Verify -- "match" --> JWT
    Verify -- "no match" --> Denied
    JWT --> Guard
```

Saving is defensive: Twenty rejects unknown fields with a 400, so the editor
tries the full payload first and retries without the not-yet-provisioned
fields (`status`/`ctaType`) rather than failing the whole save:

```mermaid
flowchart TD
    Editor["Editor tabs → buildData()<br/>whitelisted fields only"]
    TryFull["POST/PATCH with status + ctaType"]
    Missing{"400 unknown field?"}
    Retry["Retry without status/ctaType"]
    Ok["200 → toast + navigate to /offers"]
    Err["Save-failed banner"]

    Editor --> TryFull
    TryFull --> Missing
    Missing -- "No" --> Ok
    Missing -- "Yes" --> Retry
    Retry --> Ok
    Retry -- "Still failing" --> Err
```

## How the funnel works

```mermaid
flowchart TD
    Landing["Landing<br/>hero + video + Quiz"]
    Questions["Quiz questions"]
    Contact["Contact form<br/>name / email / phone"]
    CreateLead["POST /api/leads"]
    Qual{"dq flag hit?"}
    EmbedQ["Qualified Calendly embed<br/>calendlyUrl"]
    EmbedD["Disqualified Calendly embed<br/>disqualifiedConfig.calendlyEmbed"]
    Wait["Wait for calendly.event_scheduled"]
    Booked["BOOKED<br/>H1 swapped to thank-you message<br/>quiz + hero video unmounted<br/>videos: 1 main + 2x2 grid"]

    Landing --> Questions
    Questions --> Contact
    Contact --> CreateLead
    CreateLead --> Qual
    Qual -- "No → QUALIFIED" --> EmbedQ
    Qual -- "Yes → DISQUALIFIED" --> EmbedD
    EmbedQ --> Wait
    EmbedD --> Wait
    Wait --> Booked
```

- **Qualified path** uses `thankYouConfig` + `calendlyUrl`.
- **Disqualified path** (any answer with the DQ flag checked — sticky for the session) uses `disqualifiedConfig` + its own Calendly embed. The lead is still captured, tagged `DISQUALIFIED`.
- **Booked state** persists in `localStorage` (`quiz_booking_${offerId}`) so refreshes never resurrect the form; the hero H1 swaps to the branch's Twenty heading.
- **Preview reset** (floating button, preview only): deletes the test `agencyLead` from Twenty, clears the qualification/booking flags, and remounts the quiz. **Simulate booking** fires the same booked state without a real Calendly booking.

## Industry offers (one funnel per industry)

There is **one offer per industry**, not one per prospect. The builder's
Basic Info cell **Industry** (`IndustrySelect.tsx`) lists the distinct
`agencyCampaigns.industryId` values (`GET /api/industries`) and writes the
selected SELECT value to `offer.industryId`. Serving is then one lookup:
prospect → campaign → `industryId` match (see the backend shape section below).

Prospects themselves are **never stored on the offer**:

- The **Preview as prospect** cell is ephemeral UI state — it re-resolves
  `{{area}}` and quiz currency for that prospect in the preview
  (`?prospect=<id|slug>`) and is dropped on every offer load and save.
- The legacy conventions are retired: industry rows no longer use
  `name = INDUSTRY:{key}`, and per-prospect `name == prospectId` rows are not
  written, served, or read anymore. `ensure-industry-field.ts` scrubs any
  surviving `INDUSTRY:{key}` names (idempotent).
- The offers list is a flat searchable table (title/name/heroH1); which
  industry a row serves is visible in its **Industry** cell, and
  `GET /api/industries` lists exactly the industries that have a campaign.

## Public surface vs internal preview (one backend, two surfaces)

The same Express backend serves the internal builder and the fast public
funnel — only the frontend route and two unauthenticated endpoints differ:

| Surface | URL | Frontend route | Backend |
|---------|-----|----------------|---------|
| Builder (internal) | `domain.com` or `localhost:3000/offers/:id` (+ `/admin/offers/:id` alias) | `OfferDetailPage` | auth `/api/offers/*` |
| Preview (embedded in Twenty) | `https://offer.domain.com/preview/offers/{{record.id}}` in an iframe | `PreviewPage` (`mode="preview"`) | auth `/api/offers/:id` |
| Public funnel | `https://offer.domain.com/offer` (or `/offer/:slug`) | `PreviewPage` (`mode="public"`) | **no auth** `/api/public/*` |
| Industry prospect funnel | `https://offer.domain.com/offer/prospect/<prospect id\|slug>` | `PreviewPage` (`mode="public"`, prospect param) | **no auth** `/api/public/offers/by-prospect/:key` |

DNS/hosting: `domain.com` (marketing, isolated), `offer.domain.com` → CNAME
to the builder app, `twenty.domain.com` (self-hosted Twenty). The same
`PreviewPage` renders both preview and public — public mode hides the reset /
simulate pill, the "Preview •" footer, and the Back-to-Offers link, and
`Quiz` posts to `/api/public/leads` instead of `/api/leads`.

Save → preview bridge: the editor broadcasts `offer:saved:<id>` via
`localStorage` + `window.parent.postMessage` on every save; `PreviewPage` in
preview mode listens for both and also re-fetches every 20s (covers the
cross-origin Twenty-iframe case where neither signal can reach it).

```bash
# Visual-only payload (no auth, internal metadata stripped)
curl https://offer.domain.com/api/public/offers/default
curl https://offer.domain.com/api/public/offers/<offer-id>

# Lead capture (no auth) → { "success": true, "leadId": "..." }
curl -X POST https://offer.domain.com/api/public/leads \
  -H 'Content-Type: application/json' \
  -d '{"offerId":"<id>","firstName":"Jane","email":"jane@acme.com",
       "quizAnswers":{"q1":"a1"},"qualificationStatus":"QUALIFIED",
       "sourceUrl":"https://offer.domain.com/offer","utmSource":"meta"}'
```

## Offer Detail editor tabs

`frontend/src/pages/OfferDetailPage.tsx` — top-level tab navigation, each tab edits its own Twenty-backed config:

| Tab | Component | Stored as |
|-----|-----------|-----------|
| Landing page | Basic Info (title, preview-as-prospect, industry) + Hero Section + Video URL + Brand header + `QualifierQuiz` + Worked-with logos | `title/industryId/heroH1/heroLede/videoUrl/brandName/brandSub/brandLogoUrl/quizConfig/mediaLogos/carouselHeading/carouselDesc` — see [agency-offer object](docs/objects/agency-offer.md) |
| Thank-you | `ThankYouEditor` (badge, heading, video, video grid) | `thankYouConfig` (RAW_JSON) |
| Disqualified | `DisqualifiedForm` (same blocks + disqualified Calendly) | `disqualifiedConfig` (RAW_JSON) |
| Settings | `SettingsForm` (Meta Pixel ID, status, CTA type) | `metaPixelId` (TEXT), `status`, `ctaType` |
| UTM swaps | inline rules editor — per-source hero overrides | `utmSwaps` (RAW_JSON) |
| Proposals | static placeholder | `ProposalsForm.tsx` exists but is not wired into the tab yet |

## Quiz system

Quiz intro/questions live on the offer (`quizConfig`) — see [agency-offer object](docs/objects/agency-offer.md).

- `QualifierQuiz.tsx` — the **editor**: intro headline/description, reusable question blocks (text, type selector, delete), option rows (text, **DQ** toggle, **FB lead-event** toggle, next-question routing, delete), add question/option, contact-info + on-qualified settings. DQ/FB controls have hover tooltips explaining exactly what they do.
- `Quiz.tsx` — the **runtime**: `framer-motion` transitions, progress bar, immediate hover scale, supports `questions` prop (string or `{text, dq, fbLead}` objects).
- Any option with `dq: true` flips the session to disqualified (sticky). Options with `fbLead: true` fire `fbq('track', 'Lead', {content_name, content_category})` when Meta Pixel is configured.
- `nextQuestion` routing is authored but the runtime still advances linearly.

## Colouring, formatting & tokens

Hero copy is authored as raw HTML and rendered verbatim. There is no theme
layer in between — what `RichEditor` saves is what the preview injects.

### 1. Authoring — `RichEditor.tsx` toolbar

Select text, click a style. Each button wraps the selection (`wrapSelection`,
`RichEditor.tsx:11`) and the resulting HTML is stored as-is:

| Button | Title attr | Emitted HTML |
|--------|-----------|--------------|
| **B** | `Bold` | `<strong>…</strong>` |
| **A●** (blue) | `Blue color` | `<span style="color:#2563eb">…</span>` |
| **A●** (dark) | `Dark color` | `<span style="color:#0D2A4C">…</span>` |
| **H** (yellow) | `Highlight (yellow)` | `<mark class="bg-[#FFEB3B] rounded px-0.5">…</mark>` |
| **U** (underlined) | `Underline (for Your Area)` | `<span style="text-decoration:underline; text-decoration-color:#1D5BBF; text-underline-offset:4px; font-weight:700">…</span>` |
| **+ {{area}}** (lede toolbar only) | — | inserts the literal token `{{area}}` at the cursor |

Notes: buttons use `onMouseDown={e => e.preventDefault()}` so the text
selection survives the click (`RichEditor.tsx:77`); the H1 toolbar has no
`{{area}}` button by design (`showAreaToken={false}`); the editor is a
`contentEditable` div syncing `innerHTML` on input/blur (`RichEditor.tsx:54`).

### 2. Storage — verbatim HTML in Twenty

- `heroH1` (`TEXT`) and `heroLede.markdown` (`RICH_TEXT`) hold the editor's
  `innerHTML` unchanged, including tokens (`OfferDetailPage` save payload).
- Styling is **inline `style="…"`**, not classes: Twenty stores raw HTML with
  no access to the app's Tailwind build, so classes would not resolve. The
  one exception is the highlight `<mark class="bg-[#FFEB3B] rounded px-0.5">`,
  which the editor emits but the resolver normalises to inline styles —
  never author `class=` by hand.

### 3. Rendering — `resolveTokens.ts` + `dangerouslySetInnerHTML`

Both `PreviewPage.tsx:233,250` and the builder live preview inject the
resolved HTML unescaped. `resolveAreaTokens(html, { area, keepTokenIfMissing })`
runs three passes in this order (order matters — see gotchas):

1. **Wrapped tokens first**: `{{area}}` already inside an underline `<span>`
   has its inner text replaced; existing `style`/`data-token` attrs are
   stripped and a single clean style applied.
2. **Bare tokens in text nodes only**: HTML is split into tags vs text
   (`out.split(/(<[^>]*>)/)`), so replacements never touch attributes.
   `{{area}}`/`{{city}}` (case-insensitive) → solid underline span with the
   area, or — with no area — a dashed-underline `{{area}}` placeholder
   (`data-token="area"`, no braces, so it can never re-match). `{{name}}`
   is left untouched.
3. **Bare `(like yours)`** → yellow
   `<mark style="background:#FFEB3B; border-radius:2px; padding:0 2px">`,
   skipping text already inside a `<mark>` (depth-tracked).

Token source priority: explicit `?area=` URL param → resolved area → dashed
token placeholder. Tokens are **never** pulled from a prospect record and
never hardcoded to "Your Area".

### Worked example

Stored in Twenty (`heroLede.markdown`):

```html
Acme turns rough inputs into <mark style="background:#FFEB3B; border-radius:2px; padding:0 2px">(like yours)</mark> for other teams in {{area}}.
```

Preview with `?area=Springfield` renders: yellow-highlighted "(like yours)"
plus solid-underlined "Springfield". With no `?area=`, the same string
renders the highlight plus a dashed `{{area}}` token (template mode).

### Gotchas (fixed, documented so they stay fixed)

- **Nested spans**: the bare-token pass must run *after* the wrapped-token
  pass, otherwise `{{area}}` inside an existing underline span gets wrapped
  a second time (`<span><span>`).
- **Leaked `style="…"` as visible text**: caused by matching `{{area}}`
  inside `data-token="{{area}}"` attributes. Fixed by tag/text splitting
  and brace-free `data-token="area"`.

## Tracking

- Per-offer `metaPixelId` (Settings tab → Twenty `TEXT` field). Preview injects the Meta Pixel base code (`fbq('init')` + `PageView`); quiz answers flagged FB-lead fire `Lead` events.
- Test an event from Settings with **Test Lead event →** (logs to console when `fbq` is present).

## Tech stack

- **Backend:** Node.js + Express + TypeScript, Twenty REST + Metadata APIs, Postgres (`core."user"`) password verification, JWT auth.
- **Frontend:** React 18 + TypeScript + Vite, Tailwind CSS, TanStack Query, `@floating-ui/react` (all dropdowns/tooltips — no native `<select>`), `framer-motion`, Satoshi font, `--ods-*` design tokens.

## Directory structure

```
open-offer-builder/
├── backend/src/
│   ├── routes/
│   │   ├── auth.ts        # login via Twenty Postgres, JWT issue
│   │   ├── offers.ts      # agencyOffers CRUD (POST/PATCH whitelist, incl. industryId)
│   │   ├── leads.ts       # POST /api/leads (public funnel), DELETE /:id (preview reset)
│   │   ├── prospects.ts   # normalized prospect/lead list (city/region included)
│   │   └── industries.ts  # GET /api/industries — distinct campaign industryIds for the Industry select
│   ├── lib/
│   │   ├── twenty-client.ts  # Twenty REST wrapper
│   │   └── logger.ts         # timestamped [http]/[auth]/[offers] logs
│   ├── db/twenty-pg.ts       # read-only Twenty Postgres pool + bcrypt verify
│   ├── middleware/auth.ts    # JWT middleware (throws without JWT_SECRET in prod)
│   └── scripts/
│       ├── seed.ts            # ensure agencyOffers object + all fields (start here)
│       ├── ensure-industry-field.ts  # ensure industryId field + scrub legacy INDUSTRY:{key} names
│       └── ensure-*.ts        # idempotent single-field bootstrap
│           (quiz, thankyou, disqualified, calendly, pixel, utm, lead/prospect qual, status/cta)
├── frontend/src/
│   ├── pages/
│   │   ├── LoginPage.tsx       # TropicalTideBackground + Twenty credential login
│   │   ├── OffersPage.tsx      # offers table (searchable; status/CTA inline selects, delete modal)
│   │   ├── OfferDetailPage.tsx # 6-tab editor + save with retry + preview-as-prospect
│   │   └── PreviewPage.tsx     # public funnel (/preview/:industryId/:id)
│   ├── components/
│   │   ├── Quiz.tsx / QualifierQuiz.tsx
│   │   ├── ThankYouEditor.tsx / DisqualifiedForm.tsx
│   │   ├── SettingsForm.tsx / UtmSwapsForm.tsx / ProposalsForm.tsx
│   │   ├── ProspectSelect.tsx / IndustrySelect.tsx / StatusSelect.tsx / RichEditor.tsx
│   │   └── ui/ (Modal, Button, Badge, Toast, Spinner/Spokes, WidgetCard)
│   └── lib/
│       ├── api.ts / resolveTokens.ts / twentyOptions.ts / utils.ts
└── package.json  # bun workspaces (backend + frontend)
```

## Twenty CRM integration

Object/field reference lives in [docs/objects/](docs/objects/) — start with
[conventions](docs/objects/conventions.md), then
[agency-offer](docs/objects/agency-offer.md),
[agency-campaign](docs/objects/agency-campaign.md),
[agency-prospect](docs/objects/agency-prospect.md),
[agency-lead](docs/objects/agency-lead.md),
[agency-phone](docs/objects/agency-phone.md).

### Creating objects with Twenty (REST vs Metadata API)

Two different APIs do two different jobs — mixing them up is the most common
source of `404`/`400` errors in this project:

- **Metadata API** (`POST https://<twenty>/metadata`, GraphQL) — defines
  **schema**: custom *objects* and *fields*. This is how `agencyOffers` itself
  (and every custom field on it) comes into existence.
- **REST API** (`https://<twenty>/rest/...`, `Authorization: Bearer
  <TWENTY_API_KEY>`) — reads/writes **records** on objects that already exist:
  `GET /agencyOffers?limit=N`, `POST /agencyOffers`, `PATCH
  /agencyOffers/:id`, `GET /agencyOffers/:id`, `DELETE /agencyOffers/:id`.

So creating the `agencyOffers` object looks like this (Metadata API):

```graphql
mutation CreateOneObjectMetadataItem($input: CreateOneObjectInput!) {
  createOneObject(input: $input) { id nameSingular namePlural }
}
```

```json
{ "input": { "object": {
  "nameSingular": "agencyOffer",
  "namePlural": "agencyOffers",
  "labelSingular": "Agency Offer",
  "labelPlural": "Agency Offers",
  "description": "Offer funnels built by open-offer-builder"
} } }
```

Custom fields are added the same way (`createOneField` with
`objectMetadataId` + `name`/`label`/`type`/`description`, plus `options` for
`SELECT`). Two rules Twenty enforces that have bitten us before:

- `SELECT` option `value`s **must** be UPPER_CASE (`DRAFT`, not `draft`).
- Field creation needs the object's metadata `id`, so scripts always
  list-then-find `agencyOffer` first.

### Seed command (idempotent)

Field-level reference for everything the seed ensures: [agency-offer](docs/objects/agency-offer.md).

`bun run --cwd backend seed` (`backend/src/scripts/seed.ts`) ensures the
whole thing exists in one go: it creates the `agencyOffers` and `agencyLeads`
objects **only if missing**, then creates each missing custom field (`quizConfig`,
`thankYouConfig`, `disqualifiedConfig`, `utmSwaps`, `calendlyUrl`,
`metaPixelId`, `status`, `ctaType`). Anything already present is skipped, so
re-running is safe:

```
✓ agencyOffers object already exists (43f10e00-…)
✓ field quizConfig already exists — skipping
✓ seed done — agencyOffers ready
```

Run it first on any fresh Twenty workspace, then create records via
`POST /rest/agencyOffers` (or the Offer Detail editor, which does the same
through the backend).

### agencyOffers fields

> Full reference: [docs/objects/agency-offer.md](docs/objects/agency-offer.md).

| Field | Type | Notes |
|-------|------|-------|
| title | TEXT | funnel title — first thing in the offers list |
| name | TEXT | free-form label; the offers list only searches it. Legacy `INDUSTRY:{key}` values were a routing convention, now scrubbed by `ensure-industry-field.ts` — never load or save a prospect into this field |
| industryId | SELECT | `AUTO_PAINT_AND_BODY_SHOPS`/`WINDOW_TINTING`/`AUTO_DETAILING`/`GENERAL_TRADES` — mirrors the linked campaign's `industryId`; by-prospect serving matches `industryId[eq]:<campaign value>`; blank = not an industry offer |
| videoMode | SELECT | `PROSPECT` (default — serve the prospect record's `videoUrl`) / `CUSTOM` (serve this row's `videoUrl` to the whole industry) |
| heroH1 | TEXT | raw HTML from RichEditor, rendered verbatim |
| heroLede | RICH_TEXT | `{markdown, blocknote}` — markdown holds HTML + `{{area}}` |
| videoUrl | LINKS | `{primaryLinkLabel, primaryLinkUrl, secondaryLinks[]}` |
| status | SELECT | `DRAFT`/`ACTIVE`/`PAUSED` (UPPER_CASE required) |
| ctaType | SELECT | `CONSULTATION`/`PRICING`/`CUSTOM` (UPPER_CASE required; currently stored only — the funnel always ends in booking) |
| quizConfig | RAW_JSON | `{ introTitle, introDesc, questions[] }` — intro rendered as HTML with `{{area}}`/`{{currency}}` tokens; legacy bare arrays still read |
| thankYouConfig | RAW_JSON | badge, heading, `video` URL, video grid |
| disqualifiedConfig | RAW_JSON | same + `calendlyEmbed` (full inline widget HTML) |
| calendlyUrl | TEXT | qualified Calendly embed HTML (or bare URL) |
| metaPixelId | TEXT | per-offer Meta Pixel ID, empty = disabled |
| utmSwaps | RAW_JSON | `{ rules: [{ utmSource, field: heroH1\|heroLede\|title, html }] }` — first case-insensitive `?utm_source=` match swaps one hero field per visit |
| mediaLogos | RAW_JSON | `[{ src, alt?, href? }]` — worked-with carousel under the quiz, navy-tinted at render |
| carouselHeading | TEXT | carousel H1 HTML (RichEditor); blank falls back to default |
| carouselDesc | RICH_TEXT | `{markdown}` supporting line under the marquee, `{{area}}`-resolved |
| brandName / brandSub / brandLogoUrl | TEXT | brand header above hero H1: logo left, name right, sub beneath; all offer-driven |

`status`/`ctaType`/`videoMode` option values **must** be UPPER_CASE (Twenty validates). The UI keeps pretty labels and uppercases on write.

### Backend shape — objects, relations, expected values

> Full reference: [agency-campaign](docs/objects/agency-campaign.md) ·
> [agency-prospect](docs/objects/agency-prospect.md) ·
> [agency-phone](docs/objects/agency-phone.md) ·
> [conventions](docs/objects/conventions.md).

One `agencyCampaign` per industry owns the industry offer + routing. Campaign rows carry
`industryId` (same 4 SELECT values), `urlKey` (`autobody/tint/detailing/general`),
`funnelBaseUrl`, `templateBaseUrl`, `packDir`, `utmSource`, `status`. Runtime code reads
these rows — hosts and keys are never hardcoded and never defaulted.

```
agencyProspect.label ──SELECT──▶ industry ──▶ agencyCampaign.industryId
                                            ├─▶ agencyOffer  (industryId == campaign industryId)
                                            │     └─▶ hero/quiz/videoMode/utmSwaps/mediaLogos/carousel*/brand*
agencyProspect.campaignId ──RELATION──▶ agencyCampaign ──ROW──▶ urlKey/funnelBaseUrl/templateBaseUrl/packDir
agencyProspect.videoUrl ──► default funnel video (videoMode=PROSPECT)
agencyOffer.videoUrl  ──► industry-wide override (videoMode=CUSTOM only)
agencyLead ◀── funnel capture (prospectId + quiz answers in note)
```

Serve contract (`GET /api/public/offers/by-prospect/:key`, `:key` = id or slug):
prospect → linked campaign (fallback: campaign whose `industryId` matches the
prospect `label`) → the offer with that `industryId`, with `prospectId` and
the prospect's city/region stamped on the payload and the effective `videoUrl`
resolved server-side (`CUSTOM` override else prospect video). 404s are
explicit (`Prospect not found` / `Industry not configured` /
`Industry offer not found`) — no generic fallback.

The builder's **Preview as prospect** cell uses the same resolution in preview
mode (`/preview/<anything>/<offerId>?prospect=<id|slug>`): `{{area}}` and quiz
currency tailor to that prospect without ever writing the selection to the
offer record.

Canonical reads: `prospect.label` (never raw `niche`), `phoneNumber` composite before
`phone` TEXT, `website` TEXT, `{{area}}` from city/region, `{{currency}}` from the
`quizCurrency` record field (stamped at enrichment). `name` on prospects is the
**business** name — never split into a person.

### agencyLeads fields (funnel-created)

> Full reference: [docs/objects/agency-lead.md](docs/objects/agency-lead.md).

| Field | Type | Notes |
|-------|------|-------|
| qualificationStatus | SELECT | `QUALIFIED` (green) / `DISQUALIFIED` (red) |
| status | SELECT | mirrors qualification (`QUALIFIED` → `QUALIFIED`, `DISQUALIFIED` → `LOST`) |
| note | TEXT | contact details + quiz answers JSON (EMAILS type is finicky, so contact lives in `note`) |

### Backend API

- `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/offers`, `GET /api/offers/:id`, `POST /api/offers`, `PATCH /api/offers/:id`, `DELETE /api/offers/:id` (auth required; save retries without `status`/`ctaType` if Twenty lacks the fields)
- `POST /api/leads` (**public** — funnel submissions), `GET /api/leads`, `DELETE /api/leads/:id` (preview reset)
- `GET /api/public/offers/:slug` (**public** — visual-only payload; `:slug` is an offer id, slugified title/name, or `default` = first ACTIVE offer), `POST /api/public/leads` (**public** — funnel capture, returns `{ success, leadId }`)
- `GET /api/public/offers/by-prospect/:key` (**public** — industry offer for a prospect id or slug, with resolved video + `prospectId`), `GET /api/public/prospects/:key` (**public** — id/name/city/region/niche/currency only, no PII)
- `POST /api/offers/logo-upload` (auth — brand-logo file upload to R2, returns `{ url }`)
- `GET /api/prospects` — normalized prospects/leads for the picker
- `GET /api/industries` (auth — distinct campaign industryIds as `{ key, label, urlKey }[]` for the Industry select)
- `GET /api/health`

## Quick start

Requirements: Node.js ≥ 18, bun, a Twenty CRM instance.

```bash
cp .env.example .env.local   # fill in TWENTY_BASE_URL, TWENTY_API_KEY, TWENTY_DATABASE_URL, JWT_SECRET
bun install
bun run dev                  # backend :4000 + frontend :3000, raw interleaved logs
```

- Frontend: http://localhost:3000 (login with Twenty credentials → `/login` → `/offers`)
- Preview: http://localhost:3000/preview/general/:id (`?area=Springfield` resolves `{{area}}`; `?prospect=<id|slug>` tailors `{{area}}`/currency to a real prospect — preview-only, never saved)
- Health: http://localhost:4000/api/health

Create missing Twenty fields (idempotent) — prefer the seed command, which
covers the object plus every field in one run:

```bash
bun run --cwd backend seed
# …or individual scripts: src/scripts/ensure-quiz-field.ts,
#   ensure-thankyou-field, ensure-disqualified-field, ensure-calendly-field,
#   ensure-pixel-field, ensure-utm-field, ensure-lead-field,
#   ensure-prospect-qual, ensure-status-cta-fields,
#   ensure-industry-field (also scrubs legacy INDUSTRY:{key} offer names)
```

Build: `bun run --cwd frontend build` (`tsc` is clean — zero errors).

## Deploy to Vercel (single project: static frontend + serverless API)

One Vercel project serves both surfaces — `frontend/dist` as static files,
`/api/*` rewritten to the Express app bundled as `api/index.ts`
(`vercel.json`). Same origin, so `VITE_API_URL` stays **unset** in production
and the browser calls `/api/*` directly.

One-time bootstrap (uses your Vercel credentials via the CLI):

```bash
npm i -g vercel            # or bunx vercel
vercel login               # browser login
vercel link                # link repo → project open-offer-builder (.vercel/ is git-ignored)
vercel env add TWENTY_BASE_URL production      # https://twenty.inferencesaver.com (/rest optional)
vercel env add TWENTY_API_KEY production
vercel env add TWENTY_DATABASE_URL production  # Postgres for login; omit if Twenty PG isn't reachable
vercel env add JWT_SECRET production
vercel --prod
```

Verify after deploy:

```bash
curl https://<app>.vercel.app/api/health
curl https://<app>.vercel.app/api/public/offers/default
```

- Login degrades gracefully: without `TWENTY_DATABASE_URL`, password login is
  disabled (`twenty-pg.ts` returns `configured: false`) — public funnel routes
  (`/offer`, `/api/public/*`) are unaffected.
- `vercel.json` sets `frame-ancestors 'self' https://twenty.inferencesaver.com
  https://*.vercel.app` so Twenty can iframe the preview; no
  `X-Frame-Options: DENY` is ever set. If your Twenty host differs, extend the
  CSP list in `vercel.json`.
- Local `bun run dev` is unchanged: `tsx watch src/index.ts` binds `:4000`
  (direct-run only — the `listen` call is skipped when imported by Vercel).

### Twenty dashboard embed (iframe)

The public funnel is chromeless and auth-free, so it drops straight into a
Twenty dashboard as an iframe widget — no login, no editor chrome:

```
https://open-offer-builder-chi.vercel.app/offer
```

Per-offer dashboards: `https://open-offer-builder-chi.vercel.app/offer/<slug>`
(`<slug>` = offer id or slugified title; `/offer` alone serves the first
`ACTIVE` offer).

Installed server-side (no clicks needed): a dedicated **Offer Funnel
Dashboard** (`8583356f-…`, position 2) with layout `899b4100-…`, tab
`33a28165-…`, and a full-width `IFRAME` widget (`0071f935-…`, 12 cols ×
30 rows) pointing at `/dashboard?embed=1` (login → stat cards + offers
table, Layout chrome stripped in embed mode) — inserted
directly into `core."pageLayout"`
/ `"pageLayoutTab"` / `"pageLayoutWidget"` plus the workspace `dashboard`
record over the Tailscale Postgres connection, following the live `Cold
Dialer` conventions exactly (`Custom` application, `universalIdentifier` =
row id, `configuration: {url, configurationType: "IFRAME"}`). An earlier
attempt on My First Dashboard is soft-deleted. Just refresh Twenty to see
it in the left nav under Dashboards.

Works whether you open Twenty via `https://twenty.inferencesaver.com` or over
Tailscale via node01 (`http://100.98.241.63:3000`) — both origins are in the
app's `frame-ancestors` CSP in `vercel.json`. To add more embeds manually:
Edit dashboard → Add widget → Iframe/Embed → paste URL → save.

Suggested iframe attrs if your widget lets you set them:
`allow="fullscreen; clipboard-write"`,
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.

Notes:

- Use `/offer...`, **not** `/preview/offers/:id`, for dashboards — preview
  mode needs a logged-in builder token, the public funnel doesn't.
- The funnel carries `sourceUrl`/`utmSource`/`fbclid` into the lead's note on
  every `POST /api/public/leads`, so dashboard-sourced leads stay attributed.
- The editor's save → preview bridge (localStorage + postMessage + 20s poll)
  keeps embedded views fresh after each save.

## Railcode port (internal surfaces)

`railcode/offer-builder/` is a Railcode apps-v2 port of the **internal**
surfaces only — builder, preview, `/dashboard?embed=1`, and the internal
`/api/*` worker (Hono, `server/index.ts`). Live (private):
`https://offer-builder.listeningkit.railcode.app/`, embedded in the Twenty
Offer Funnel Dashboard.

- Auth is the Railcode org session (`ctx.user`) — the Twenty-password login
  is retired here (tailnet Postgres is unreachable from the worker).
  `POST /api/auth/login` returns 410; `GET /api/auth/me` returns the caller.
- `TWENTY_API_KEY` lives in worker secrets (`railcode secrets set`), the
  Twenty host is a worker constant, `egress:` allows it in `manifest.yaml`.
- **Not ported on purpose:** `/offer` + `/api/public/*` (anonymous prospect
  capture is impossible on Railcode — org members only). The public funnel
  stays on Vercel.

```bash
cd railcode/offer-builder
npm install
railcode dev --port 5234   # worker needs TWENTY_API_KEY in local env
railcode manifest validate
railcode deploy --private  # railcode apps set-access to open to the org
```

### Tailscale notes

- **Local iframe test before Vercel:** `tailscale funnel 3000` (or
  `tailscale serve --bg http://localhost:3000`) gives a public
  `https://<tail>-funnel.ts.net/preview/offers/:id` URL to paste into Twenty.
- **If Twenty is tailnet-private:** run a Tailscale subnet router (or Funnel)
  on the Twenty host and put the tailnet hostname/MagicDNS name in Vercel's
  `TWENTY_BASE_URL` / `TWENTY_DATABASE_URL` env vars.

## Environment

`.env.local` (never committed):

```
TWENTY_BASE_URL=https://twenty.inferencesaver.com   # /rest suffix optional (normalized)
TWENTY_API_KEY=...
TWENTY_DATABASE_URL=postgres://...                  # read-only Twenty Postgres for login
PORT=4000
JWT_SECRET=...                                      # required in prod — no fallback
VITE_API_URL=http://localhost:4000
```

## Conventions

- No native `<select>` — all dropdowns use `@floating-ui/react` + `FloatingPortal` (see `StatusSelect`, `ProspectSelect`, `QualifierQuiz` selects).
- No backend internals in prospect-facing copy (no QUALIFIED/DISQUALIFIED badges, no `agencyLead`/Twenty mentions in `Quiz`).
- Loading states always use the `Spokes` spinner, never "Loading..." text.
- `console.log('[OfferDetail] …')` / `[Quiz] …` / `[Preview] …` JSON logs in dev; `[http]` request logs on the backend.

## License

MIT

---

## Work with me

I'm Matthew, a Sales Engineer who builds GTM systems in the open — free
tooling, shared playbooks, no black boxes. Everything in this repo is how I
actually do it.

🎥 Walkthrough: https://x.com/matthewsoldit/status/2097482754724389058

Got something you're stuck on — a funnel that won't convert, a CRM schema
that fights back, some integration nobody has documented? Reach out and I'll
try to figure it out with you.
