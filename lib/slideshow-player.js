import { DEFAULT_SLIDE_ANIMATION, SLIDE_ANIMATIONS } from './animations.js';

const mounted = new WeakMap();

export function unmountSlideshows(root) {
  for (const section of root.querySelectorAll('section.webcli-slideshow')) mounted.get(section)?.();
}

export function mountSlideshows(root) {
  const cleanups = [];
  for (const section of root.querySelectorAll('section.webcli-slideshow')) {
    if (mounted.has(section)) continue;
    const slides = [...section.children].filter((el) => el.matches('figure.webcli-slide'));
    if (slides.length < 2) continue;
    const doc = section.ownerDocument;
    const win = doc.defaultView;
    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const abort = new win.AbortController();
    const listen = (node, type, fn) => node.addEventListener(type, fn, { signal: abort.signal });
    const controls = doc.createElement('div');
    controls.className = 'webcli-slide-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Slideshow controls');
    let at = 0;
    let playing = !reduced.matches;
    let hovering = false;
    let timer = null;
    const animations = new Map();
    const clearAnimation = (slide) => {
      const name = animations.get(slide);
      if (name) slide.classList.remove('animate__animated', `animate__${name}`);
      animations.delete(slide);
    };
    const button = (label, action) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = label;
      listen(b, 'click', action);
      controls.append(b);
      return b;
    };
    const stopTimer = () => { win.clearTimeout(timer); timer = null; };
    const schedule = () => {
      stopTimer();
      if (playing && !hovering && !doc.hidden && section.isConnected) timer = win.setTimeout(() => show(at + 1), 6000);
    };
    const show = (next) => {
      at = (next + slides.length) % slides.length;
      slides.forEach((slide, i) => { clearAnimation(slide); slide.hidden = i !== at; });
      const current = slides[at];
      const animation = [...current.classList].find((name) => name.startsWith('webcli-animate-'))?.slice('webcli-animate-'.length) ?? DEFAULT_SLIDE_ANIMATION;
      if (!reduced.matches && animation !== 'none' && SLIDE_ANIMATIONS.includes(animation)) {
        void current.offsetWidth; // Restart the effect even when the current numbered button is selected again.
        current.classList.add('animate__animated', `animate__${animation}`);
        animations.set(current, animation);
      }
      dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === at)));
      schedule();
    };
    const updatePlay = () => {
      play.textContent = playing ? 'Pause' : 'Play';
      play.setAttribute('aria-label', playing ? 'Pause slideshow' : 'Play slideshow');
      schedule();
    };
    const pause = () => { playing = false; updatePlay(); };
    const move = (offset) => { pause(); show(at + offset); };
    button('Previous', () => move(-1));
    let pointerPlaying;
    const play = button('Pause', (event) => {
      playing = !(event.detail && pointerPlaying !== undefined ? pointerPlaying : playing);
      pointerPlaying = undefined;
      updatePlay();
    });
    // A pointer focuses the button before clicking; preserve its intent across focus's automatic pause.
    listen(play, 'pointerdown', () => { pointerPlaying = playing; });
    listen(play, 'pointercancel', () => { pointerPlaying = undefined; });
    button('Next', () => move(1));
    const dots = slides.map((slide, i) => {
      // Hidden lazy images would otherwise start loading only after their first rotation.
      for (const image of slide.querySelectorAll('img')) image.loading = 'eager';
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-roledescription', 'slide');
      slide.setAttribute('aria-label', `${i + 1} of ${slides.length}`);
      return button(String(i + 1), () => { pause(); show(i); });
    });
    dots.forEach((dot, i) => dot.setAttribute('aria-label', `Go to slide ${i + 1}`));
    section.setAttribute('role', 'region');
    section.setAttribute('aria-roledescription', 'carousel');
    section.append(controls);
    listen(section, 'pointerenter', () => { hovering = true; schedule(); });
    listen(section, 'pointerleave', () => { hovering = false; schedule(); });
    listen(section, 'focusin', pause);
    listen(section, 'keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      move(event.key === 'ArrowRight' ? 1 : -1);
    });
    listen(doc, 'visibilitychange', schedule);
    listen(reduced, 'change', () => {
      if (reduced.matches) {
        pause();
        slides.forEach(clearAnimation);
      }
    });
    const cleanup = () => {
      stopTimer();
      abort.abort();
      controls.remove();
      for (const slide of slides) {
        clearAnimation(slide);
        slide.hidden = false;
        for (const attr of ['role', 'aria-roledescription', 'aria-label']) slide.removeAttribute(attr);
      }
      section.removeAttribute('role');
      section.removeAttribute('aria-roledescription');
      mounted.delete(section);
    };
    mounted.set(section, cleanup);
    cleanups.push(cleanup);
    show(0);
    updatePlay();
  }
  return () => cleanups.forEach((cleanup) => cleanup());
}
