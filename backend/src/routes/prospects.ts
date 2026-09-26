import { Router } from "express";
import { twentyClient, type TwentyRecord } from "../lib/twenty-client.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";

const router = Router();
const log = createLogger('prospects');

// Supports both agencyProspects and agencyLeads — try prospects first
const OBJECTS = ["agencyProspects", "agencyLeads", "prospects", "leads"];

/** Unwrap a Twenty SELECT ({ value }) or a plain string to its string value. */
function selValue(v: unknown): string {
  return String((v as any)?.value ?? v ?? "");
}

/** Extract an id from a relation field (string id or { id } object). */
function relationId(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const id = (v as any).id;
    if (typeof id === "string") return id;
  }
  return "";
}

router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    // Optional: only return prospects whose effective industry matches this
    // offer's industryId (the linked campaign's industryId, else the prospect
    // label) — mirrors resolveIndustryRouting() in public.ts so the preview
    // picker only surfaces prospects the offer actually serves.
    const requestedIndustry = String(req.query.industryId ?? "").trim() || null;
    log.info(`Listing prospects/leads from Twenty${requestedIndustry ? ` (industry=${requestedIndustry})` : ""}`);
    let records: TwentyRecord[] = [];
    let usedObject = "";
    for (const obj of OBJECTS) {
      try {
        const fetched = await twentyClient.list<TwentyRecord>(obj, 100);
        if (fetched.length > 0) {
          records = fetched;
          usedObject = obj;
          break;
        }
        // keep first empty result as fallback
        if (!usedObject) usedObject = obj;
      } catch (e: any) {
        log.warn(`Failed to list ${obj}: ${e.message}`);
      }
    }

    // campaignId -> industryId SELECT value, so we can resolve each prospect's
    // effective industry without an N+1 per-prospect campaign fetch.
    let campaignIndustry = new Map<string, string>();
    if (requestedIndustry) {
      try {
        const campaigns = await twentyClient.list<TwentyRecord>("agencyCampaigns", 200);
        for (const c of campaigns as any[]) {
          const cid = String(c.id ?? "");
          const ind = selValue(c.industryId);
          if (cid && ind) campaignIndustry.set(cid, ind);
        }
      } catch (e: any) {
        log.warn(`Failed to list agencyCampaigns: ${e.message}`);
      }
    }

    // normalize to display name (keep city/region so preview can resolve {{area}})
    const normalized = records.map((r: any) => {
      const label = selValue(r.label);
      const linkedId = relationId(r.campaignId ?? r.campaignIdId);
      const industryId = linkedId ? campaignIndustry.get(linkedId) || label : label;
      return {
        id: r.id,
        displayName: [r.firstName, r.lastName].filter(Boolean).join(' ') || (r.first_name ? `${r.first_name} ${r.last_name}`.trim() : r.name || r.company || r.email || r.id),
        firstName: r.firstName || r.first_name,
        lastName: r.lastName || r.last_name,
        company: r.company,
        email: r.email,
        city: r.city,
        region: r.region,
        industryId,
        raw: r,
      };
    }).filter((p: any) => !requestedIndustry || p.industryId === requestedIndustry);
    log.info(`Returning ${normalized.length} prospects from ${usedObject}`);
    res.json(normalized);
  } catch (err: any) {
    log.error("Error listing prospects:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export { router };
export default router;
