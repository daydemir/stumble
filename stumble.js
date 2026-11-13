/**
 * stumble: equal-energy per-letter wobble, compositor-safe.
 *
 * Splits text into per-letter elements (or takes elements you already split,
 * e.g. HTML wrappers over SVG mask holes) and drifts each one on its own Web
 * Animations API animation: translate + rotate through rest, three poses and
 * rest again, forever. Under prefers-reduced-motion the animations are
 * cancelled, not paused.
 *
 * Zero dependencies. README.md explains the engine lessons this file encodes;
 * read it before changing the animation shape.
 */

/** @typedef {{ x: number, y: number }} Ellipse */

/**
 * @typedef {{
 *   amplitude?: number | Ellipse,
 *   rotate?: number,
 *   durationRange?: [number, number],
 *   delayRange?: [number, number],
 *   active?: boolean,
 *   respectReducedMotion?: boolean,
 * }} StumbleOptions
 */

/** @typedef {{ start(): void, stop(): void, destroy(): void }} StumbleController */

const DEFAULTS = {
  amplitude: 2, // px, radius of the pose ellipse; a number is a circle
  rotate: 0.5, // deg, every pose gets exactly ±this
  durationRange: [3.2, 4.8], // s, randomized once per letter
  delayRange: [0, 1.6], // s, randomized once per letter
  active: true,
  respectReducedMotion: true,
};

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const randRange = ([min, max]) => min + Math.random() * (max - min);

/**
 * Lesson 1, equal energy: every pose sits ON the amplitude ellipse at a random
 * angle, and rotation is the full amplitude with a random sign. Randomizing
 * magnitude instead reads as the word wobbling harder toward its end.
 *
 * @param {Ellipse} amplitude
 * @param {number} rotate
 */
function pose(amplitude, rotate) {
  const angle = Math.random() * Math.PI * 2;
  const sign = Math.random() < 0.5 ? -1 : 1;
  return [amplitude.x * Math.cos(angle), amplitude.y * Math.sin(angle), rotate * sign];
}

/**
 * Lesson 5, the timing recipe: rest, three equal-energy poses, rest, each
 * segment eased in-out.
 *
 * @param {Ellipse} amplitude
 * @param {number} rotate
 */
function keyframes(amplitude, rotate) {
  const rest = [0, 0, 0];
  const waypoints = [rest, pose(amplitude, rotate), pose(amplitude, rotate), pose(amplitude, rotate), rest];
  return waypoints.map(([x, y, r]) => ({
    transform: `translate(${x.toFixed(3)}px, ${y.toFixed(3)}px) rotate(${r.toFixed(3)}deg)`,
    easing: 'ease-in-out',
  }));
}

/**
 * Drive an already-split set of per-letter elements.
 *
 * Lesson 2: only plain HTML elements stay on the compositor. Blink silently
 * ticks a transform animation on an SVG element on the main thread every
 * frame, so SVG elements are rejected. Wrap SVG letters in an HTML div and pass
 * the divs.
 *
 * @param {Iterable<HTMLElement>} els
 * @param {StumbleOptions} [opts]
 * @returns {StumbleController}
 */
export function stumbleElements(els, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const amplitude =
    typeof options.amplitude === 'number' ? { x: options.amplitude, y: options.amplitude } : options.amplitude;
  const elements = Array.from(els);
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) throw new TypeError('stumbleElements: every element must be an HTMLElement');
  }

  const reducedMotion = matchMedia(REDUCED_MOTION);
  let active = options.active;
  /** @type {Animation[]} */
  let animations = [];

  /**
   * Lesson 5: cancel, never pause. With fill 'none' a cancelled animation
   * snaps its letter back to rest; a paused one freezes mid-drift.
   */
  function teardown() {
    animations.forEach((animation) => animation.cancel());
    animations = [];
    elements.forEach((el) => {
      el.style.willChange = '';
    });
  }

  function apply() {
    if (!active || (options.respectReducedMotion && reducedMotion.matches)) {
      teardown();
      return;
    }
    if (animations.length) return;
    animations = elements.map((el) => {
      // Promote each letter to its own layer up front, not mid-animation.
      el.style.willChange = 'transform';
      return el.animate(keyframes(amplitude, options.rotate), {
        duration: randRange(options.durationRange) * 1000,
        delay: randRange(options.delayRange) * 1000,
        iterations: Infinity,
        fill: 'none',
      });
    });
  }

  reducedMotion.addEventListener('change', apply);
  apply();

  return {
    start() {
      active = true;
      apply();
    },
    stop() {
      active = false;
      apply();
    },
    destroy() {
      reducedMotion.removeEventListener('change', apply);
      teardown();
    },
  };
}

/**
 * Split an element's text into per-letter spans and drive them with
 * stumbleElements().
 *
 * Letters are split by grapheme cluster, so combining marks and emoji
 * sequences stay whole. Each word is a nowrap span, so a line never breaks
 * mid-word, and whitespace stays as plain text nodes. The split spans are
 * aria-hidden and the element gets the text as its aria-label (unless it
 * already has one), so screen readers hear the word, not its letters. The
 * letters remain real text in document order, so selection and copy still
 * yield the original string.
 *
 * Child markup is flattened to text while active; destroy() puts the original
 * child nodes and aria-label back.
 *
 * @param {HTMLElement} el
 * @param {StumbleOptions} [opts]
 * @returns {StumbleController}
 */
export function stumble(el, opts = {}) {
  const originalNodes = Array.from(el.childNodes);
  const ownsLabel = !el.hasAttribute('aria-label');
  const text = el.textContent;
  /** @type {HTMLSpanElement[]} */
  const letters = [];

  const pieces = text
    .split(/(\s+)/)
    .filter(Boolean)
    .map((chunk) => {
      if (/^\s/.test(chunk)) return document.createTextNode(chunk);
      const word = document.createElement('span');
      word.setAttribute('aria-hidden', 'true');
      word.style.whiteSpace = 'nowrap';
      for (const { segment } of graphemes.segment(chunk)) {
        const letter = document.createElement('span');
        // Transforms don't apply to non-replaced inline boxes.
        letter.style.display = 'inline-block';
        letter.textContent = segment;
        word.append(letter);
        letters.push(letter);
      }
      return word;
    });

  if (ownsLabel) el.setAttribute('aria-label', text.replace(/\s+/g, ' ').trim());
  el.replaceChildren(...pieces);

  const controller = stumbleElements(letters, opts);

  return {
    ...controller,
    destroy() {
      controller.destroy();
      el.replaceChildren(...originalNodes);
      if (ownsLabel) el.removeAttribute('aria-label');
    },
  };
}
