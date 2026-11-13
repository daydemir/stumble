/**
 * Behavioural assertions, run in a real browser against live DOM, computed
 * style and the Web Animations API. Mode-aware: it asserts motion when the
 * page allows it and stillness under prefers-reduced-motion, so test/run.mjs
 * runs it in both states. Open test/index.html in any browser to run it by hand.
 */
import { stumble, stumbleElements } from '../stumble.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

const make = (html) => {
  const el = document.createElement('h1');
  el.innerHTML = html;
  document.body.append(el);
  return el;
};

const lettersOf = (el) => [...el.querySelectorAll('[aria-hidden="true"] > span')];
const runningOn = (els) => els.flatMap((el) => el.getAnimations()).filter((a) => a.playState === 'running');

// Created once per page and kept alive across runs, so the runner can flip
// prefers-reduced-motion between runs and see this instance follow live.
const live = make('LIVE');
stumble(live);

export async function run() {
  // Media-query change events fire on a later rendering update.
  await nextFrame();
  await nextFrame();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? undefined : detail });

  // --- Split, accessibility, restore -------------------------------------
  {
    const el = make('SUN <em>SET</em>');
    const em = el.querySelector('em');
    const before = el.outerHTML;
    const controller = stumble(el);
    const letters = lettersOf(el);

    check('one span per letter', letters.length === 6, letters.length);
    check('one aria-hidden span per word', el.querySelectorAll('[aria-hidden="true"]').length === 2);
    check('textContent is unchanged', el.textContent === 'SUN SET', el.textContent);
    check('aria-label carries the text', el.getAttribute('aria-label') === 'SUN SET');
    const range = document.createRange();
    range.selectNodeContents(el);
    check('selection copies the original string', range.toString() === 'SUN SET', range.toString());
    check('letters are laid out', letters.every((l) => l.getBoundingClientRect().width > 0));

    controller.destroy();
    check('destroy() restores the markup byte for byte', el.outerHTML === before, el.outerHTML);
    check('destroy() restores the original nodes', el.querySelector('em') === em);
    el.remove();
  }

  {
    const el = make('HI');
    el.setAttribute('aria-label', 'host label');
    const controller = stumble(el);
    check('an existing aria-label is kept', el.getAttribute('aria-label') === 'host label');
    controller.destroy();
    check('an existing aria-label survives destroy()', el.getAttribute('aria-label') === 'host label');
    el.remove();
  }

  {
    const text = 'CAFÉ \u{1F469}‍\u{1F4BB}\n\tGO';
    const el = make('');
    el.textContent = text;
    const controller = stumble(el);
    const glyphs = lettersOf(el).map((l) => l.textContent);
    check('splits by grapheme cluster', glyphs.join('|') === 'C|A|F|É|\u{1F469}‍\u{1F4BB}|G|O', glyphs);
    check('whitespace runs are preserved', el.textContent === text, el.textContent);
    controller.destroy();
    el.remove();
  }

  {
    const el = make('STUMBLE WOBBLE');
    el.style.width = '0';
    const controller = stumble(el);
    const words = [...el.querySelectorAll('[aria-hidden="true"]')];
    const tops = words.map((w) => new Set([...w.children].map((l) => l.offsetTop)).size);
    check('a word never breaks across lines', tops.every((n) => n === 1), tops);
    check('words still wrap between each other', words[0].offsetTop !== words[1].offsetTop);
    controller.destroy();
    el.remove();
  }

  {
    let threw = false;
    try {
      stumbleElements([document.createElementNS('http://www.w3.org/2000/svg', 'g')]);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    check('rejects SVG elements (lesson 2)', threw);
  }

  // --- Motion ---------------------------------------------------------------
  check('live instance follows prefers-reduced-motion', runningOn(lettersOf(live)).length === (reduced ? 0 : 4), runningOn(lettersOf(live)).length);

  if (reduced) {
    const el = make('STILL');
    const controller = stumble(el);
    const letters = lettersOf(el);
    check('reduced: no animations', runningOn(letters).length === 0);
    check('reduced: no transform', letters.every((l) => getComputedStyle(l).transform === 'none'));
    check('reduced: no will-change', letters.every((l) => l.style.willChange === ''));
    controller.start();
    check('reduced: start() cannot override the preference', runningOn(letters).length === 0);
    controller.destroy();
    el.remove();

    const opted = make('OPT');
    const optedOut = stumble(opted, { respectReducedMotion: false });
    check('reduced: respectReducedMotion:false still animates', runningOn(lettersOf(opted)).length === 3);
    optedOut.destroy();
    opted.remove();
    return results;
  }

  {
    const el = make('ENERGY');
    const amplitude = { x: 3, y: 1 };
    const rotate = 0.7;
    const controller = stumble(el, { amplitude, rotate, durationRange: [2, 3], delayRange: [0.5, 1] });
    const letters = lettersOf(el);
    const animations = runningOn(letters);
    check('one running animation per letter', animations.length === letters.length, animations.length);
    check('every animation targets an HTML element', animations.every((a) => a.effect.target instanceof HTMLElement));
    check('letters are promoted up front', letters.every((l) => l.style.willChange === 'transform'));

    const timings = animations.map((a) => a.effect.getTiming());
    check('duration lands in durationRange', timings.every((t) => t.duration >= 2000 && t.duration <= 3000));
    check('delay lands in delayRange', timings.every((t) => t.delay >= 500 && t.delay <= 1000));
    check('iterates forever', timings.every((t) => t.iterations === Infinity));

    const parse = (frame) =>
      frame.transform.match(/-?\d+(\.\d+)?/g).map(Number); // [x, y, r]
    const frames = animations.map((a) => a.effect.getKeyframes().map(parse));
    check('rest, three poses, rest', frames.every((f) => f.length === 5 && [f[0], f[4]].every((p) => p.every((v) => v === 0))));
    const poses = frames.flatMap((f) => f.slice(1, 4));
    const onEllipse = poses.every(([x, y]) => Math.abs((x / amplitude.x) ** 2 + (y / amplitude.y) ** 2 - 1) < 0.01);
    check('equal energy: every pose sits on the amplitude ellipse (lesson 1)', onEllipse, poses);
    check('equal energy: every rotation is exactly ±rotate', poses.every(([, , r]) => Math.abs(r) === rotate), poses);

    controller.stop();
    check('stop() cancels every animation', runningOn(letters).length === 0);
    check('stop() snaps letters to rest (lesson 5)', letters.every((l) => getComputedStyle(l).transform === 'none'));
    check('stop() releases will-change', letters.every((l) => l.style.willChange === ''));
    controller.start();
    check('start() rebuilds the animations', runningOn(letters).length === letters.length);
    controller.destroy();
    check('destroy() cancels every animation', runningOn(letters).length === 0);
    el.remove();
  }

  {
    const el = make('MOVE');
    const controller = stumble(el, { durationRange: [0.3, 0.3], delayRange: [0, 0] });
    const letter = lettersOf(el)[0];
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      seen.add(getComputedStyle(letter).transform);
      await nextFrame();
    }
    check('the transform actually changes over time', seen.size > 2, [...seen]);
    controller.destroy();
    el.remove();
  }

  {
    const el = make('IDLE');
    const controller = stumble(el, { active: false });
    check('active:false starts still', runningOn(lettersOf(el)).length === 0);
    controller.start();
    check('start() after active:false animates', runningOn(lettersOf(el)).length === 4);
    controller.destroy();
    el.remove();
  }

  return results;
}
