/**
 * Career questionnaire schema + coercion, ported from ui-kit
 * `lib/agency-career/questionnaire.ts` so the offer funnel can read
 * `agencyCareers.body.questionnaireSteps` without a cross-repo import.
 *
 * Source of truth stays the Twenty record. This module only normalises and
 * validates it: anything it drops is reported back to the caller so a broken
 * step is visible rather than silently skipped.
 */

export type CareerSectionType =
  | "text"
  | "email"
  | "textarea"
  | "select"
  | "file";

export type CareerSection = {
  id: string;
  type: CareerSectionType;
  label: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
};

export type CareerFieldsStep = {
  id: string;
  kind: "fields";
  title?: string;
  description?: string;
  sections: CareerSection[];
};

export type CareerReviewStep = {
  id: string;
  kind: "review";
  title?: string;
};

export type CareerStep = CareerFieldsStep | CareerReviewStep;

/** The offer's own copy for the application step; `null` means "no video ask". */
export type ApplicationConfig = {
  /** Prompt shown above the video field. Rendered as plain text. */
  videoPrompt?: string;
  /** Label for the video input. */
  videoLabel?: string;
  /** Placeholder for the video link input. */
  videoPlaceholder?: string;
  /** Make the video link mandatory. Default true when videoLabel is set. */
  videoRequired?: boolean;
  /** Copy under the submit button. */
  submitNote?: string;
  /** Heading on the confirmation screen. */
  submittedHeading?: string;
  /** Body copy on the confirmation screen. Supports {{role}}. */
  submittedBody?: string;
};

const SUPPORTED_TYPES = new Set<CareerSectionType>([
  "text",
  "email",
  "textarea",
  "select",
  "file",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function coerceRequired(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function coerceSectionType(value: unknown): CareerSectionType | null {
  const raw = asString(value)?.toLowerCase();
  if (!raw) return null;
  return SUPPORTED_TYPES.has(raw as CareerSectionType) ? (raw as CareerSectionType) : null;
}

function coerceOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  return options.length > 0 ? options : undefined;
}

export function coerceSection(value: unknown): CareerSection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  const type = coerceSectionType(raw.type);
  const label = asString(raw.label);
  if (!id || !type || !label) return null;

  const section: CareerSection = { id, type, label, required: coerceRequired(raw.required) };
  const placeholder = asString(raw.placeholder);
  if (placeholder) section.placeholder = placeholder;
  const options = coerceOptions(raw.options);
  if (type === "select" && options) section.options = options;
  return section;
}

export function isReviewStep(step: CareerStep): step is CareerReviewStep {
  return step.kind === "review";
}

export function isFieldsStep(step: CareerStep): step is FieldsGuard {
  return !isReviewStep(step);
}
type FieldsGuard = CareerFieldsStep;

function coerceStep(value: unknown): CareerStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  if (!id) return null;

  if (asString(raw.kind)?.toLowerCase() === "review") {
    const title = asString(raw.title);
    return title ? { id, kind: "review", title } : { id, kind: "review" };
  }

  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : [];
  const sections = sectionsRaw
    .map(coerceSection)
    .filter((section): section is CareerSection => section !== null);
  if (sections.length === 0) return null;

  const step: CareerFieldsStep = { id, kind: "fields", sections };
  const title = asString(raw.title);
  if (title) step.title = title;
  const description = asString(raw.description);
  if (description) step.description = description;
  return step;
}

export type NormalizeResult = {
  steps: CareerStep[];
  droppedStepIds: string[];
};

/**
 * Normalise a career `body` into renderable steps. A career with no
 * questionnaire yields an empty list — the funnel then shows contact and
 * video capture only, which is a valid application, not an error.
 */
export function normalizeQuestionnaire(body: unknown): NormalizeResult {
  const droppedStepIds: string[] = [];
  const steps: CareerStep[] = [];
  const raw = (body ?? {}) as Record<string, unknown>;

  const rawSteps = Array.isArray(raw.questionnaireSteps)
    ? raw.questionnaireSteps
    : Array.isArray(raw.questionnaireSections)
      ? // Legacy shape: one field per step.
        (raw.questionnaireSections as unknown[]).map((section) => ({
          id: (section as Record<string, unknown>)?.id,
          title: (section as Record<string, unknown>)?.label,
          kind: "fields",
          sections: [section],
        }))
      : [];

  for (const rawStep of rawSteps) {
    const coerced = coerceStep(rawStep);
    if (!coerced) {
      const rawId =
        rawStep && typeof rawStep === "object"
          ? asString((rawStep as Record<string, unknown>).id)
          : undefined;
      droppedStepIds.push(rawId ?? "(unknown)");
      continue;
    }
    steps.push(coerced);
  }

  // The funnel renders the review step itself; never inherit one from the
  // career record or it shows an empty summary.
  return { steps: steps.filter((step) => !isReviewStep(step)), droppedStepIds };
}

export function fieldSteps(steps: CareerStep[]): CareerFieldsStep[] {
  return steps.filter(isFieldsStep);
}

export function allSections(steps: CareerStep[]): CareerSection[] {
  return fieldSteps(steps).flatMap((step) => step.sections);
}

function sectionValue(answers: Record<string, string>, sectionId: string): string {
  return (answers[sectionId] ?? "").trim();
}

/** Sections the applicant must fill before submit is enabled. */
export function missingRequired(
  steps: CareerStep[],
  answers: Record<string, string>,
): CareerSection[] {
  return allSections(steps).filter(
    (section) => section.required && sectionValue(answers, section.id).length === 0,
  );
}

/**
 * Answers that are present but impossible: a `select` answer outside the
 * options the career record defines. The form cannot produce this, but the
 * endpoint is public, and `answers` is the record we screen applicants on —
 * an unchecked write would let junk land there silently.
 */
export function invalidOptions(
  steps: CareerStep[],
  answers: Record<string, string>,
): CareerSection[] {
  return allSections(steps).filter((section) => {
    if (section.type !== "select" || !section.options) return false;
    const value = sectionValue(answers, section.id);
    return value.length > 0 && !section.options.includes(value);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Name/email/phone lifted out of the answers by section id, matching the
 * career-questionnaire convention the ui-kit apply form already uses.
 * Returns null when the two required fields are absent.
 */
export function extractApplicant(
  steps: CareerStep[],
  answers: Record<string, string>,
): { name: string; email: string; phone?: string; resumeUrl?: string } | null {
  const name = sectionValue(answers, "name");
  const email = sectionValue(answers, "email").toLowerCase();
  if (!name || !email) return null;
  return {
    name,
    email,
    phone: sectionValue(answers, "phone") || undefined,
    resumeUrl: sectionValue(answers, "resume") || undefined,
  };
}

export function validateApplicantEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}
