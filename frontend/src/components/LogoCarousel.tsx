import { resolveAreaTokens } from '@/lib/resolveTokens';

export type LogoCarouselLogo = {
  src: string;
  alt?: string;
  href?: string;
};

type LogoCarouselProps = {
  logos?: LogoCarouselLogo[];
  /** Heading HTML (RichEditor). Hidden when blank. */
  heading?: string;
  /** Description markdown (RichEditor, {{area}} supported). Hidden when blank. */
  descMarkdown?: string;
  /** Prospect area for {{area}}/{{city}} tokens. */
  area?: string;
  /** false on the public funnel: an unknown area reads "your area", never {{area}}. */
  keepTokenIfMissing?: boolean;
};

/**
 * Worked-with logo carousel rendered BELOW the quiz (never inside it).
 * Heading + description come from the offer object (RichEditor-managed);
 * art is navy-tinted; the row auto-scrolls slowly and pauses on hover.
 */
export function LogoCarousel({ logos, heading, descMarkdown, area, keepTokenIfMissing = true }: LogoCarouselProps) {
  const cleaned = (logos || []).filter(
    (l) => l && typeof l.src === 'string' && l.src.length > 0,
  ).map((l) => ({
    src: l.src,
    alt: typeof l.alt === 'string' ? l.alt : undefined,
    href: typeof l.href === 'string' && l.href.length > 0 ? l.href : undefined,
  }));
  if (cleaned.length === 0) return null;
  const hasHeading = !!(heading && heading.trim().length > 0);
  // One seamless unit must overflow the viewport on its own, otherwise the
  // loop shows empty space. Repeat the set (cap total at 40 nodes), then
  // duplicate the unit — translateX(-50%) lands exactly on the seam.
  const reps = Math.max(1, Math.min(6, Math.ceil(40 / Math.max(1, cleaned.length * 2))));
  const unit: typeof cleaned = [];
  for (let r = 0; r < reps; r++) unit.push(...cleaned);
  const row = [...unit, ...unit];

  const headingHtml = hasHeading
    ? resolveAreaTokens(heading, { area, keepTokenIfMissing })
    : null;
  const descHtml =
    descMarkdown && descMarkdown.trim().length > 0
      ? resolveAreaTokens(descMarkdown, { area, keepTokenIfMissing })
      : null;

  return (
    <section className="mx-auto w-full max-w-5xl px-6 pb-16 pt-14">
      <style>{`@keyframes logo-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}.logo-marquee-track{animation:logo-marquee 64s linear infinite}.logo-marquee:hover .logo-marquee-track{animation-play-state:paused}`}</style>
      {headingHtml && (
        <h2
          className="mb-6 text-center font-heading text-2xl font-bold text-[#0D2A4C] md:text-3xl"
          style={{ fontFamily: 'Satoshi, sans-serif' }}
        >
          <span dangerouslySetInnerHTML={{ __html: headingHtml }} />
        </h2>
      )}
      <div className="logo-marquee overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="logo-marquee-track flex w-max items-center gap-14 pr-14">
          {row.map((logo, i) => {
            const img = (
              <img
                src={logo.src}
                alt={logo.alt || 'Client logo'}
                loading="lazy"
                draggable={false}
                aria-hidden={i >= unit.length}
                className="h-10 w-auto max-w-[150px] shrink-0 select-none object-contain opacity-80 transition hover:opacity-100 [filter:brightness(0)_saturate(100%)_invert(14%)_sepia(60%)_saturate(1800%)_hue-rotate(195deg)]"
              />
            );
            return logo.href ? (
              <a
                key={`${logo.src}-${i}`}
                href={logo.href}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 [scroll-snap-align:center]"
                aria-hidden={i >= unit.length}
              >
                {img}
              </a>
            ) : (
              <span key={`${logo.src}-${i}`} className="shrink-0 [scroll-snap-align:center]" aria-hidden={i >= unit.length}>
                {img}
              </span>
            );
          })}
        </div>
      </div>
      {descHtml && (
        <p className="mx-auto mt-6 max-w-2xl text-center text-[15px] leading-relaxed text-[#0D2A4C]/70 md:text-base">
          <span dangerouslySetInnerHTML={{ __html: descHtml }} />
        </p>
      )}
    </section>
  );
}
