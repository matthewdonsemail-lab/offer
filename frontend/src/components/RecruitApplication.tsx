import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type ApplicationSection = {
  id: string;
  type: 'text' | 'email' | 'textarea' | 'select' | 'file';
  label: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
};

export type ApplicationStep = {
  id: string;
  kind: 'fields';
  title?: string;
  description?: string;
  sections: ApplicationSection[];
};

export type ApplicationConfig = {
  videoPrompt?: string;
  videoLabel?: string;
  videoPlaceholder?: string;
  videoRequired?: boolean;
  submitNote?: string;
  submittedHeading?: string;
  submittedBody?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * The video link is a URL, not a file. A serverless function caps a multipart
 * body at 4.5MB, which is well under a single phone video, so an upload here
 * would fail silently for exactly the applicants we care about. A Loom /
 * Vimeo / Drive link is one field, works on a phone, and is what the listing
 * already asks for.
 */
function isValidVideoLink(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * The recruitment counterpart to `Quiz`, and it walks the same road the quiz
 * does: one card, a progress bar, a "Step N of M" eyebrow, questions sliding in
 * and out, Back / Continue. The quiz ends in a Calendly slot; this ends in a
 * submitted video link, and the questionnaire steps come from the career
 * record rather than being authored in the editor.
 *
 * The wizard is deliberately linear. An applicant cannot jump ahead, so an
 * unanswered required question blocks progress at the step that caused it
 * instead of surfacing as a wall of red on submit.
 */
export function RecruitApplication({
  steps,
  config,
  roleTitle,
  offerId,
  metaPixelId,
  endpoints,
  onSubmitted,
  onHeightChange,
}: {
  steps: ApplicationStep[];
  config?: ApplicationConfig | null;
  roleTitle?: string;
  offerId: string;
  metaPixelId?: string;
  endpoints: { submit: string };
  onSubmitted?: (applicationId: string) => void;
  onHeightChange?: () => void;
}) {
  const videoRequired =
    typeof config?.videoRequired === 'boolean'
      ? config.videoRequired
      : typeof config?.videoLabel === 'string' && config.videoLabel.trim().length > 0;
  const hasVideoStep = Boolean(config?.videoPrompt || config?.videoLabel || videoRequired);

  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [videoUrl, setVideoUrl] = React.useState('');
  const [videoNote, setVideoNote] = React.useState('');
  const [index, setIndex] = React.useState(0);
  const [showErrors, setShowErrors] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [applicationId, setApplicationId] = React.useState<string | null>(null);
  const [direction, setDirection] = React.useState(1);

  // The video question is a step like any other, appended after the
  // questionnaire the career record authored.
  const wizard: Array<
    { kind: 'fields'; id: string; title?: string; description?: string; sections: ApplicationSection[] } | { kind: 'video' }
  > = React.useMemo(
    () => [
      ...steps.map((step) => ({ ...step, kind: 'fields' as const })),
      ...(hasVideoStep ? ([{ kind: 'video' as const }]) : []),
    ],
    [steps, hasVideoStep],
  );

  const total = wizard.length;
  const current = wizard[index];
  const isLast = index === total - 1;

  React.useEffect(() => {
    onHeightChange?.();
  }, [answers, videoUrl, videoNote, index, submitError, applicationId, onHeightChange]);

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    if (showErrors) setShowErrors(false);
  }

  function sectionError(section: ApplicationSection): string | null {
    const value = (answers[section.id] ?? '').trim();
    if (section.required && value.length === 0) return 'This answer is required';
    if (section.type === 'email' && value.length > 0 && !isValidEmail(value)) {
      return 'Enter a valid email address';
    }
    if (section.type === 'select' && value.length > 0 && section.options && !section.options.includes(value)) {
      return 'Choose one of the listed options';
    }
    return null;
  }

  const videoError =
    videoRequired && videoUrl.trim().length === 0
      ? 'A video link is required'
      : videoUrl.trim().length > 0 && !isValidVideoLink(videoUrl)
        ? 'The link must start with http:// or https://'
        : null;

  /** Errors for the step on screen — never for steps the applicant cannot see. */
  function currentStepError(): string | null {
    if (current?.kind === 'video') return videoError;
    if (current?.kind !== 'fields') return null;
    for (const section of current.sections) {
      const err = sectionError(section);
      if (err) return err;
    }
    return null;
  }

  const canAdvance = currentStepError() === null;

  function goNext() {
    if (!canAdvance || isLast) {
      if (!canAdvance) {
        setShowErrors(true);
        onHeightChange?.();
      }
      return;
    }
    setDirection(1);
    setShowErrors(false);
    setIndex((i) => Math.min(i + 1, total - 1));
  }

  function goBack() {
    if (index === 0) return;
    setDirection(-1);
    setShowErrors(false);
    setIndex((i) => Math.max(i - 1, 0));
  }

  async function handleSubmit() {
    if (submitting) return;
    if (!canAdvance) {
      setShowErrors(true);
      onHeightChange?.();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    if (metaPixelId && (window as any).fbq) {
      try {
        (window as any).fbq('track', 'Lead', {
          content_name: roleTitle || 'career application',
          content_category: 'application',
          value: 1.0,
          currency: 'USD',
        });
      } catch {
        // Pixel failures must never block a real application.
      }
    }

    const params = new URLSearchParams(window.location.search);
    try {
      const res = await fetch(endpoints.submit, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId,
          answers,
          videoUrl: videoUrl.trim() || undefined,
          videoNote: videoNote.trim() || undefined,
          sourceUrl: window.location.href,
          visitorId: params.get('visitor_id') || undefined,
          utmSource: params.get('utm_source') || undefined,
          utmMedium: params.get('utm_medium') || undefined,
          utmCampaign: params.get('utm_campaign') || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to submit your application');
      setApplicationId(data.applicationId ?? null);
      onSubmitted?.(data.applicationId);
      onHeightChange?.();
    } catch (err: any) {
      setSubmitError(err.message || 'Failed to submit');
      onHeightChange?.();
    } finally {
      setSubmitting(false);
    }
  }

  if (applicationId) {
    const heading = config?.submittedHeading || 'Application received';
    const body = (config?.submittedBody || '').replace(/\{\{\s*role\s*\}\}/gi, roleTitle || 'the role');
    return (
      <div id="application-submitted" className="mx-auto mt-4 max-w-2xl rounded-2xl border border-[var(--ods-border,#e5e7eb)] bg-white p-6 shadow-sm md:p-8">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="text-center"
        >
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-green-500/10">
            <svg className="size-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="font-heading text-2xl font-bold text-[#0D2A4C]" style={{ fontFamily: 'Satoshi, sans-serif' }}>
            {heading}
          </h3>
          {body ? (
            <p className="mx-auto mt-2 max-w-md text-[15px] text-[#0D2A4C]/60">{body}</p>
          ) : null}
        </motion.div>
      </div>
    );
  }

  const progress = total > 0 ? ((index + (canAdvance ? 1 : 0)) / total) * 100 : 0;

  return (
    <div id="application" className="mt-8">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative mx-auto mt-4 max-w-2xl rounded-2xl border border-[var(--ods-border,#e5e7eb)] bg-white p-6 shadow-sm md:p-8"
      >
        {roleTitle ? (
          <div className="text-center">
            <h3 className="font-heading text-xl font-bold text-[#0D2A4C] md:text-2xl" style={{ fontFamily: 'Satoshi, sans-serif' }}>
              Apply — {roleTitle}
            </h3>
          </div>
        ) : null}

        <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-[var(--ods-bg-secondary,#f0f0f3)]">
          <motion.div
            className="h-full rounded-full bg-[#2563eb]"
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>

        <div className="mt-8 min-h-[200px]">
          <AnimatePresence mode="wait" custom={direction}>
            {current?.kind === 'fields' ? (
              <motion.div
                key={current.id}
                id="application-step"
                initial={{ opacity: 0, x: direction * 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * -24 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <p className="text-center text-xs font-medium uppercase tracking-wider text-[#0D2A4C]/40 mb-2">
                  Step {index + 1} of {total}
                </p>
                <p
                  className="text-center text-lg font-bold text-[#0D2A4C] md:text-xl"
                  style={{ fontFamily: 'Satoshi, sans-serif' }}
                >
                  {current.title || (roleTitle ? `Apply for ${roleTitle}` : 'Application')}
                </p>
                {current.description ? (
                  <p className="mx-auto mt-2 max-w-md text-center text-sm text-[#0D2A4C]/60">{current.description}</p>
                ) : null}

                <div className="mt-6 space-y-4 text-left">
                  {current.sections.map((section) => {
                    const value = answers[section.id] ?? '';
                    const error = showErrors ? sectionError(section) : null;
                    const inputClass =
                      'w-full rounded-[8px] border bg-white px-3 py-2.5 text-[14px] text-[#0D2A4C] focus:outline-none focus:border-[#2563eb]';
                    const borderClass = error ? 'border-red-300' : 'border-[var(--ods-border,#e5e7eb)]';
                    return (
                      <div key={section.id}>
                        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-[var(--ods-text-tertiary,#8a8a93)]">
                          {section.label}
                          {section.required ? <span className="ml-1 text-red-500">*</span> : null}
                        </label>
                        {section.type === 'select' ? (
                          <select
                            value={value}
                            onChange={(e) => setAnswer(section.id, e.target.value)}
                            className={`${inputClass} ${borderClass}`}
                          >
                            <option value="">Choose…</option>
                            {(section.options ?? []).map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : section.type === 'textarea' ? (
                          <textarea
                            value={value}
                            rows={4}
                            placeholder={section.placeholder}
                            onChange={(e) => setAnswer(section.id, e.target.value)}
                            className={`${inputClass} ${borderClass}`}
                          />
                        ) : section.type === 'file' ? (
                          <input
                            type="url"
                            value={value}
                            placeholder="Paste a link to your file (Drive, Dropbox, Notion)"
                            onChange={(e) => setAnswer(section.id, e.target.value)}
                            className={`${inputClass} ${borderClass}`}
                          />
                        ) : (
                          <input
                            type={section.type === 'email' ? 'email' : 'text'}
                            value={value}
                            placeholder={section.placeholder}
                            onChange={(e) => setAnswer(section.id, e.target.value)}
                            className={`${inputClass} ${borderClass}`}
                          />
                        )}
                        {error ? <p className="mt-1 text-[12px] text-red-600">{error}</p> : null}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            ) : current?.kind === 'video' ? (
              <motion.div
                key="video"
                id="application-step"
                initial={{ opacity: 0, x: direction * 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * -24 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="text-left"
              >
                <p className="text-center text-xs font-medium uppercase tracking-wider text-[#0D2A4C]/40 mb-2">
                  Step {index + 1} of {total}
                </p>
                <p
                  className="text-center text-lg font-bold text-[#0D2A4C] md:text-xl"
                  style={{ fontFamily: 'Satoshi, sans-serif' }}
                >
                  {config?.videoPrompt || 'Record a short video'}
                </p>
                <div className="mt-6 space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-[var(--ods-text-tertiary,#8a8a93)]">
                      {config?.videoLabel || 'Video link'}
                      {videoRequired ? <span className="ml-1 text-red-500">*</span> : null}
                    </label>
                    <input
                      type="url"
                      value={videoUrl}
                      placeholder={config?.videoPlaceholder || 'https://www.loom.com/share/…'}
                      onChange={(e) => {
                        setVideoUrl(e.target.value);
                        if (showErrors) setShowErrors(false);
                      }}
                      className={`w-full rounded-[8px] border bg-white px-3 py-2.5 text-[14px] text-[#0D2A4C] focus:outline-none focus:border-[#2563eb] ${
                        showErrors && videoError ? 'border-red-300' : 'border-[var(--ods-border,#e5e7eb)]'
                      }`}
                    />
                    {showErrors && videoError ? (
                      <p className="mt-1 text-[12px] text-red-600">{videoError}</p>
                    ) : null}
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-[var(--ods-text-tertiary,#8a8a93)]">
                      Anything we should know? <span className="font-normal normal-case">(optional)</span>
                    </label>
                    <textarea
                      value={videoNote}
                      rows={3}
                      onChange={(e) => setVideoNote(e.target.value)}
                      className="w-full rounded-[8px] border border-[var(--ods-border,#e5e7eb)] bg-white px-3 py-2.5 text-[14px] text-[#0D2A4C] focus:border-[#2563eb] focus:outline-none"
                    />
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {submitError ? (
          <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">{submitError}</p>
        ) : null}

        <div className="mt-8 flex items-center gap-3">
          {index > 0 ? (
            <button
              type="button"
              onClick={goBack}
              className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg border border-[var(--ods-border,#e5e7eb)] px-5 text-[14px] font-semibold text-[#0D2A4C]/70 transition-colors hover:bg-[var(--ods-bg-secondary,#f8f9fc)]"
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            onClick={isLast ? handleSubmit : goNext}
            disabled={submitting}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-[#2563eb] text-[14px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.3)] transition-colors hover:bg-[#1d4ed8] disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : isLast ? 'Submit application' : 'Continue →'}
          </button>
        </div>

        {isLast && config?.submitNote ? (
          <p className="mt-3 text-center text-[12px] text-[#0D2A4C]/50">{config.submitNote}</p>
        ) : null}
      </motion.div>
    </div>
  );
}
