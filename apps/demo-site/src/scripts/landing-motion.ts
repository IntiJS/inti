// apps/demo-site/src/scripts/landing-motion.ts
// Scroll-linked motion for the landing page, with no library.
//
// - `[data-scroll]`: while the element is on screen, `--p` goes from 0 (its top
//   touches the bottom of the viewport) to 1 (its bottom leaves the top). The
//   stylesheet turns `--p` into movement.
// - `[data-anim]`: CSS animations inside are paused while it is off-screen.
//
// Under `prefers-reduced-motion` nothing here runs: the stylesheet's defaults
// are the resting layout.

export function initLandingMotion() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Pause CSS animations that nobody can see
  const animated = document.querySelectorAll<HTMLElement>('[data-anim]');
  const animObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.classList.toggle('anim-off', !entry.isIntersecting);
  });
  animated.forEach((el) => animObserver.observe(el));

  if (reduce.matches) return;

  const visible = new Set<HTMLElement>();
  let frame = 0;

  function update() {
    frame = 0;
    const vh = window.innerHeight;
    for (const el of visible) {
      const rect = el.getBoundingClientRect();
      const p = (vh - rect.top) / (vh + rect.height);
      el.style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(4));
    }
  }

  function request() {
    if (!frame && visible.size) frame = requestAnimationFrame(update);
  }

  const scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (entry.isIntersecting) visible.add(el);
        else visible.delete(el);
      }
      request();
    },
    { rootMargin: '10% 0px 10% 0px' },
  );
  document.querySelectorAll<HTMLElement>('[data-scroll]').forEach((el) => scrollObserver.observe(el));

  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', request, { passive: true });
}
