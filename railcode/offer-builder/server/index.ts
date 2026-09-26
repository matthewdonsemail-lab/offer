import { Hono } from 'hono'
import { ctx, secrets } from '@railcode/sdk'

// Offer worker (Railcode edition). Same Twenty-backed API as the
// Express backend, minus what the platform now owns:
// - Auth is the verified Railcode org caller (ctx.user). No JWT, no Postgres
//   password check (the tailnet PG is unreachable from the worker anyway).
// - The shared frontend calls /api/public/* in its funnel mode, so those
//   paths exist here — the org gate below still applies (org members only).
//   Anonymous prospect capture stays on Vercel.
// - TWENTY_API_KEY and the R2 credentials come from worker secrets; the
//   Twenty host and R2 public base are constants.

const TWENTY_BASE_URL = 'https://twenty.inferencesaver.com'
const OFFERS_OBJECT = 'agencyOffers'
const LEADS_OBJECT = 'agencyLeads'
const R2_PUBLIC_BASE = 'https://pub-a08f5a2ef38748ca9d1249279659fc2e.r2.dev'

type TwentyRecord = { id: string; [key: string]: unknown }

function apiKey(): string {
  const key = (secrets as any).TWENTY_API_KEY as string | undefined
  if (!key) throw new Error('TWENTY_API_KEY secret is not set (railcode secrets set TWENTY_API_KEY)')
  return key
}

function toCamelCase(str: string): string {
  return str.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase())
}

function toSingular(str: string): string {
  if (str.endsWith('ies')) return str.slice(0, -3) + 'y'
  if (str.endsWith('s') && !str.endsWith('ss')) return str.slice(0, -1)
  return str
}

function toPascalCase(str: string): string {
  const camel = toCamelCase(str)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

function unwrapTwentyList<T>(payload: any, path: string): T[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  const data = payload.data?.data ? payload.data.data : payload.data
  if (!data) return Array.isArray(payload.rows) ? payload.rows : []
  if (Array.isArray(data)) return data
  const cleanPath = path.replace(/^\//, '').split('?')[0].split('/')[0]
  const objectName = toCamelCase(cleanPath)
  const singularName = toSingular(objectName)
  if (Array.isArray(data[objectName])) return data[objectName]
  if (Array.isArray(data[cleanPath])) return data[cleanPath]
  if (Array.isArray(data[singularName])) return data[singularName]
  if (Array.isArray(data.rows)) return data.rows
  if (Array.isArray(data.edges)) return data.edges.map((e: any) => e?.node).filter((n: any) => n !== undefined)
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}

function unwrapTwentyItem<T>(payload: any, path: string): T {
  if (!payload) return payload
  const data = payload.data?.data ? payload.data.data : (payload.data ?? payload)
  const cleanPath = path.replace(/^\//, '').split('?')[0].split('/')[0]
  const objectName = toCamelCase(cleanPath)
  const singularName = toSingular(objectName)
  const pascalSingular = toPascalCase(singularName)
  let record: any = null
  if (data && typeof data === 'object') {
    if (data[singularName] && typeof data[singularName] === 'object') record = data[singularName]
    else if (data[objectName] && typeof data[objectName] === 'object' && !Array.isArray(data[objectName])) record = data[objectName]
    else if (data[`create${pascalSingular}`] && typeof data[`create${pascalSingular}`] === 'object') record = data[`create${pascalSingular}`]
    else if (data[`update${pascalSingular}`] && typeof data[`update${pascalSingular}`] === 'object') record = data[`update${pascalSingular}`]
    else if ('id' in data) record = data
    else {
      for (const val of Object.values(data)) {
        if (val && typeof val === 'object' && 'id' in (val as any)) {
          record = val
          break
        }
      }
    }
  }
  return (record || data || payload) as T
}

async function twentyList(path: string, limit = 100, filter?: string): Promise<TwentyRecord[]> {
  const clean = path.startsWith('/') ? path.slice(1) : path
  const f = filter ? `&filter=${encodeURIComponent(filter)}` : ''
  const url = `${TWENTY_BASE_URL}/rest/${clean}?limit=${limit}${f}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Failed to list ${clean}: ${res.status}`)
  return unwrapTwentyList<TwentyRecord>(await res.json(), clean)
}

async function twentyGet(path: string, id: string): Promise<TwentyRecord> {
  const clean = path.startsWith('/') ? path.slice(1) : path
  const res = await fetch(`${TWENTY_BASE_URL}/rest/${clean}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Failed to get ${clean}/${id}: ${res.status}`)
  return unwrapTwentyItem<TwentyRecord>(await res.json(), clean)
}

async function twentyCreate(path: string, data: Record<string, any>): Promise<TwentyRecord> {
  const clean = path.startsWith('/') ? path.slice(1) : path
  const res = await fetch(`${TWENTY_BASE_URL}/rest/${clean}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to create ${clean}: ${res.status} - ${(await res.text()).slice(0, 300)}`)
  return unwrapTwentyItem<TwentyRecord>(await res.json(), clean)
}

async function twentyUpdate(path: string, id: string, data: Record<string, any>): Promise<TwentyRecord> {
  const clean = path.startsWith('/') ? path.slice(1) : path
  const res = await fetch(`${TWENTY_BASE_URL}/rest/${clean}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to update ${clean}/${id}: ${res.status} - ${(await res.text()).slice(0, 300)}`)
  return unwrapTwentyItem<TwentyRecord>(await res.json(), clean)
}

async function twentyDelete(path: string, id: string): Promise<void> {
  const clean = path.startsWith('/') ? path.slice(1) : path
  const res = await fetch(`${TWENTY_BASE_URL}/rest/${clean}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey()}` },
  })
  if (!res.ok && res.status !== 204) throw new Error(`Failed to delete ${clean}/${id}: ${res.status}`)
}

async function createAgencyLead(input: {
  offerId?: string
  answers?: Record<string, string>
  contact?: { name?: string; fullName?: string; email?: string; phone?: string }
  qualificationStatus?: string
  source?: string
  prospectId?: string
  quizData?: any
  sourceUrl?: string
  visitorId?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  fbclid?: string
  gclid?: string
}): Promise<TwentyRecord> {
  const { offerId, answers, contact, qualificationStatus, source, prospectId, quizData, sourceUrl, visitorId, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, fbclid, gclid } = input
  const finalQualification = qualificationStatus || (answers ? 'QUALIFIED' : undefined)
  const contactName = contact?.name || contact?.fullName || ''
  const email = contact?.email || ''
  const phone = contact?.phone || ''
  const noteParts: string[] = []
  if (answers) noteParts.push(`Quiz answers: ${JSON.stringify(answers, null, 2)}`)
  if (quizData) noteParts.push(`Quiz detail: ${JSON.stringify(quizData, null, 2)}`)
  if (offerId) noteParts.push(`OfferId: ${offerId}`)
  if (sourceUrl) noteParts.push(`Source URL: ${sourceUrl}`)
  if (visitorId) noteParts.push(`visitor_id: ${visitorId}`)
  if (utmSource) noteParts.push(`UTM source: ${utmSource}`)
  if (utmMedium) noteParts.push(`UTM medium: ${utmMedium}`)
  if (utmCampaign) noteParts.push(`UTM campaign: ${utmCampaign}`)
  if (utmContent) noteParts.push(`UTM content: ${utmContent}`)
  if (utmTerm) noteParts.push(`UTM term: ${utmTerm}`)
  if (fbclid) noteParts.push(`fbclid: ${fbclid}`)
  if (gclid) noteParts.push(`gclid: ${gclid}`)
  const contactNote = [`Name: ${contactName || '—'}`, `Email: ${email || '—'}`, `Phone: ${phone || '—'}`].join('\n')
  const fullNote = [contactNote, noteParts.join('\n\n')].filter(Boolean).join('\n\n').slice(0, 9000)
  const data: Record<string, any> = {
    ...(contactName && { contactName }),
    ...(fullNote && { note: fullNote }),
    ...(source && { source }),
    ...(finalQualification && { qualificationStatus: finalQualification }),
    ...(finalQualification === 'QUALIFIED'
      ? { status: 'QUALIFIED' }
      : finalQualification === 'DISQUALIFIED'
        ? { status: 'LOST' }
        : {}),
    name: contactName || email || `Lead ${new Date().toISOString().slice(0, 10)}`,
  }
  if (prospectId) (data as any).agencyProspect = { connect: { id: prospectId } }
  return twentyCreate(LEADS_OBJECT, data)
}

// ── public funnel helpers (mirror backend/src/routes/public.ts) ─────────────

/**
 * Visual-only payload keys exposed on /api/public/offers/*, so internal
 * agency metadata never leaves the worker.
 */
const VISUAL_KEYS = [
  'id',
  'title',
  'name',
  'heroH1',
  'heroLede',
  'videoUrl',
  'videoMode',
  'industryId',
  'prospectId',
  'quizConfig',
  'quiz',
  'thankYouConfig',
  'disqualifiedConfig',
  'calendlyUrl',
  'disqualifiedCalendlyUrl',
  'metaPixelId',
  'status',
  'utmSwaps',
  'mediaLogos',
  'carouselHeading',
  'carouselDesc',
  'brandName',
  'brandSub',
  'brandLogoUrl',
] as const

function toVisualPayload(record: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of VISUAL_KEYS) {
    if (record[key] !== undefined) out[key] = record[key]
  }
  return out
}

function slugify(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * Industry routing resolved from the agencyCampaign row — never hardcoded.
 * industryValue is the campaign's industryId SELECT value (the same value
 * stored on offer.industryId, so by-prospect matching is one eq filter).
 * Prefers the prospect's linked campaign; falls back to the campaign whose
 * industryId matches the prospect label. Returns null when unconfigured
 * (caller 404s explicitly instead of inventing a default).
 */
async function resolveIndustryRouting(
  prospect: TwentyRecord,
): Promise<{ industryValue: string; urlKey: string } | null> {
  const label = String((prospect as any).label?.value ?? (prospect as any).label ?? '')
  const linked = (prospect as any).campaignId ?? (prospect as any).campaignIdId
  const linkedId = typeof linked === 'string' ? linked : linked?.id
  if (linkedId) {
    try {
      const campaign = await twentyGet('agencyCampaigns', linkedId)
      const industryValue = String((campaign as any).industryId?.value ?? (campaign as any).industryId ?? '')
      const urlKey = String((campaign as any).urlKey ?? '')
      if (industryValue) {
        return { industryValue, urlKey }
      }
    } catch {
      // fall through to industryId filter
    }
  }
  if (!label) return null
  try {
    const campaigns = await twentyList('agencyCampaigns', 1, `industryId[eq]:${label}`)
    const row = campaigns[0] as any
    const industryValue = String(row?.industryId?.value ?? row?.industryId ?? '')
    if (industryValue) {
      return { industryValue, urlKey: String(row.urlKey ?? '') }
    }
  } catch {
    // unconfigured
  }
  return null
}

function primaryLinkUrl(videoUrl: unknown): string | undefined {
  if (videoUrl && typeof videoUrl === 'object') {
    const u = (videoUrl as Record<string, unknown>).primaryLinkUrl
    if (typeof u === 'string' && u.length > 0) return u
  }
  return undefined
}

/** Unwrap a Twenty SELECT ({ value }) or a plain string to its string value. */
function selValue(v: unknown): string {
  return String((v as any)?.value ?? v ?? '')
}

/** Extract an id from a relation field (string id or { id } object). */
function relationId(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const id = (v as any).id
    if (typeof id === 'string') return id
  }
  return ''
}

const app = new Hono()

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    twentyCrm: { apiKeyConfigured: true, auth: 'railcode-org-session' },
  }),
)

// org gate: every /api route below requires a signed-in caller
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next()
  if (!ctx.user) return c.json({ error: 'Sign in with Railcode to use the builder' }, 401)
  await next()
})

app.get('/api/auth/me', (c) => c.json({ user: ctx.user ?? null }))
app.post('/api/auth/login', (c) =>
  c.json({ error: 'Password login is retired on Railcode — sign in with your org account.' }, 410),
)

// ── industries ─────────────────────────────────────────────────────────────
// Distinct industry options for the builder's Industry selector, from
// agencyCampaigns. Each entry: key = the campaign's industryId SELECT value
// (what gets stored on offer.industryId and what by-prospect matching runs
// on), label = the campaign name (falls back to the SELECT value).
app.get('/api/industries', async (c) => {
  try {
    const campaigns = await twentyList('agencyCampaigns', 100)
    const seen = new Map<string, { key: string; label: string; urlKey: string }>()
    for (const cam of campaigns) {
      const key = selValue((cam as any).industryId)
      if (!key || seen.has(key)) continue
      const label = selValue((cam as any).name) || key
      seen.set(key, { key, label, urlKey: selValue((cam as any).urlKey) })
    }
    const industries = Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label))
    return c.json(industries)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── offers ───────────────────────────────────────────────────────────────
app.post('/api/offers/logo-upload', async (c) => {
  try {
    const form = await c.req.parseBody()
    const file = (form as any).logo
    if (!(file instanceof File) || !file.size) {
      return c.json({ error: 'No logo file provided' }, 400)
    }
    if (file.size > 2 * 1024 * 1024) {
      return c.json({ error: 'Logo must be 2MB or smaller' }, 400)
    }
    const mime = file.type || ''
    if (!/^(image\/svg\+xml|image\/png|image\/jpeg|image\/webp)$/.test(mime)) {
      return c.json({ error: 'Only SVG, PNG, JPEG, or WebP logos are allowed' }, 400)
    }
    const s = secrets as any
    const accountId = s.CLOUDFLARE_ACCOUNT_ID as string | undefined
    const apiToken = (s.CLOUDFLARE_R2_API_TOKEN || s.CLOUDFLARE_API_TOKEN) as string | undefined
    const bucket = s.R2_BUCKET as string | undefined
    if (!accountId || !apiToken || !bucket) {
      return c.json({ error: 'R2 storage is not configured on the worker (railcode secrets set CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_R2_API_TOKEN / R2_BUCKET)' }, 500)
    }
    const safe = (file.name || 'logo').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'logo'
    const key = `logos/${Date.now()}-${safe}`
    const put = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      body: await file.arrayBuffer(),
    })
    if (!put.ok) {
      const text = await put.text()
      throw new Error(`R2 upload failed: ${put.status} ${text.slice(0, 200)}`)
    }
    const url = `${R2_PUBLIC_BASE}/${key}`
    console.log(`[offers] logo uploaded: ${url} (${file.size} bytes)`)
    return c.json({ url })
  } catch (err: any) {
    console.error('[offers] logo upload failed:', err)
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/offers', async (c) => {
  try {
    return c.json(await twentyList(OFFERS_OBJECT, 100))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/offers/:id', async (c) => {
  try {
    return c.json(await twentyGet(OFFERS_OBJECT, c.req.param('id')))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

const OFFER_FIELDS = [
  'title', 'name', 'heroH1', 'heroLede', 'videoUrl', 'videoMode', 'industryId',
  'status', 'ctaType', 'prospectId', 'quizConfig', 'quiz', 'calendlyUrl',
  'thankYouConfig', 'disqualifiedConfig', 'metaPixelId', 'utmSwaps',
  'mediaLogos', 'carouselHeading', 'carouselDesc', 'brandName', 'brandSub',
  'brandLogoUrl',
] as const

function pickOfferFields(body: any): Record<string, any> {
  const data: Record<string, any> = {}
  for (const key of OFFER_FIELDS) {
    if (body?.[key] !== undefined) data[key] = body[key]
  }
  if (data.quiz !== undefined && data.quizConfig === undefined) data.quizConfig = data.quiz
  delete (data as any).quiz
  return data
}

app.post('/api/offers', async (c) => {
  try {
    const created = await twentyCreate(OFFERS_OBJECT, pickOfferFields(await c.req.json().catch(() => ({}))))
    return c.json(created, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.patch('/api/offers/:id', async (c) => {
  try {
    const updated = await twentyUpdate(
      OFFERS_OBJECT,
      c.req.param('id'),
      pickOfferFields(await c.req.json().catch(() => ({}))),
    )
    return c.json(updated)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.delete('/api/offers/:id', async (c) => {
  try {
    await twentyDelete(OFFERS_OBJECT, c.req.param('id'))
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── public funnel (org-gated here; the shared frontend calls these paths in
//    its public mode — see the note at the top of this file) ────────────────

// GET /api/public/offers/by-prospect/:key — Industry pages resolve here:
// prospect -> agencyCampaign industryId SELECT value -> the offer whose
// industryId matches (set via the Industry selector in the builder; no offer
// name convention involved). Serves the industry offer only; 404s when the
// prospect is unknown or no offer carries that industryId — no generic
// fallback. :key may be a prospect record id or slug.
app.get('/api/public/offers/by-prospect/:key', async (c) => {
  try {
    const prospectKey = c.req.param('key')
    let prospectId: string | null = null
    if (isUuid(prospectKey)) {
      prospectId = prospectKey
    } else {
      try {
        const matches = await twentyList('agencyProspects', 1, `slug[eq]:${prospectKey}`)
        prospectId = ((matches[0] as any)?.id as string) ?? null
      } catch {
        prospectId = null
      }
    }
    if (!prospectId) return c.json({ error: 'Prospect not found' }, 404)

    let prospect: TwentyRecord | null = null
    try {
      prospect = await twentyGet('agencyProspects', prospectId)
    } catch {
      prospect = null
    }
    if (!prospect) return c.json({ error: 'Prospect not found' }, 404)

    const routing = await resolveIndustryRouting(prospect)
    if (!routing) return c.json({ error: 'Industry not configured for prospect' }, 404)
    const offers = await twentyList(OFFERS_OBJECT, 1, `industryId[eq]:${routing.industryValue}`)
    const offer = offers[0] ?? null
    if (!offer) {
      return c.json({ error: 'Industry offer not found', industry: routing.industryValue }, 404)
    }

    // Effective video: industry CUSTOM override wins, else the prospect video.
    const mode = String((offer as any).videoMode || 'PROSPECT').toUpperCase()
    const overrideUrl = primaryLinkUrl((offer as any).videoUrl)
    const prospectUrl = primaryLinkUrl((prospect as any).videoUrl)
    const effectiveUrl = mode === 'CUSTOM' && overrideUrl ? overrideUrl : prospectUrl

    const payload = toVisualPayload(offer as unknown as Record<string, any>)
    payload.prospectId = prospectId
    // Public business location for {{area}} resolution in quiz intro copy.
    payload.prospectCity = (prospect as any).city || undefined
    payload.prospectRegion = (prospect as any).region || undefined
    if (effectiveUrl) {
      payload.videoUrl = {
        ...((payload.videoUrl as Record<string, unknown>) || {}),
        primaryLinkUrl: effectiveUrl,
      }
    }
    console.log(`[public] serving industry offer ${routing.industryValue} (${(offer as any).id}) for prospect ${prospectId} video=${mode}`)
    return c.json(payload)
  } catch (err: any) {
    console.error(`[public] error serving prospect offer ${c.req.param('key')}:`, err)
    return c.json({ error: err.message }, 500)
  }
})

// GET /api/public/offers/:slug — visual payload for the public funnel.
// :slug may be a Twenty record id, a slugified title/name, or "default"
// (first ACTIVE offer, else first offer).
app.get('/api/public/offers/:slug', async (c) => {
  try {
    const slug = c.req.param('slug')
    let offer: TwentyRecord | null = null

    if (slug === 'default') {
      const offers = await twentyList(OFFERS_OBJECT, 100)
      offer =
        offers.find((o) => String((o as any).status || '').toUpperCase() === 'ACTIVE') ??
        offers[0] ??
        null
    } else if (isUuid(slug)) {
      try {
        offer = await twentyGet(OFFERS_OBJECT, slug)
      } catch {
        offer = null
      }
    } else {
      const offers = await twentyList(OFFERS_OBJECT, 100)
      offer =
        offers.find(
          (o) => slugify((o as any).title) === slug || slugify((o as any).name) === slug,
        ) ?? null
    }

    if (!offer) return c.json({ error: 'Offer not found' }, 404)
    console.log(`[public] serving public offer payload for ${slug} -> ${(offer as any).id}`)
    return c.json(toVisualPayload(offer as unknown as Record<string, any>))
  } catch (err: any) {
    console.error(`[public] error serving public offer ${c.req.param('slug')}:`, err)
    return c.json({ error: err.message }, 500)
  }
})

// GET /api/public/prospects/:key — prospect lookup for copy tailoring.
// :key may be a record id or slug. Returns ONLY city/region/name/niche/
// quizCurrency — no contact PII ever leaves through this route.
app.get('/api/public/prospects/:key', async (c) => {
  try {
    const key = c.req.param('key')
    let record: TwentyRecord | null = null
    if (isUuid(key)) {
      try {
        record = await twentyGet('agencyProspects', key)
      } catch {
        record = null
      }
    } else {
      const matches = await twentyList('agencyProspects', 1, `slug[eq]:${key}`)
      record = matches[0] ?? null
    }
    if (!record) return c.json({ error: 'Prospect not found' }, 404)
    const r = record as unknown as Record<string, any>
    return c.json({
      id: r.id,
      name: r.name ?? null,
      city: r.city ?? null,
      region: r.region ?? null,
      niche: r.niche ?? null,
      quizCurrency: r.quizCurrency ?? null,
    })
  } catch (err: any) {
    console.error(`[public] error serving public prospect ${c.req.param('key')}:`, err)
    return c.json({ error: err.message }, 500)
  }
})

// POST /api/public/leads — lead capture for the shared frontend's funnel
// mode (org-gated on this surface; anonymous capture stays on Vercel).
app.post('/api/public/leads', async (c) => {
  try {
    const {
      offerId,
      firstName,
      lastName,
      email,
      phone,
      quizAnswers,
      answers,
      contact,
      qualificationStatus,
      sourceUrl,
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      fbclid,
      gclid,
      prospectId,
      source,
      quizData,
    } = (await c.req.json().catch(() => ({}))) as Record<string, any>

    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
    const mergedContact = contact ?? {
      ...(fullName && { name: fullName }),
      ...(email && { email }),
      ...(phone && { phone }),
    }

    if (!mergedContact?.email && !mergedContact?.phone) {
      return c.json({ error: 'Email or phone required' }, 400)
    }

    const created = await createAgencyLead({
      offerId,
      answers: answers ?? quizAnswers,
      contact: mergedContact,
      qualificationStatus,
      source: source ?? 'public',
      prospectId,
      quizData,
      sourceUrl,
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      fbclid,
      gclid,
    })
    return c.json({ success: true, leadId: created.id }, 201)
  } catch (err: any) {
    console.error('[public] error creating public lead:', err)
    return c.json({ error: err.message }, 500)
  }
})

// ── leads (internal funnel; anonymous capture stays on Vercel) ────────────
app.post('/api/leads', async (c) => {
  try {
    const created = await createAgencyLead(await c.req.json().catch(() => ({})))
    return c.json(created, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/leads', async (c) => {
  try {
    return c.json(await twentyList(LEADS_OBJECT, 100))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.delete('/api/leads/:id', async (c) => {
  try {
    await twentyDelete(LEADS_OBJECT, c.req.param('id'))
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── prospects ────────────────────────────────────────────────────────────
app.get('/api/prospects', async (c) => {
  try {
    let records: TwentyRecord[] = []
    for (const obj of ['agencyProspects', 'agencyLeads', 'prospects', 'leads']) {
      try {
        const fetched = await twentyList(obj, 100)
        if (fetched.length > 0) {
          records = fetched
          break
        }
      } catch {
        // try next object
      }
    }
    // Optional: only return prospects whose effective industry matches this
    // offer's industryId (the linked campaign's industryId, else the prospect
    // label) — mirrors resolveIndustryRouting() so the preview picker only
    // surfaces prospects the offer actually serves.
    const requestedIndustry = (c.req.query('industryId') || '').trim()
    let campaignIndustry = new Map<string, string>()
    if (requestedIndustry) {
      try {
        const campaigns = await twentyList('agencyCampaigns', 200)
        for (const camp of campaigns) {
          const cid = String((camp as any).id ?? '')
          const ind = selValue((camp as any).industryId)
          if (cid && ind) campaignIndustry.set(cid, ind)
        }
      } catch {
        // fall back to label matching only
      }
    }

    return c.json(
      records
        .map((r: any) => {
          const label = selValue(r.label)
          const linkedId = relationId(r.campaignId ?? r.campaignIdId)
          const industryId = linkedId ? campaignIndustry.get(linkedId) || label : label
          return {
            id: r.id,
            displayName:
              [r.firstName, r.lastName].filter(Boolean).join(' ') ||
              (r.first_name ? `${r.first_name} ${r.last_name}`.trim() : r.name || r.company || r.email || r.id),
            firstName: r.firstName || r.first_name,
            lastName: r.lastName || r.last_name,
            company: r.company,
            email: r.email,
            city: r.city,
            region: r.region,
            industryId,
            raw: r,
          }
        })
        .filter((p: any) => !requestedIndustry || p.industryId === requestedIndustry),
    )
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app
