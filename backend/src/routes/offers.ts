import { Router } from "express";
import multer from "multer";
import { twentyClient, type TwentyRecord } from "../lib/twenty-client.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";

const router = Router();
const log = createLogger('offers');
const OBJECT_NAME = "agencyOffers";

const R2_PUBLIC_BASE = "https://pub-a08f5a2ef38748ca9d1249279659fc2e.r2.dev";

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^(image\/svg\+xml|image\/png|image\/jpeg|image\/webp)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only SVG, PNG, JPEG, or WebP logos are allowed"));
    }
  },
});

/**
 * POST /api/offers/logo-upload
 * Authenticated brand-logo upload: stores the file in R2 under logos/ and
 * returns the public URL for brandLogoUrl. Small files only (2MB).
 */
router.post("/logo-upload", authMiddleware, (req: AuthRequest, res) => {
  logoUpload.single("logo")(req as any, res as any, async (err: any) => {
    if (err) {
      log.error("Logo upload rejected:", err.message);
      res.status(400).json({ error: err.message });
      return;
    }
    try {
      const file = (req as any).file;
      if (!file) {
        res.status(400).json({ error: "No logo file provided" });
        return;
      }
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_R2_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
      const bucket = process.env.R2_BUCKET;
      if (!accountId || !apiToken || !bucket) {
        res.status(500).json({ error: "R2 storage is not configured on the server" });
        return;
      }
      const safe = file.originalname.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "logo";
      const key = `logos/${Date.now()}-${safe}`;
      const put = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": file.mimetype,
            "Cache-Control": "public, max-age=31536000, immutable",
          },
          body: file.buffer,
        },
      );
      if (!put.ok) {
        const text = await put.text();
        throw new Error(`R2 upload failed: ${put.status} ${text.slice(0, 200)}`);
      }
      const url = `${R2_PUBLIC_BASE}/${key}`;
      log.info(`Logo uploaded: ${url} (${file.size} bytes)`);
      res.json({ url });
    } catch (e: any) {
      log.error("Logo upload failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });
});

/**
 * GET /api/offers/careers
 * Slug + title of every agencyCareers row, for the funnel-type selector in
 * the editor. Registered before `/:id` so "careers" is not read as a record
 * id. Authenticated: it is the editor's picker, not a public surface.
 */
router.get("/careers", authMiddleware, async (_req: AuthRequest, res) => {
  try {
    const careers = await twentyClient.list<TwentyRecord>("agencyCareers", 100);
    res.json(
      careers.map((row) => {
        const r = row as unknown as Record<string, any>;
        return {
          id: r.id,
          slug: r.slug ?? null,
          title: r.title ?? r.name ?? null,
          status: r.status ?? null,
        };
      }),
    );
  } catch (err: any) {
    log.error("Error listing careers:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/offers
 * List all agencyOffers from Twenty CRM
 */
router.get("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    log.info("Listing offers from Twenty CRM");
    const offers = await twentyClient.list<TwentyRecord>(OBJECT_NAME, 100);
    log.info(`Returning ${offers.length} offers`);
    res.json(offers);
  } catch (err: any) {
    log.error("Error listing offers:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/offers/:id
 * Get a single offer by ID
 */
router.get("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    log.info(`Fetching offer ${id}`);
    const offer = await twentyClient.get<TwentyRecord>(OBJECT_NAME, id);
    res.json(offer);
  } catch (err: any) {
    log.error(`Error fetching offer ${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offers
 * Create a new offer
 */
router.post("/", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { title, name, heroH1, heroLede, videoUrl, videoMode, industryId, status, ctaType, prospectId, quizConfig, quiz, calendlyUrl, thankYouConfig, disqualifiedConfig, metaPixelId, utmSwaps, mediaLogos, carouselHeading, carouselDesc, brandName, brandSub, brandLogoUrl, funnelType, careerSlug, applicationConfig } = req.body;
    
    const data: Record<string, any> = {
      ...(title && { title }),
      ...(name && { name }),
      ...(heroH1 && { heroH1 }),
      ...(heroLede && { heroLede }),
      ...(videoUrl && { videoUrl }),
      ...(videoMode && { videoMode }),
      ...(industryId && { industryId }),
      ...(status && { status }),
      ...(ctaType && { ctaType }),
      ...(prospectId && { prospectId }),
      ...((quizConfig !== undefined) && { quizConfig }),
      ...((quiz !== undefined) && { quizConfig: quiz }),
      ...(calendlyUrl !== undefined && { calendlyUrl }),
      ...(thankYouConfig !== undefined && { thankYouConfig }),
      ...(disqualifiedConfig !== undefined && { disqualifiedConfig }),
      ...(metaPixelId !== undefined && { metaPixelId }),
      ...(utmSwaps !== undefined && { utmSwaps }),
      ...(mediaLogos !== undefined && { mediaLogos }),
      ...(carouselHeading !== undefined && { carouselHeading }),
      ...(carouselDesc !== undefined && { carouselDesc }),
      ...(brandName !== undefined && { brandName }),
      ...(brandSub !== undefined && { brandSub }),
      ...(brandLogoUrl !== undefined && { brandLogoUrl }),
      ...(funnelType !== undefined && { funnelType }),
      ...(careerSlug !== undefined && { careerSlug }),
      ...(applicationConfig !== undefined && { applicationConfig }),
    };

    log.info(`Creating offer: ${JSON.stringify(data).substring(0, 200)}`);    const offer = await twentyClient.create<TwentyRecord>(OBJECT_NAME, data);
    log.info(`Created offer ${offer.id}`);
    res.status(201).json(offer);
  } catch (err: any) {
    log.error("Error creating offer:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/offers/:id
 * Update an existing offer
 */
router.patch("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    const { title, name, heroH1, heroLede, videoUrl, videoMode, industryId, status, ctaType, prospectId, quizConfig, quiz, calendlyUrl, thankYouConfig, disqualifiedConfig, metaPixelId, utmSwaps, mediaLogos, carouselHeading, carouselDesc, brandName, brandSub, brandLogoUrl, funnelType, careerSlug, applicationConfig } = req.body;
    
    const data: Record<string, any> = {};
    if (title !== undefined) data.title = title;
    if (name !== undefined) data.name = name;
    if (heroH1 !== undefined) data.heroH1 = heroH1;
    if (heroLede !== undefined) data.heroLede = heroLede;
    if (videoUrl !== undefined) data.videoUrl = videoUrl;
    if (videoMode !== undefined) data.videoMode = videoMode;
    if (industryId !== undefined) data.industryId = industryId;
    if (status !== undefined) data.status = status;
    if (ctaType !== undefined) data.ctaType = ctaType;
    if (prospectId !== undefined) data.prospectId = prospectId;
    if (quizConfig !== undefined) data.quizConfig = quizConfig;
    if (quiz !== undefined) data.quizConfig = quiz;
    if (calendlyUrl !== undefined) data.calendlyUrl = calendlyUrl;
    if (thankYouConfig !== undefined) data.thankYouConfig = thankYouConfig;
    if (disqualifiedConfig !== undefined) data.disqualifiedConfig = disqualifiedConfig;
    if (metaPixelId !== undefined) data.metaPixelId = metaPixelId;
    if (utmSwaps !== undefined) data.utmSwaps = utmSwaps;
    if (mediaLogos !== undefined) data.mediaLogos = mediaLogos;
    if (carouselHeading !== undefined) data.carouselHeading = carouselHeading;
    if (carouselDesc !== undefined) data.carouselDesc = carouselDesc;
    if (brandName !== undefined) data.brandName = brandName;
    if (brandSub !== undefined) data.brandSub = brandSub;
    if (brandLogoUrl !== undefined) data.brandLogoUrl = brandLogoUrl;
    if (funnelType !== undefined) data.funnelType = funnelType;
    if (careerSlug !== undefined) data.careerSlug = careerSlug;
    if (applicationConfig !== undefined) data.applicationConfig = applicationConfig;

    log.info(`Updating offer ${id}: ${JSON.stringify(data).substring(0, 200)}`);
    const offer = await twentyClient.update<TwentyRecord>(OBJECT_NAME, id, data);
    log.info(`Updated offer ${id}`);
    res.json(offer);
  } catch (err: any) {
    log.error(`Error updating offer ${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/offers/:id
 * Delete an offer
 */
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id as string;
    log.info(`Deleting offer ${id}`);
    await twentyClient.delete(OBJECT_NAME, id);
    log.info(`Deleted offer ${id}`);
    res.json({ success: true });
  } catch (err: any) {
    log.error(`Error deleting offer ${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export { router };
export default router;
