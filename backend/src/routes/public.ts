import { Router } from "express";
import { twentyClient, type TwentyRecord } from "../lib/twenty-client.js";
import { createAgencyLead } from "./leads.js";
import { createLogger } from "../lib/logger.js";
import { normalizeQuestionnaire } from "../lib/career-questionnaire.js";
import { submitApplication } from "../lib/applications.js";

const router = Router();
const log = createLogger('public');
const OBJECT_NAME = "agencyOffers";

/**
 * Visual-only payload keys exposed to the unauthenticated public funnel.
 * Internal agency metadata (createdBy/updatedBy/source internals, search
 * vectors, positions, etc.) is stripped before responding.
 */
const VISUAL_KEYS = [
  "id",
  "title",
  "name",
  "heroH1",
  "heroLede",
  "videoUrl",
  "videoMode",
  "industryId",
  "prospectId",
  "quizConfig",
  "quiz",
  "thankYouConfig",
  "disqualifiedConfig",
  "calendlyUrl",
  "disqualifiedCalendlyUrl",
  "metaPixelId",
  "status",
  "utmSwaps",
  "mediaLogos",
  "carouselHeading",
  "carouselDesc",
  "brandName",
  "brandSub",
  "brandLogoUrl",
  // Recruitment funnels. `careerQuestionnaire` is added server-side (see
  // attachCareer), never authored on the offer row.
  "funnelType",
  "careerSlug",
  "applicationConfig",
  "careerQuestionnaire",
  "roleTitle",
] as const;

function toVisualPayload(record: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of VISUAL_KEYS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

function slugify(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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
  const label = String((prospect as any).label?.value ?? (prospect as any).label ?? "");
  const linked = (prospect as any).campaignId ?? (prospect as any).campaignIdId;
  const linkedId = typeof linked === "string" ? linked : linked?.id;
  if (linkedId) {
    try {
      const campaign = await twentyClient.get<TwentyRecord>("agencyCampaigns", linkedId);
      const industryValue = String((campaign as any).industryId?.value ?? (campaign as any).industryId ?? "");
      const urlKey = String((campaign as any).urlKey ?? "");
      if (industryValue) {
        return { industryValue, urlKey };
      }
    } catch {
      // fall through to industryId filter
    }
  }
  if (!label) return null;
  try {
    const campaigns = await twentyClient.list<TwentyRecord>("agencyCampaigns", {
      limit: 1,
      filter: `industryId[eq]:${label}`,
    } as any);
    const row = campaigns[0] as any;
    const industryValue = String(row?.industryId?.value ?? row?.industryId ?? "");
    if (industryValue) {
      return { industryValue, urlKey: String(row.urlKey ?? "") };
    }
  } catch {
    // unconfigured
  }
  return null;
}

function primaryLinkUrl(videoUrl: unknown): string | undefined {
  if (videoUrl && typeof videoUrl === "object") {
    const u = (videoUrl as Record<string, unknown>).primaryLinkUrl;
    if (typeof u === "string" && u.length > 0) return u;
  }
  return undefined;
}

/**
 * Resolve the agencyCareers row a RECRUITMENT offer points at and attach its
 * normalised questionnaire to the payload.
 *
 * The questionnaire is stored on the career record, not the offer, so the
 * offer stays a presentation shell and the role stays the single source of
 * truth for what is asked. A funnel with `funnelType: RECRUITMENT` and no
 * `careerSlug` is a misconfiguration: we 404 rather than render an
 * application form with no questions on it.
 */
async function attachCareer(
  payload: Record<string, any>,
  offer: Record<string, any>,
): Promise<Record<string, any> | null> {
  const funnelType = String(offer.funnelType ?? "LEAD").toUpperCase();
  payload.funnelType = funnelType;
  if (funnelType !== "RECRUITMENT") return payload;

  const slug = String(offer.careerSlug ?? "").trim();
  if (!slug) {
    log.error(`RECRUITMENT offer ${offer.id} has no careerSlug`);
    return null;
  }

  let career: Record<string, any> | null = null;
  try {
    const matches = await twentyClient.list<TwentyRecord>("agencyCareers", {
      limit: 1,
      filter: `slug[eq]:${slug}`,
    } as any);
    career = (matches[0] as Record<string, any>) ?? null;
  } catch {
    career = null;
  }
  if (!career) {
    log.error(`career ${slug} not found for offer ${offer.id}`);
    return null;
  }
  if (String(career.status ?? "").toUpperCase() !== "PUBLISHED") {
    log.error(`career ${slug} is ${career.status ?? "unset"}, not PUBLISHED`);
    return null;
  }

  const { steps, droppedStepIds } = normalizeQuestionnaire(career.body);
  if (droppedStepIds.length > 0) {
    log.warn(`career ${slug} has unrenderable questionnaire steps: ${droppedStepIds.join(", ")}`);
  }
  payload.careerSlug = slug;
  payload.roleTitle = String(career.title ?? career.name ?? slug);
  payload.careerQuestionnaire = steps;
  log.info(`Serving RECRUITMENT offer ${offer.id} for career ${slug} (${steps.length} steps)`);
  return payload;
}

/**
 * GET /api/public/offers/by-prospect/:key
 * Industry pages resolve here: prospect -> agencyCampaign industryId SELECT
 * value -> the offer whose industryId matches (set via the Industry selector
 * in the builder; no offer name convention involved).
 * Serves the industry offer only; 404s when the prospect is unknown or no
 * offer carries that industryId — no generic fallback.
 * :key may be a prospect record id or slug.
 */
router.get("/offers/by-prospect/:key", async (req, res) => {
  try {
    const prospectKey = req.params.key as string;
    let prospectId: string | null = null;
    if (isUuid(prospectKey)) {
      prospectId = prospectKey;
    } else {
      try {
        const matches = await twentyClient.list<TwentyRecord>("agencyProspects", {
          limit: 1,
          filter: `slug[eq]:${prospectKey}`,
        } as any);
        prospectId = ((matches[0] as any)?.id as string) ?? null;
      } catch {
        prospectId = null;
      }
    }
    if (!prospectId) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }

    let prospect: TwentyRecord | null = null;
    try {
      prospect = await twentyClient.get<TwentyRecord>("agencyProspects", prospectId);
    } catch {
      prospect = null;
    }
    if (!prospect) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }

    const routing = await resolveIndustryRouting(prospect);
    if (!routing) {
      res.status(404).json({ error: "Industry not configured for prospect" });
      return;
    }
    const offers = await twentyClient.list<TwentyRecord>(OBJECT_NAME, {
      limit: 1,
      filter: `industryId[eq]:${routing.industryValue}`,
    } as any);
    const offer = offers[0] ?? null;
    if (!offer) {
      res.status(404).json({ error: "Industry offer not found", industry: routing.industryValue });
      return;
    }

    // Effective video: industry CUSTOM override wins, else the prospect video.
    const mode = String((offer as any).videoMode || "PROSPECT").toUpperCase();
    const overrideUrl = primaryLinkUrl((offer as any).videoUrl);
    const prospectUrl = primaryLinkUrl((prospect as any).videoUrl);
    const effectiveUrl = mode === "CUSTOM" && overrideUrl ? overrideUrl : prospectUrl;

    const payload = toVisualPayload(offer as unknown as Record<string, any>);
    payload.prospectId = prospectId;
    // Public business location for {{area}} resolution in quiz intro copy.
    payload.prospectCity = (prospect as any).city || undefined;
    payload.prospectRegion = (prospect as any).region || undefined;
    if (effectiveUrl) {
      payload.videoUrl = {
        ...((payload.videoUrl as Record<string, unknown>) || {}),
        primaryLinkUrl: effectiveUrl,
      };
    }
    // Industry pages are sales surfaces by construction (a prospect has a
    // campaign behind them). A RECRUITMENT offer must never be reachable here
    // even if someone left a stale industryId on it.
    payload.funnelType = "LEAD";
    log.info(`Serving industry offer ${routing.industryValue} (${(offer as any).id}) for prospect ${prospectId} video=${mode}`);
    res.json(payload);
  } catch (err: any) {
    log.error(`Error serving prospect offer ${req.params.key}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stable public URLs for the funnel that marketing links to, mapped to the
 * offer.ctaType they select. These must survive offer renames: ui-kit links
 * straight at `/offer/book-a-consultation`, so it resolves by CTA intent and
 * never by whatever the offer happens to be titled this week.
 */
const CTA_SLUG_ALIASES: Record<string, string> = {
  "book-a-consultation": "CONSULTATION",
  consultation: "CONSULTATION",
  "book-a-call": "CONSULTATION",
};

/**
 * GET /api/public/offers/job/:careerSlug
 * Stable public URL for a recruitment funnel. Resolves through the career, not
 * the offer's title, so the marketing link matches the career page it sits
 * next to and survives an offer rename. Registered before `/offers/:slug` so
 * "job" is not read as a slug.
 */
router.get("/offers/job/:careerSlug", async (req, res) => {
  try {
    const careerSlug = decodeURIComponent(req.params.careerSlug as string);
    const offers = await twentyClient.list<TwentyRecord>(OBJECT_NAME, 100);
    const offer = offers.find(
      (o) =>
        String((o as any).funnelType ?? "LEAD").toUpperCase() === "RECRUITMENT" &&
        String((o as any).careerSlug ?? "") === careerSlug,
    );
    if (!offer) {
      res.status(404).json({ error: "Offer not found" });
      return;
    }
    const payload = await attachCareer(
      toVisualPayload(offer as unknown as Record<string, any>),
      offer as unknown as Record<string, any>,
    );
    if (!payload) {
      res.status(404).json({ error: "Recruitment funnel is not configured" });
      return;
    }
    log.info(`Serving recruitment offer for career ${careerSlug} -> ${(offer as any).id}`);
    res.json(payload);
  } catch (err: any) {
    log.error(`Error serving recruitment offer ${req.params.careerSlug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/public/offers/:slug
 * Unauthenticated visual payload for the public funnel at offer.domain.com.
 * :slug may be a Twenty record id, a slugified title/name, a CTA alias
 * ("book-a-consultation"), or "default" (first ACTIVE offer, else first
 * offer).
 */
router.get("/offers/:slug", async (req, res) => {
  try {
    const slug = req.params.slug as string;
    let offer: TwentyRecord | null = null;

    // Recruitment funnels are excluded from `default` and from the CTA
    // aliases: an applicant landing on the sales funnel is a routing bug, and
    // a sales visitor landing on a job application is worse.
    const isRecruitment = (o: Record<string, any>) =>
      String(o.funnelType ?? "LEAD").toUpperCase() === "RECRUITMENT";

    if (slug === "default" || slug === "") {
      const offers = (await twentyClient.list<TwentyRecord>(OBJECT_NAME, 100)).filter(
        (o) => !isRecruitment(o as Record<string, any>),
      );
      offer =
        offers.find((o) => String((o as any).status || "").toUpperCase() === "ACTIVE") ??
        offers[0] ??
        null;
    } else if (isUuid(slug)) {
      try {
        offer = await twentyClient.get<TwentyRecord>(OBJECT_NAME, slug);
      } catch {
        offer = null;
      }
    } else {
      const offers = await twentyClient.list<TwentyRecord>(OBJECT_NAME, 100);
      offer =
        offers.find(
          (o) => slugify((o as any).title) === slug || slugify((o as any).name) === slug
        ) ?? null;

      if (!offer) {
        const ctaType = CTA_SLUG_ALIASES[slug];
        if (ctaType) {
          offer =
            offers.find(
              (o) =>
                String((o as any).ctaType || "").toUpperCase() === ctaType &&
                String((o as any).status || "").toUpperCase() === "ACTIVE"
            ) ??
            offers.find(
              (o) => String((o as any).ctaType || "").toUpperCase() === ctaType
            ) ??
            null;
        }
      }
    }

    if (!offer) {
      res.status(404).json({ error: "Offer not found" });
      return;
    }
    const payload = await attachCareer(
      toVisualPayload(offer as unknown as Record<string, any>),
      offer as unknown as Record<string, any>,
    );
    if (!payload) {
      res.status(404).json({ error: "Recruitment funnel is not configured" });
      return;
    }
    log.info(`Serving public offer payload for ${slug} -> ${(offer as any).id}`);
    res.json(payload);
  } catch (err: any) {
    log.error(`Error serving public offer ${req.params.slug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/public/prospects/:key
 * Unauthenticated prospect lookup for copy tailoring (industry pages).
 * :key may be a record id or slug. Returns ONLY city/region/name/niche —
 * no contact PII ever leaves through this route.
 */
router.get("/prospects/:key", async (req, res) => {
  try {
    const key = req.params.key as string;
    let record: TwentyRecord | null = null;
    if (isUuid(key)) {
      try {
        record = await twentyClient.get<TwentyRecord>("agencyProspects", key);
      } catch {
        record = null;
      }
    } else {
      const matches = await twentyClient.list<TwentyRecord>("agencyProspects", {
        limit: 1,
        filter: `slug[eq]:${key}`,
      } as any);
      record = matches[0] ?? null;
    }
    if (!record) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }
    const r = record as unknown as Record<string, any>;
    res.json({
      id: r.id,
      name: r.name ?? null,
      city: r.city ?? null,
      region: r.region ?? null,
      niche: r.niche ?? null,
      quizCurrency: r.quizCurrency ?? null,
    });
  } catch (err: any) {
    log.error(`Error serving public prospect ${req.params.key}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/public/leads
 * Unauthenticated lead capture for the public funnel.
 * Body: { offerId, firstName?, lastName?, email?, phone?, quizAnswers?,
 *   answers?, contact?, qualificationStatus?, sourceUrl?, visitorId?,
 *   utmSource?, utmMedium?, utmCampaign?, utmContent?, utmTerm?,
 *   fbclid?, gclid?, prospectId?, source? }
 * Returns { success, leadId } for Calendly routing on the client.
 */
router.post("/leads", async (req, res) => {
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
    } = req.body ?? {};

    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const mergedContact = contact ?? {
      ...(fullName && { name: fullName }),
      ...(email && { email }),
      ...(phone && { phone }),
    };

    if (!mergedContact?.email && !mergedContact?.phone) {
      res.status(400).json({ error: "Email or phone required" });
      return;
    }

    const created = await createAgencyLead({
      offerId,
      answers: answers ?? quizAnswers,
      contact: mergedContact,
      qualificationStatus,
      source: source ?? "public",
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
    });
    res.status(201).json({ success: true, leadId: created.id });
  } catch (err: any) {
    log.error("Error creating public lead:", err.message);
    console.error('[public] error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/public/applications
 * Unauthenticated application capture for a RECRUITMENT funnel. Writes an
 * `agencyCareerApplication`, never an `agencyLead`.
 * Body: { offerId, answers, videoUrl?, videoNote?, sourceUrl?, visitorId?,
 *   utmSource?, utmMedium?, utmCampaign? }
 * The offer is re-read server-side: the client cannot choose which role it is
 * applying for, only which funnel it came through.
 */
router.post("/applications", async (req, res) => {
  try {
    const {
      offerId,
      answers,
      videoUrl,
      videoNote,
      sourceUrl,
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
    } = req.body ?? {};

    if (!offerId || typeof offerId !== "string") {
      res.status(400).json({ error: "offerId is required" });
      return;
    }
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      res.status(400).json({ error: "answers is required" });
      return;
    }

    let offer: Record<string, any>;
    try {
      offer = (await twentyClient.get<TwentyRecord>(OBJECT_NAME, offerId)) as Record<string, any>;
    } catch {
      res.status(404).json({ error: "Offer not found" });
      return;
    }
    if (String(offer.funnelType ?? "LEAD").toUpperCase() !== "RECRUITMENT") {
      res.status(400).json({ error: "This funnel does not accept applications" });
      return;
    }

    const careerSlug = String(offer.careerSlug ?? "").trim();
    if (!careerSlug) {
      res.status(500).json({ error: "Recruitment funnel is not configured" });
      return;
    }
    const matches = await twentyClient.list<TwentyRecord>("agencyCareers", {
      limit: 1,
      filter: `slug[eq]:${careerSlug}`,
    } as any);
    const career = matches[0] as Record<string, any> | undefined;
    if (!career || String(career.status ?? "").toUpperCase() !== "PUBLISHED") {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    const result = await submitApplication({
      career: career as never,
      offerId,
      answers: answers as Record<string, string>,
      videoUrl: typeof videoUrl === "string" ? videoUrl : undefined,
      videoNote: typeof videoNote === "string" ? videoNote : undefined,
      config: (offer.applicationConfig ?? null) as never,
      sourceUrl,
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ success: true, applicationId: result.applicationId });
  } catch (err: any) {
    log.error("Error creating application:", err.message);
    console.error("[public] application error", err);
    res.status(500).json({ error: err.message });
  }
});

export { router };
export default router;
