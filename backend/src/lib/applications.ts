/**
 * Twenty write for an applicant's submission through a RECRUITMENT funnel.
 *
 * A recruitment funnel writes to `agencyCareerApplication`, not
 * `agencyLeads`. The two objects answer different questions: a lead is
 * someone who may buy, an application is someone who wants a job, and
 * conflating them would put applicants in the dialer's call list.
 */
import { twentyClient, type TwentyRecord } from "../lib/twenty-client.js";
import { createLogger } from "../lib/logger.js";
import {
  extractApplicant,
  invalidOptions,
  missingRequired,
  normalizeQuestionnaire,
  validateApplicantEmail,
  type CareerStep,
} from "../lib/career-questionnaire.js";
import type { ApplicationConfig } from "../lib/career-questionnaire.js";

const log = createLogger("applications");
const OBJECT_NAME = "agencyCareerApplications";

export type CareerRecord = {
  id: string;
  slug?: string;
  name?: string;
  title?: string;
  status?: string;
  body?: unknown;
};

export type SubmitApplicationInput = {
  career: CareerRecord;
  offerId?: string;
  answers: Record<string, string>;
  /** Video link. Required unless the offer's applicationConfig opts out. */
  videoUrl?: string;
  videoNote?: string;
  config?: ApplicationConfig | null;
  sourceUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  visitorId?: string;
};

export type SubmitResult =
  | { ok: true; applicationId: string; steps: CareerStep[] }
  | { ok: false; status: number; error: string };

function videoRequired(config: ApplicationConfig | null | undefined): boolean {
  if (!config) return true;
  if (typeof config.videoRequired === "boolean") return config.videoRequired;
  // No explicit flag: ask for a video only when the offer actually configured
  // the field, so a blank applicationConfig does not block every applicant.
  return typeof config.videoLabel === "string" && config.videoLabel.trim().length > 0;
}

/**
 * Validate and write one application. Returns the normalised steps on success
 * so the caller can log what the applicant actually saw.
 */
export async function submitApplication(
  input: SubmitApplicationInput,
): Promise<SubmitResult> {
  const { steps } = normalizeQuestionnaire(input.career.body);

  const missing = missingRequired(steps, input.answers);
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `missing required answers: ${missing.map((s) => s.id).join(", ")}`,
    };
  }

  const impossible = invalidOptions(steps, input.answers);
  if (impossible.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `answer is not a valid option: ${impossible.map((s) => s.id).join(", ")}`,
    };
  }

  const applicant = extractApplicant(steps, input.answers);
  if (!applicant) {
    return { ok: false, status: 400, error: "name and email are required" };
  }
  if (!validateApplicantEmail(applicant.email)) {
    return { ok: false, status: 400, error: "email is not a valid address" };
  }

  if (videoRequired(input.config)) {
    if (!input.videoUrl || input.videoUrl.trim().length === 0) {
      return { ok: false, status: 400, error: "a video link is required" };
    }
    if (!/^https?:\/\//i.test(input.videoUrl.trim())) {
      return { ok: false, status: 400, error: "video link must start with http:// or https://" };
    }
  }

  const roleSlug = String(input.career.slug ?? "");
  const roleTitle = String(input.career.title ?? input.career.name ?? roleSlug);

  // Acquisition context. `agencyCareerApplication` has no `note` field — the
  // free-text column every other object here uses does not exist on this one —
  // so it rides inside the one RAW_JSON column the object does have, under a
  // reserved key. Keeping it out of `answers` proper means the screening
  // answers stay exactly what the applicant typed.
  const context: Record<string, string> = {};
  if (input.sourceUrl) context.sourceUrl = input.sourceUrl;
  if (input.visitorId) context.visitor_id = input.visitorId;
  if (input.utmSource) context.utmSource = input.utmSource;
  if (input.utmMedium) context.utmMedium = input.utmMedium;
  if (input.utmCampaign) context.utmCampaign = input.utmCampaign;

  const data: Record<string, any> = {
    name: applicant.name,
    email: applicant.email,
    roleSlug,
    roleTitle,
    answers:
      Object.keys(context).length > 0
        ? { ...input.answers, _context: context }
        : input.answers,
    status: "NEW",
    submittedAt: new Date().toISOString(),
    ...(applicant.phone && { phone: applicant.phone }),
    ...(applicant.resumeUrl && { resumeUrl: applicant.resumeUrl }),
    ...(input.videoUrl?.trim() && { videoUrl: input.videoUrl.trim() }),
    ...(input.videoNote?.trim() && { videoNote: input.videoNote.trim() }),
    ...(input.offerId && { offerId: input.offerId }),
  };

  const created = await twentyClient.create<TwentyRecord>(OBJECT_NAME, data);
  log.info(
    `Created agencyCareerApplication ${created.id} role=${roleSlug} video=${Boolean(input.videoUrl?.trim())}`,
  );
  return { ok: true, applicationId: created.id, steps };
}
