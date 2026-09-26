import { Router } from "express";
import { twentyClient, type TwentyRecord } from "../lib/twenty-client.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";

const router = Router();
const log = createLogger('leads');
const OBJECT_NAME = "agencyLeads";

export interface LeadContact {
  name?: string;
  fullName?: string;
  email?: string;
  phone?: string;
}

export interface CreateLeadInput {
  offerId?: string;
  answers?: Record<string, string>;
  contact?: LeadContact;
  qualificationStatus?: string;
  source?: string;
  prospectId?: string;
  quizData?: any;
  sourceUrl?: string;
  visitorId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  fbclid?: string;
  gclid?: string;
}

/**
 * Shared agencyLead creator — used by both POST /api/leads and the
 * unauthenticated POST /api/public/leads funnel endpoint.
 */
export async function createAgencyLead(input: CreateLeadInput): Promise<TwentyRecord> {
  const { offerId, answers, contact, qualificationStatus, source, prospectId, quizData, sourceUrl, visitorId, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, fbclid, gclid } = input;

  // Determine qualification if not provided: if any answer option was DQ, mark disqualified
  let finalQualification = qualificationStatus;
  if (!finalQualification && answers) {
    // Simple heuristic: if any answer contains disqualifying keywords, mark disqualified
    // Frontend should send explicit qualificationStatus based on DQ flags for accuracy
    finalQualification = 'QUALIFIED';
  }

  const contactName = contact?.name || contact?.fullName || '';
  const email = contact?.email || '';
  const phone = contact?.phone || '';

  const noteParts: string[] = [];
  if (answers) noteParts.push(`Quiz answers: ${JSON.stringify(answers, null, 2)}`);
  if (quizData) noteParts.push(`Quiz detail: ${JSON.stringify(quizData, null, 2)}`);
  if (offerId) noteParts.push(`OfferId: ${offerId}`);
  if (sourceUrl) noteParts.push(`Source URL: ${sourceUrl}`);
  if (visitorId) noteParts.push(`visitor_id: ${visitorId}`);
  if (utmSource) noteParts.push(`UTM source: ${utmSource}`);
  if (utmMedium) noteParts.push(`UTM medium: ${utmMedium}`);
  if (utmCampaign) noteParts.push(`UTM campaign: ${utmCampaign}`);
  if (utmContent) noteParts.push(`UTM content: ${utmContent}`);
  if (utmTerm) noteParts.push(`UTM term: ${utmTerm}`);
  if (fbclid) noteParts.push(`fbclid: ${fbclid}`);
  if (gclid) noteParts.push(`gclid: ${gclid}`);
  const note = noteParts.join('\n\n').slice(0, 9000);

  // Build note with contact + answers for reliable storage (EMAILS type is finicky)
  const contactNote = [`Name: ${contactName || '—'}`, `Email: ${email || '—'}`, `Phone: ${phone || '—'}`].join('\n');
  const fullNote = [contactNote, note].filter(Boolean).join('\n\n');
  const data: Record<string, any> = {
    ...(contactName && { contactName }),
    ...(fullNote && { note: fullNote }),
    ...(source && { source }),
    ...(finalQualification && { qualificationStatus: finalQualification }),
    // Also set legacy status for compatibility
    ...(finalQualification === 'QUALIFIED' ? { status: 'QUALIFIED' } : finalQualification === 'DISQUALIFIED' ? { status: 'LOST' } : {}),
    name: contactName || email || `Lead ${new Date().toISOString().slice(0,10)}`,
  };
  console.log('[leads] data keys', Object.keys(data));

  // Relation to prospect if provided
  // agencyLead has agencyProspect relation field - try to set if prospectId provided
  // Twenty relation expects { connect: { id: prospectId } } or just prospectId string; try both
  if (prospectId) {
    // attempt to set relation; Twenty will ignore if invalid
    (data as any).agencyProspect = { connect: { id: prospectId } };
  }

  log.info(`Creating agencyLead: ${JSON.stringify({ ...data, email, phone }).substring(0, 600)}`);
  console.log('[leads] creating', JSON.stringify(data, null, 2).slice(0, 800));

  const created = await twentyClient.create<TwentyRecord>(OBJECT_NAME, data);
  log.info(`Created agencyLead ${created.id} qualification=${finalQualification}`);
  return created;
}

/**
 * POST /api/leads
 * Create a new agencyLead from quiz submission
 * Body: { offerId, answers: Record<string,string>, contact?: { name,email,phone }, qualificationStatus?: 'QUALIFIED'|'DISQUALIFIED', source?: string, prospectId?: string }
 */
router.post("/", async (req, res) => {
  try {
    // Public endpoint for funnel — allow without auth but also support auth
    const created = await createAgencyLead(req.body);
    res.status(201).json(created);
  } catch (err: any) {
    log.error("Error creating agencyLead:", err.message);
    console.error('[leads] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const leads = await twentyClient.list<TwentyRecord>(OBJECT_NAME, 100);
    res.json(leads);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    log.info(`Deleting agencyLead ${id} (preview reset - clearing from Twenty)`);
    console.log('[leads] deleting', id);
    await twentyClient.delete(OBJECT_NAME, id);
    log.info(`Deleted agencyLead ${id}`);
    res.json({ success: true });
  } catch (err: any) {
    log.error(`Error deleting agencyLead ${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export { router };
export default router;
