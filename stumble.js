/**
 * stumble — equal-energy per-letter wobble, compositor-safe.
 *
 * Extracted from denizaydemir.com and sunsetlogic.com's hero. Splits text
 * into per-letter elements (or takes elements you already split, e.g. an
 * SVG mask-hole build) and drifts each one on its own WAAPI animation:
 * translate + rotate, four waypoints (rest, three poses, rest), infinite,
 * cancelled (not paused) under prefers-reduced-motion.
 *
 * Zero dependencies. See README.md for the five hard-won engine lessons
 * this file encodes — read it before changing the animation shape.
 */

/** @typedef {{
 *   amplitude?: number | { x: number, y: number },
 *   rotate?: number,
 *   durationRange?: [number, number],
 *   delayRange?: [number, number],
 *   active?: boolean,
 *   respectReducedMotion?: boolean,
 * }} StumbleOptions */

const DEFAULTS = {
  // The (ax, 2px) ellipse from the source site, generalized to a circle by
  // default — pass { x, y } to reproduce an anisotropic fit.
  amplitude: 2,
  // Full rotation amplitude in degrees; every letter gets ±this, never less.
  rotate: 0.5,
  // Seconds. Randomized per letter so the word doesn't pulse in lockstep.
  durationRange: [3.2, 4.8],
  delayRange: [0, 1.6],
  active: true,
  respectReducedMotion: true,
};

function resolveAmplitude(a) {
  if (typeof a === 'number') return { x: a, y: a };
  return { x: a.x, y: a.y };
}

function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

/**
 * Lesson 1 (equal-energy poses): every letter gets the SAME excursion
 * magnitude. The pose sits ON the amplitude ellipse at a random angle, and
 * rotation is always the full amplitude with a random sign — never a
 * uniform-random magnitude. Randomizing magnitude instead of angle/sign
 * reads to a human as the word wobbling harder toward its end, because
 * later letters end up with larger draws on average by pure chance run
 * after run; equal energy removes that tell.
 */
function pose(amplitude, rotate) {
  const angle = Math.random() * Math.PI * 2;
  const x = amplitude.x * Math.cos(angle);
  const y = amplitude.y * Math.sin(angle);
  const r = rotate * (Math.random() < 0.5 ? -1 : 1);
  return [x, y, r];
}

/**
 * Four waypoints — rest, three equal-energy poses, rest — each segment
 * eased in-out. This is the shape a fixed-tick fallback clock also has to
 * reproduce (see README lesson 5): the same cadence, just continuous time
 * instead of a tick grid.
 */
function buildKeyframes(amplitude, rotate) {
  const REST = [0, 0, 0];
  const waypoints = [REST, pose(amplitude, rotate), pose(amplitude, rotate), pose(amplitude, rotate), REST];
  return waypoints.map(([x, y, r]) => ({
    transform: `translate(${x.toFixed(3)}px, ${y.toFixed(3)}px) rotate(${r.toFixed(3)}deg)`,
    easing: 'ease-in-out',
  }));
}

function animateLetter(el, options) {
  const amplitude = resolveAmplitude(options.amplitude);
  const duration = randRange(options.durationRange) * 1000;
  const delay = randRange(options.delayRange) * 1000;
  // will-change promotes the element to its own compositor layer up front,
  // rather than letting the browser decide mid-animation.
  el.style.willChange = 'transform';
  return el.animate(buildKeyframes(amplitude, options.rotate), {
    duration,
    delay,
    iterations: Infinity,
    fill: 'none', // rest means REST — see Lesson 5 / reduced motion below.
  });
}

/**
 * Drive an already-split set of per-letter elements.
 *
 * This is the primitive both `stumble()` and the SVG-mask-hole case (e.g.
 * a knockout hero where "letters" are HTML wrapper divs positioned over
 * mask holes, not the mask content itself — see README) build on.
 *
 * IMPORTANT (Lesson 2): pass plain HTML elements, never an SVG element —
 * not even a root <svg>. Blink will not run a transform animation
 * targeting an SVG element on the compositor; it silently falls back to
 * ticking the animation on the main thread every vsync. If your letters
 * are SVG mask holes, wrap each one in a plain HTML div, position that div
 * over the hole, and animate the div.
 *
 * @param {Iterable<HTMLElement>} els
 * @param {StumbleOptions} [opts]
 */
export function stumbleElements(els, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const elements = Array.from(els);
  const mql = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  let anims = [];
  let userActive = options.active !== false;

  function reduced() {
    return options.respectReducedMotion && !!mql && mql.matches;
  }

  function build() {
    anims = elements.map((el) => animateLetter(el, options));
  }

  /**
   * Lesson 5 (reduced motion cancels, never pauses): fill: 'none' means a
   * cancelled animation snaps its element straight back to the untransformed
   * rest pose. Pausing instead would freeze every letter mid-drift — a
   * typo, not a rest state — until motion is re-enabled.
   */
  function teardown() {
    anims.forEach((a) => a.cancel());
    anims = [];
  }

  function apply() {
    if (!userActive || reduced()) {
      teardown();
      return;
    }
    if (!anims.length) build();
  }

  function onReducedChange() {
    apply();
  }
  if (mql) {
    if (mql.addEventListener) mql.addEventListener('change', onReducedChange);
    else if (mql.addListener) mql.addListener(onReducedChange); // Safari <14
  }

  apply();

  return {
    start() {
      userActive = true;
      apply();
    },
    stop() {
      userActive = false;
      teardown();
    },
    destroy() {
      teardown();
      if (mql) {
        if (mql.removeEventListener) mql.removeEventListener('change', onReducedChange);
        else if (mql.removeListener) mql.removeListener(onReducedChange);
      }
      elements.forEach((el) => {
        el.style.willChange = '';
      });
    },
  };
}

/**
 * Split an element's text into per-letter inline-block spans (preserving
 * spaces as plain text nodes, so word wrapping and selection still work
 * roughly as expected) and drive them with stumbleElements().
 *
 * The element's existing children are replaced; destroy() restores the
 * original innerHTML.
 *
 * @param {HTMLElement} el
 * @param {StumbleOptions} [opts]
 */
export function stumble(el, opts = {}) {
  const originalHTML = el.innerHTML;
  const text = el.textContent;

  el.textContent = '';
  const frag = document.createDocumentFragment();
  const letterEls = [];

  for (const ch of text) {
    if (ch === ' ') {
      // A plain space text node, not a span: keeps word-wrap and selection
      // behaving normally, and a single literal space between inline-block
      // siblings renders as one space (standard letter-splitting technique).
      frag.appendChild(document.createTextNode(' '));
      continue;
    }
    const span = document.createElement('span');
    span.textContent = ch;
    span.style.display = 'inline-block';
    frag.appendChild(span);
    letterEls.push(span);
  }

  el.appendChild(frag);

  const controller = stumbleElements(letterEls, opts);

  return {
    ...controller,
    destroy() {
      controller.destroy();
      el.innerHTML = originalHTML;
    },
  };
}
