import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { Quiz } from '@/components/Quiz';
import { RecruitApplication, type ApplicationConfig, type ApplicationStep } from '@/components/RecruitApplication';
import { LogoCarousel } from '@/components/LogoCarousel';
import { FunnelVideo } from '@/components/FunnelVideo';
import { resolveAreaTokens } from '@/lib/resolveTokens';

interface OfferData {
  id: string;
  title?: string;
  name?: string;
  heroH1?: string;
  heroLede?: { markdown?: string; blocknote?: string | null };
  videoUrl?: {
    primaryLinkLabel?: string;
    primaryLinkUrl?: string;
    secondaryLinks?: any[];
  };
  createdAt?: string;
  status?: string;
  ctaType?: string;
  prospectId?: string;
  quizConfig?: any;
  quiz?: any;
  calendlyUrl?: string;
  metaPixelId?: string;
  /** LEAD (default) or RECRUITMENT. RECRUITMENT renders the application form. */
  funnelType?: string;
  careerSlug?: string;
  applicationConfig?: ApplicationConfig;
  /** Normalised from the agencyCareers record server-side; never authored here. */
  careerQuestionnaire?: ApplicationStep[];
  roleTitle?: string;
}

export function PreviewPage({ mode = 'preview', slug = 'default', careerSlug }: { mode?: 'public' | 'preview'; slug?: string; careerSlug?: string } = {}) {
  const { id, industryId, prospectKey: prospectRouteKey } = useParams<{ id: string; industryId: string; prospectKey: string }>();
  const [offer, setOffer] = React.useState<OfferData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [quizKey, setQuizKey] = React.useState(0);
  const [qualification, setQualification] = React.useState<string | null>(null);
  const [leadId, setLeadId] = React.useState<string | null>(null);
  const [meetingBooked, setMeetingBooked] = React.useState(false);
  const [applicationSubmitted, setApplicationSubmitted] = React.useState(false);
  const [refreshTick, setRefreshTick] = React.useState(0);
  // Public funnel has no :id param — fall back to the loaded offer id, then slug.
  const storageId = id || offer?.id || slug;

  // A RECRUITMENT funnel has no Calendly step and no qualification scoring.
  // `done` is whichever end state applies, so the hero/booked-view branches
  // below read the same for both funnel types.
  const isRecruitment =
    String((offer as any)?.funnelType ?? 'LEAD').toUpperCase() === 'RECRUITMENT';
  const done = isRecruitment ? applicationSubmitted : meetingBooked;

  const prospectKey = prospectRouteKey || (() => {
    try {
      return new URLSearchParams(window.location.search).get('prospect') || '';
    } catch {
      return '';
    }
  })();

  const [prospect, setProspect] = React.useState<{
    id?: string;
    city?: string | null;
    region?: string | null;
    name?: string | null;
    niche?: string | null;
    quizCurrency?: string | null;
  } | null>(null);

  React.useEffect(() => {
    async function fetchOffer() {
      try {
        const isPublic = mode === 'public';
        const offerPath = isPublic && careerSlug
          ? `/api/public/offers/job/${encodeURIComponent(careerSlug)}`
          : isPublic && prospectKey
          ? `/api/public/offers/by-prospect/${encodeURIComponent(prospectKey)}`
          : isPublic
            ? `/api/public/offers/${slug}`
            : `/api/offers/${id}`;
        const url = offerPath;
        const token = isPublic ? null : localStorage.getItem('offer-builder-token');
        console.log('[PreviewPage] fetching offer', isPublic ? slug : id, 'industry', industryId, 'mode:', mode, 'token present:', !!token);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        // The public route reads Twenty on every request, and a slow or failed
        // read used to put "Offer Not Found" in front of a real visitor. Retry
        // transient failures (network errors, 5xx) before giving up; a 404 is
        // a real answer and is not retried.
        const attempts = isPublic ? 3 : 1;
        let response: Response | null = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            response = await fetch(url, { headers });
            if (response.status < 500) break;
          } catch (e) {
            if (attempt === attempts) throw e;
          }
          if (attempt < attempts) await new Promise((r) => setTimeout(r, 600 * attempt));
        }
        if (!response) throw new Error('Failed to fetch offer');
        console.log('[PreviewPage] response', response.status, response.statusText);
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          console.error('[PreviewPage] error body:', body);
          throw new Error(body.error || 'Failed to fetch offer');
        }
        const data = await response.json();
        console.log('[PreviewPage] offer JSON:', data);
        setOffer(data);
      } catch (err) {
        console.error('[PreviewPage] fetch failed:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchOffer();
  }, [id, industryId, mode, slug, careerSlug, prospectKey, refreshTick]);

  // Report CONTENT height to an embedding parent (ui-kit iframe) so it can
  // size the frame instead of scrolling inside it on mobile. Public mode only.
  // When framed, html/body/#root lose their 100vh floors and their own
  // scrolling (index.css, html.embedded-funnel), so body.scrollHeight IS the
  // content height — margins and padding outside the content wrapper included,
  // which the old wrapper-only measurement missed (the frame ended up a few px
  // short and scrolled internally, trapping touch scrolling on phones).
  const contentRef = React.useRef<HTMLDivElement>(null);
  const lastPostedHeight = React.useRef(0);
  React.useEffect(() => {
    if (mode !== 'public') return;
    let framed = false;
    try {
      framed = window.self !== window.top;
    } catch {
      framed = true; // cross-origin parent: definitely framed
    }
    if (framed) document.documentElement.classList.add('embedded-funnel');
    const post = () => {
      try {
        const wrapper = Math.ceil(contentRef.current?.offsetHeight || 0);
        // No content wrapper yet (still loading): report nothing, so the parent
        // keeps its spinner instead of flashing a spinner-sized frame.
        const h = wrapper > 0 && framed ? Math.max(wrapper, Math.ceil(document.body.scrollHeight)) : wrapper;
        if (h > 0 && h !== lastPostedHeight.current) {
          lastPostedHeight.current = h;
          window.parent.postMessage({ type: 'offer:height', height: h }, '*');
        }
      } catch {}
    };
    post();
    const ro = new ResizeObserver(post);
    try {
      ro.observe(document.documentElement);
      ro.observe(document.body);
      if (contentRef.current) ro.observe(contentRef.current);
    } catch {}
    window.addEventListener('resize', post);
    const t = window.setInterval(post, 1500);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', post);
      window.clearInterval(t);
      document.documentElement.classList.remove('embedded-funnel');
    };
  }, [mode, quizKey, qualification, meetingBooked, applicationSubmitted, leadId, offer?.id]);

  // ?prospect=<id|slug> (public funnel iframes or the editor's preview-as pick)
  // loads the prospect record so {{area}} and quiz currency tailor to it.
  React.useEffect(() => {
    if (!prospectKey) return;
    let cancelled = false;
    fetch(`/api/public/prospects/${encodeURIComponent(prospectKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!cancelled && p) {
          setProspect(p);
          console.log('[Preview] prospect tailored', { city: p.city, niche: p.niche });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode, prospectKey]);

  // Public funnel with no prospect (e.g. /offer/book-a-consultation framed on
  // listeningkit.com/consultation): look up the visitor's city so {{area}}
  // reads like the tailored prospect version instead of a template.
  const [geoCity, setGeoCity] = React.useState('');
  React.useEffect(() => {
    if (mode !== 'public' || prospectKey) return;
    let cancelled = false;
    fetch('/api/public/geo')
      .then((r) => (r.ok ? r.json() : null))
      .then((g) => {
        if (!cancelled && g && typeof g.city === 'string') setGeoCity(g.city);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode, prospectKey]);

  // Save → preview bridge (preview mode only): the editor broadcasts
  // `offer:saved:<id>` on save via localStorage + postMessage; the 20s poll
  // covers the cross-origin Twenty-iframe case where neither can reach us.
  React.useEffect(() => {
    if (mode !== 'preview' || !storageId) return;
    const refresh = () => {
      setRefreshTick((t) => t + 1);
      setQuizKey((k) => k + 1);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === `offer:saved:${storageId}`) {
        console.log('[Preview] editor save detected via storage', storageId);
        refresh();
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (e?.data?.type === 'offer:saved' && (!e.data.id || e.data.id === storageId)) {
        console.log('[Preview] editor save detected via postMessage', e.data);
        refresh();
      }
    };
    const poll = window.setInterval(() => setRefreshTick((t) => t + 1), 20000);
    window.addEventListener('storage', onStorage);
    window.addEventListener('message', onMessage);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
    };
  }, [mode, storageId]);

  React.useEffect(() => {
    if (!storageId) return;
    const key = `quiz_qualification_${storageId}`;
    const stored = localStorage.getItem(key) || document.cookie.split('; ').find((c) => c.trim().startsWith(key + '='))?.split('=')[1];
    if (stored) setQualification(stored);
    try {
      if (localStorage.getItem(`quiz_booking_${storageId}`)) setMeetingBooked(true);
    } catch {}
  }, [storageId]);

  // Once booking completes, scroll to the booked main video.
  React.useEffect(() => {
    if (!meetingBooked || isRecruitment) return;
    const t = window.setTimeout(() => {
      const el =
        document.getElementById('booked-main-video') ||
        document.getElementById('offer-heading');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
      console.log('[Preview] scrolled to booked video');
    }, 350);
    return () => window.clearTimeout(t);
  }, [meetingBooked, isRecruitment]);

  // Testing control: simulate the Calendly event_scheduled without a real
  // booking, so the booked thank-you + videos can be previewed. Writes the
  // same booking flag the real widget event would write.
  const handleSimulateBooking = () => {
    if (!storageId || isRecruitment) return;
    try {
      localStorage.setItem(`quiz_booking_${storageId}`, JSON.stringify({ at: new Date().toISOString(), uri: null, simulated: true }));
      document.cookie = `quiz_booking_${storageId}=1; path=/; max-age=2592000`;
    } catch {}
    if (!qualification) handleQualificationChange('QUALIFIED');
    setMeetingBooked(true);
    console.log('[Preview] simulated calendly booking', storageId);
  };

  // Inject Meta Pixel base code per offer (PageView) — as per https://developers.facebook.com/docs/meta-pixel/get-started
  React.useEffect(() => {
    const pixelId = (offer as any)?.metaPixelId?.trim();
    if (!pixelId) return;
    if (document.querySelector(`script[data-pixel-id="${pixelId}"]`)) return;
    console.log('[Preview] injecting Meta Pixel', pixelId);
    // base code
    (function (f: any, b: any, e: string, v: string, n: any, t: any, s: any) {
      if (f.fbq) return;
      n = f.fbq = function () {
        (n as any).callMethod ? (n as any).callMethod.apply(n, arguments) : (n as any).queue.push(arguments);
      };
      if (!(f as any)._fbq) (f as any)._fbq = n;
      (n as any).push = n;
      (n as any).loaded = true;
      (n as any).version = '2.0';
      (n as any).queue = [];
      t = b.createElement(e);
      t.async = true;
      t.src = v;
      t.setAttribute('data-pixel-id', pixelId);
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window as any, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js', 'fbq' as any, null as any, null as any);
    (window as any).fbq('init', pixelId);
    (window as any).fbq('track', 'PageView');
    // noscript fallback
    const noscript = document.createElement('noscript');
    const img = document.createElement('img');
    img.height = 1;
    img.width = 1;
    (img as any).style = 'display:none';
    img.src = `https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1`;
    noscript.appendChild(img);
    document.head.appendChild(noscript);
  }, [offer]);

  const handleQualificationChange = (q: string) => {
    if (!storageId) return;
    const key = `quiz_qualification_${storageId}`;
    localStorage.setItem(key, q);
    document.cookie = `${key}=${q}; path=/; max-age=604800`;
    setQualification(q);
    console.log('[Preview] qualification cookie set', key, q);
  };

  const handleLeadCreated = (lead: any, q: string) => {
    setLeadId(lead.id);
    handleQualificationChange(q);
  };

  const handleReset = async () => {
    if (!storageId) return;
    const key = `quiz_qualification_${storageId}`;
    if (leadId) {
      try {
        const res = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' });
        console.log('[Preview] cleared lead from Twenty', leadId, res.status);
      } catch (e) {
        console.error('[Preview] delete lead failed', e);
      }
    }
    localStorage.removeItem(key);
    document.cookie = `${key}=; path=/; max-age=0`;
    const bookingKey = `quiz_booking_${storageId}`;
    localStorage.removeItem(bookingKey);
    document.cookie = `${bookingKey}=; path=/; max-age=0`;
    setQualification(null);
    setLeadId(null);
    setMeetingBooked(false);
    setApplicationSubmitted(false);
    setQuizKey((k) => k + 1);
    console.log('[Preview] reset quiz and cleared cookie', key);
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[#F9FCFE]">
        <div className="flex flex-col items-center gap-4">
          <div className="size-8 animate-spin rounded-full border-4 border-[#2A8CFF]/20 border-t-[#2A8CFF]" />
          <p className="text-sm text-neutral-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !offer) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 bg-[#F9FCFE]">
        <h1 className="font-heading text-2xl font-medium text-[#0D2A4C] md:text-3xl" style={{ fontFamily: 'Satoshi, sans-serif' }}>
          Offer Not Found
        </h1>
        <p className="mt-2 text-base text-neutral-500">
          {error || 'This offer page is not available or has not been configured.'}
        </p>
        {mode === 'preview' && (
          <Link to="/offers" className="inline-flex h-12 items-center px-6 font-medium text-[#1D5BBF] transition-colors hover:text-[#154797]">
            ← Back to Offers
          </Link>
        )}
      </div>
    );
  }

  const buildDoneContent = (raw: any) => {
    if (!raw) return undefined;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const videos: Array<{ url: string; title?: string }> = [];
      const pushUrl = (url: any, title?: any) => {
        if (typeof url === 'string' && url.trim()) {
          videos.push({ url: url.trim(), title: typeof title === 'string' && title.trim() ? title : undefined });
        }
      };
      pushUrl(parsed.video?.title);
      const items = parsed.videoGrid?.items;
      if (Array.isArray(items)) items.forEach((it: any) => pushUrl(it?.videoTitle, it?.title));
      const cols = parsed.videoGrid?.columns;
      return {
        badgeText: parsed.badgeText,
        heading: parsed.heading,
        videos,
        columns: typeof cols === 'number' && (cols === 1 || cols === 2 || cols === 3) ? cols : 2,
      };
    } catch { return undefined; }
  };
  const thankYouCfg = buildDoneContent((offer as any).thankYouConfig);
  const disqualifiedCfg = buildDoneContent((offer as any).disqualifiedConfig);
  const activeDoneCfg = qualification === 'DISQUALIFIED' ? disqualifiedCfg : thankYouCfg;
  const bookedVideos = activeDoneCfg?.videos ?? [];

  const areaParam = (() => {
    try {
      return new URLSearchParams(window.location.search).get('area') || '';
    } catch {
      return '';
    }
  })();

  // {{area}} priority: explicit ?area= → linked prospect record → dashed
  // token placeholder. Industry iframes send ?prospect= so the funnel reads
  // the actual row instead of generic copy.
  // Public funnel only: when no ?area= or prospect names a place, use the
  // visitor's own city (Vercel geo) so the copy reads tailored, not templated.
  const area = areaParam || prospect?.city || (offer as any).prospectCity || geoCity || '';
  // The builder shows the dashed {{area}} token so template vs tailored is
  // obvious; a real visitor on the public funnel must never see it.
  const keepToken = mode !== 'public';
  // Quiz currency comes from the prospect record (stamped at enrichment).
  // Last-resort "$" only — the field should always be present.
  const quizCurrency =
    (typeof prospect?.quizCurrency === 'string' && prospect.quizCurrency) || '$';

  // UTM swaps: ?utm_source= matches a rule authored in the UTM tab, swapping
  // one hero field for this visit only. No match → base copy untouched.
  const utmSwap = (() => {
    let src = '';
    try {
      src = new URLSearchParams(window.location.search).get('utm_source') || '';
    } catch { return null; }
    if (!src) return null;
    const raw = (offer as any).utmSwaps;
    let rules: any = null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      rules = Array.isArray(parsed) ? parsed : parsed?.rules;
    } catch { return null; }
    if (!Array.isArray(rules)) return null;
    const hit = rules.find((r: any) =>
      typeof r?.utmSource === 'string' && r.utmSource.toLowerCase() === src.toLowerCase() &&
      typeof r?.html === 'string' && r.html.length > 0 &&
      (r.field === 'heroH1' || r.field === 'heroLede' || r.field === 'title'));
    return hit || null;
  })();
  const effTitle = utmSwap?.field === 'title' ? utmSwap.html : offer.title;
  const effH1 = utmSwap?.field === 'heroH1' ? utmSwap.html : offer.heroH1;
  const effLedeMarkdown = utmSwap?.field === 'heroLede'
    ? utmSwap.html
    : (offer.heroLede as any)?.markdown;

  // H1 only renders pre-booking; the booked view carries its own header.
  const hasHeroHeadline = !!(effH1 || effTitle);
  const heroHeadline = effH1 ? (
    <span dangerouslySetInnerHTML={{ __html: effH1 }} />
  ) : (
    effTitle
  );
  const heroLedeHtml = effLedeMarkdown
    ? resolveAreaTokens(effLedeMarkdown, { area, keepTokenIfMissing: keepToken })
    : null;

  // Worked-with logos live below the quiz section (never inside it).
  const carouselLogos = (() => {
    const raw = (offer as any)?.mediaLogos;
    const parsed = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
      : raw;
    const list = Array.isArray(parsed) ? parsed : parsed?.logos;
    if (!Array.isArray(list)) return undefined;
    const cleaned = list
      .filter((l: any) => l && typeof l.src === 'string' && l.src.length > 0)
      .map((l: any) => ({
        src: l.src,
        alt: typeof l.alt === 'string' ? l.alt : undefined,
        href: typeof l.href === 'string' && l.href.length > 0 ? l.href : undefined,
      }));
    return cleaned.length > 0 ? cleaned : undefined;
  })();

  return (
    <div
      ref={contentRef}
      className={`${mode === 'public' ? '' : 'min-h-screen '}bg-white`}
      style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}
    >
      {/* ===== HERO — literal copy of ui-kit/apps/web/src/pages/offer-funnel-page.tsx ===== */}
      <section
        id="offer-hero"
        className="relative overflow-hidden rounded-b-[60px] px-6 pb-24 pt-20 md:pb-32 md:pt-28"
        style={{
          background:
            "radial-gradient(ellipse 90% 60% at 50% 0%, rgba(45,141,255,0.14) 0%, rgba(45,141,255,0) 60%), #F9FCFE",
        }}
      >
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-14 text-center">
          {((offer as any)?.brandLogoUrl || (offer as any)?.brandName || (offer as any)?.brandSub) && (
            <div className="flex items-center gap-3 text-left">
              {(offer as any)?.brandLogoUrl && (
                <img
                  src={(offer as any).brandLogoUrl}
                  alt={(offer as any)?.brandName || 'Brand logo'}
                  className="size-11 shrink-0 rounded-[10px] object-contain"
                />
              )}
              <div className="flex flex-col gap-0.5">
                {(offer as any)?.brandName && (
                  <p className="text-[17px] font-bold leading-tight text-[#0D2A4C]" style={{ fontFamily: 'Satoshi, sans-serif' }}>
                    <span dangerouslySetInnerHTML={{ __html: (offer as any).brandName }} />
                  </p>
                )}
                {(offer as any)?.brandSub && (
                  <p className="text-[13px] leading-snug text-[#0D2A4C]/60">
                    <span dangerouslySetInnerHTML={{ __html: (offer as any).brandSub }} />
                  </p>
                )}
              </div>
            </div>
          )}
          {!done && hasHeroHeadline && (
            <h1 id="offer-heading" className="font-heading text-4xl font-bold leading-[1.05] tracking-tight text-[#0D2A4C] sm:text-5xl md:text-6xl lg:text-7xl" style={{ fontFamily: 'Satoshi, sans-serif' }}>
              {heroHeadline}
            </h1>
          )}

          {!done && heroLedeHtml ? (
            <p className="max-w-2xl text-xl text-[#0D2A4C]/60 md:text-2xl">
              <span dangerouslySetInnerHTML={{ __html: heroLedeHtml }} />
            </p>
          ) : null}

          {/* The video sits on the page frameless: no outline, no hard drop. A
              public visitor with no video for this offer gets no empty player;
              the builder keeps the placeholder so a missing video is visible. */}
          {!done && (offer.videoUrl?.primaryLinkUrl || mode !== 'public') && (
            <div id="top-video" className="mx-auto w-full max-w-2xl scroll-mt-6">
              <div className="overflow-hidden rounded-[24px] bg-[#F8F9FB]" style={{ aspectRatio: "16/9" }}>
                {offer.videoUrl?.primaryLinkUrl ? (
                  <FunnelVideo
                    src={offer.videoUrl.primaryLinkUrl}
                    title={typeof offer.title === 'string' ? offer.title : undefined}
                    variant="controls"
                    autoPlay
                    muted
                    loop
                  />
                ) : (
                  <div className="flex size-full min-h-[400px] items-center justify-center text-[#0D2A4C]/20">
                    <svg className="size-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                )}
              </div>
            </div>
          )}

{done ? (
            <div id="booked-content" className="mx-auto flex w-full max-w-6xl scroll-mt-6 flex-col gap-10">
              {(activeDoneCfg?.badgeText || activeDoneCfg?.heading) && (
                <div className="text-center">
                  {activeDoneCfg?.badgeText && (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 text-[12px] font-semibold">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      {activeDoneCfg.badgeText}
                    </span>
                  )}
                  {activeDoneCfg?.heading && (
                    <h2 className="mt-4 font-heading text-2xl font-bold leading-snug text-[#0D2A4C] sm:text-3xl" style={{ fontFamily: 'Satoshi, sans-serif' }}>
                      {activeDoneCfg.heading}
                    </h2>
                  )}
                </div>
              )}
              {bookedVideos.length > 0 ? (
                <>
                  {(() => {
                    const [main, ...rest] = bookedVideos;
                    const grid = rest;
                    const colClass = activeDoneCfg?.columns === 1 ? 'grid-cols-1' : activeDoneCfg?.columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
                    return (
                      <>
                        <div id="booked-main-video" className="scroll-mt-6">
                          {main.title && (
                            <p className="px-5 pt-4 text-left text-[15px] font-semibold text-[#0D2A4C]" style={{ fontFamily: 'Satoshi, sans-serif' }}>
                              {main.title}
                            </p>
                          )}
                          <FunnelVideo src={main.url} title={main.title} variant="controls" autoPlay muted className="aspect-video" />
                        </div>
{grid.length > 0 && (
                            <div id="booked-videos" className={`grid gap-8 ${colClass}`}>
                              {grid.map((v, i) => {
                                // Odd-count orphan (e.g. 3rd of 3 in 2-col): center it
                                // as a half-width tile instead of stranding it left.
                                const isOrphan =
                                  activeDoneCfg?.columns !== 1 &&
                                  activeDoneCfg?.columns !== 3 &&
                                  grid.length % 2 === 1 &&
                                  i === grid.length - 1;
                                return (
                                  <div key={i} className={isOrphan ? 'sm:col-span-2 sm:mx-auto sm:w-[calc(50%-16px)]' : undefined}>
                                  {v.title && (
                          <h3 className="mb-2 text-left text-xl font-bold text-[#0D2A4C] md:text-2xl" style={{ fontFamily: 'Satoshi, sans-serif' }}>
                            {v.title}
                          </h3>
                        )}
                                  <div>
                                    <FunnelVideo src={v.url} title={v.title} variant="controls" className="aspect-video" />
                                  </div>
                                </div>
                                );
                              })}
                            </div>
                          )}
                      </>
                    );
                  })()}
                </>
              ) : null}
            </div>
          ) : isRecruitment ? (
          // A recruitment funnel has no Calendly and no disqualification
          // branch. RecruitApplication owns both the form and its own
          // confirmation, so it stays mounted after submit; the hero above
          // hides because `done` is true.
          <RecruitApplication
            key={quizKey}
            steps={Array.isArray((offer as any).careerQuestionnaire) ? (offer as any).careerQuestionnaire : []}
            config={(offer as any).applicationConfig ?? null}
            roleTitle={(offer as any).roleTitle || undefined}
            offerId={offer.id}
            metaPixelId={(offer as any).metaPixelId || undefined}
            endpoints={{ submit: '/api/public/applications' }}
            onSubmitted={() => setApplicationSubmitted(true)}
          />
          ) : (
          <Quiz
            key={quizKey}
            questions={(() => {
              const raw = (offer as any).quizConfig || (offer as any).quiz;
              if (!raw) return undefined;
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const list = Array.isArray(parsed) ? parsed : parsed?.questions;
                return Array.isArray(list) && list.length ? list : undefined;
              } catch { return undefined; }
            })()}
            introTitle={(() => {
              const raw = (offer as any).quizConfig;
              if (!raw || typeof raw === 'string') {
                try {
                  const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
                  return typeof parsed?.introTitle === 'string' ? parsed.introTitle : undefined;
                } catch { return undefined; }
              }
              return typeof raw.introTitle === 'string' ? raw.introTitle : undefined;
            })()}
            introDesc={(() => {
              const raw = (offer as any).quizConfig;
              if (!raw || typeof raw === 'string') {
                try {
                  const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
                  return typeof parsed?.introDesc === 'string' ? parsed.introDesc : undefined;
                } catch { return undefined; }
              }
              return typeof raw.introDesc === 'string' ? raw.introDesc : undefined;
            })()}
            area={area}
            keepTokenIfMissing={keepToken}
            currency={quizCurrency}
            calendlyUrl={(offer as any).calendlyUrl}
            disqualifiedCalendlyUrl={(() => {
              const raw = (offer as any).disqualifiedConfig;
              if (!raw) return undefined;
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return parsed?.calendlyEmbed || (typeof parsed === 'string' ? parsed : undefined) || (offer as any).disqualifiedCalendlyUrl;
              } catch { return undefined; }
            })()}
            offerId={offer.id}
            leadsEndpoint={mode === 'public' ? '/api/public/leads' : '/api/leads'}
            prospectId={(offer as any).prospectId || (offer as any).name}
            onQualificationChange={handleQualificationChange}
            onLeadCreated={handleLeadCreated}
            onMeetingBooked={() => setMeetingBooked(true)}
            thankYou={thankYouCfg}
            disqualified={disqualifiedCfg}
          />
          )}
        </div>

        {/* Worked-with logos — pre-booking only; the booked view is the video. */}
      {!done && (
        <LogoCarousel
          logos={carouselLogos}
          heading={typeof (offer as any)?.carouselHeading === 'string' ? (offer as any).carouselHeading : undefined}
          descMarkdown={(() => {
            const raw = (offer as any)?.carouselDesc;
            if (!raw) return undefined;
            if (typeof raw === 'string') return raw;
            return typeof raw.markdown === 'string' ? raw.markdown : undefined;
          })()}
          area={area}
          keepTokenIfMissing={keepToken}
        />
      )}
      </section>

      {mode === 'preview' && (
        <div className="max-w-6xl mx-auto px-4 pb-8 text-center">
          <div className="text-[11px] text-[#0D2A4C]/40">Preview • {offer.title || offer.heroH1 || 'Untitled'} • {offer.id}</div>
        </div>
      )}

      {/* Hovering reset button — preview only, never on the public funnel */}
      {mode === 'preview' && (
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-[var(--ods-border,#e5e5ea)] bg-white px-3 h-10 shadow-[0_4px_14px_rgba(0,0,0,0.12)]">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${
            qualification === 'QUALIFIED'
              ? 'bg-green-500/10 text-green-700 border-green-200'
              : qualification === 'DISQUALIFIED'
                ? 'bg-red-500/10 text-red-700 border-red-200'
                : 'bg-gray-500/10 text-gray-600 border-gray-200'
          }`}
        >
          {qualification || 'Not started'}
        </span>
        <span className="text-[11px] text-[var(--ods-text-tertiary)] hidden sm:inline">
          {leadId ? `Lead ${leadId.slice(0, 8)}…` : 'No lead yet'}
        </span>
        {!done && (
          <button
            onClick={handleSimulateBooking}
            className="ml-1 h-7 px-3 text-[11px] font-medium bg-[var(--ods-brand-600,#2563eb)] text-white rounded-full hover:opacity-90 active:scale-[0.97] transition-all"
            title="Simulate the Calendly event_scheduled without a real booking"
          >
            Simulate booking
          </button>
        )}
        <button
          onClick={handleReset}
          className="ml-1 h-7 px-3 text-[11px] font-medium bg-[var(--ods-text-primary,#1e2126)] text-white rounded-full hover:opacity-90 active:scale-[0.97] transition-all"
          title="Clear agencyLead in Twenty and reset quiz to try again"
        >
          Reset quiz
        </button>
      </div>
      )}
    </div>
  );
}
