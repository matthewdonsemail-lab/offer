# agencyCampaign / agencyCampaigns

One row per industry. The campaign row is the **only source of industry routing**:
`urlKey`, funnel/template hosts, and pack dir. Runtime code reads these rows —
hosts and keys are never hardcoded and never defaulted.

## How to make it

- Created by the ui-kit ensure script alongside the industry offers; or
  `POST /rest/agencyCampaigns` with the fields below.
- Link prospects via their `campaignId` relation (done in bulk by the ensure script).

## Expected metadata fields

| Field | Type | Expected values |
|-------|------|-----------------|
| `name` | TEXT | `Autobody Lead Gen`, `Tint Lead Gen`, `Detailing Lead Gen`, `General Lead Gen` |
| `industryId` | SELECT | Same 4 values as prospect `label` (mirrors it) |
| `urlKey` | TEXT | `autobody` / `tint` / `detailing` / `general` — used in `/offer/prospect/` routing display; offers link by `industryId`, **not** by `urlKey` |
| `funnelBaseUrl` | TEXT | Bare-funnel host, no trailing slash (e.g. `https://offer-chi.vercel.app`) |
| `templateBaseUrl` | TEXT | Branded shell host, no trailing slash (e.g. `https://listeningkit-frontend-web-phi.vercel.app`) |
| `packDir` | TEXT | Template pack folder for the video agent (`--pack-dir`; all `tint` today) |
| `utmSource` | SELECT | `OUTBOUND` / `INBOUND` / `BLENDED` (UPPER_CASE) |
| `status` | SELECT | `ACTIVE` / `INACTIVE` / `DRAFT` |

## Relations

- `prospects` (reverse of `agencyProspect.campaignId`), `leads`, `scripts`.
- If a deployment moves hosts, update these 4 rows — never code or env fallbacks.

## Readers

Chi `by-prospect` (linked campaign → `industryId[eq]` filter fallback), dialer
`website-status` (both trees), video-agent pack selection.
