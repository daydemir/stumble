# stumble

Each letter of a word drifts on its own: a couple of pixels of translate and
half a degree of rotate, on a slow randomized cycle, so a headline looks like
it's breathing rather than glitching. It's the letter wobble from the headings
on [denizaydemir.com](https://denizaydemir.com) and the
[Sunset Logic](https://sunsetlogic.com) hero, pulled out into a standalone,
zero-dependency library.

The effect looks trivial, but making it run on the compositor thread at 60fps
in both Chromium and WebKit, with almost no main-thread cost, took several
rounds of profiling. The [engine lessons](#the-five-engine-lessons) below
record what that turned up, so nobody has to rediscover it.

- One ES module, no dependencies, no build step.
- Web Animations API: after setup the browser runs the animation itself,
  with no `requestAnimationFrame` loop and no per-frame JavaScript.
- Every letter moves with the same energy. Only the direction is random.
- Respects `prefers-reduced-motion`, and picks up changes to it while the
  page is open.
- Screen readers hear the word, not its letters, and selecting and copying
  the text still gives you the original string.

## Demo

```sh
git clone https://github.com/daydemir/stumble && cd stumble
python3 -m http.server 8000
open http://localhost:8000/demo/
```

The demo shows a display headline and a grid of option variations
(amplitude, an anisotropic ellipse, rotation, a fast cycle) with a stop/start
toggle. ES modules don't load from `file://`, so serve the repo with any
static server.

## Install

Copy `stumble.js` into your project, or install it from GitHub:

```sh
npm install github:daydemir/stumble
```

```js
import { stumble } from 'stumble'; // or './stumble.js'
```

It needs `Intl.Segmenter` and the Web Animations API: Chrome 87+, Safari
14.1+, Firefox 125+.

## Usage

### Plain text

```js
import { stumble } from './stumble.js';

const controller = stumble(document.querySelector('h1'));

controller.stop();    // letters snap back to rest
controller.start();   // fresh random poses
controller.destroy(); // stop, unsubscribe, restore the original DOM
```

`stumble(el, options)` replaces the element's text with one inline-block
`<span>` per letter and animates each one:

- Letters are split by **grapheme cluster** (`Intl.Segmenter`), so `É`
  written as `E` plus a combining accent, or an emoji sequence like 👩‍💻,
  stays in one piece.
- Each word is wrapped in a `white-space: nowrap` span, so a line never
  breaks mid-word. Whitespace between words stays as plain text nodes.
- The word wrappers are `aria-hidden`, and the element gets the text as its
  `aria-label` (unless it already has one), so a screen reader announces
  "SUNSET" instead of "S, U, N, S, E, T". `aria-label` is only reliably
  announced on elements with a role, so use it on a heading or give the
  element a role.
- The letters are still real text nodes in document order, so selecting and
  copying the heading gives you the original string.
- Child markup is flattened to text while the effect is active.
  `destroy()` puts the original child nodes, and any `aria-label`, back
  exactly as they were.

Call `destroy()` when you remove the element. Each controller holds a
`prefers-reduced-motion` listener until then.

### Pre-split elements

If your letters already exist as separate elements, for example HTML
wrappers positioned over holes cut in an SVG mask, animate them directly:

```js
import { stumbleElements } from './stumble.js';

const controller = stumbleElements(document.querySelectorAll('.hero-letter'), {
  amplitude: 2,
  rotate: 0.5,
});
```

Every element must be an `HTMLElement`. SVG elements throw a `TypeError`
(see [lesson 2](#2-never-animate-a-transform-on-an-svg-element)).

### Options

| Option | Default | Meaning |
|---|---|---|
| `amplitude` | `2` | Radius in px of the ellipse every pose sits on. A number gives a circle. Pass `{ x, y }` for an ellipse. |
| `rotate` | `0.5` | Rotation in degrees. Every pose gets exactly ±this. |
| `durationRange` | `[3.2, 4.8]` | Seconds. Each letter's cycle length is picked once from this range. |
| `delayRange` | `[0, 1.6]` | Seconds. Each letter's start delay is picked once from this range, so letters don't move in lockstep. |
| `active` | `true` | Start animating immediately. With `false`, nothing moves until `start()`. |
| `respectReducedMotion` | `true` | Cancel every animation while `prefers-reduced-motion: reduce` matches, and rebuild them when it stops matching. |

### Controller

Both functions return:

```ts
{
  start(): void;   // animate, unless reduced motion is on and respected
  stop(): void;    // cancel the animations; letters snap back to rest
  destroy(): void; // stop and remove the media-query listener; stumble() also restores the DOM
}
```

The animation owns each letter's `transform`. To layer another offset on a
letter, such as a scroll parallax, use the individual `translate` CSS
property, which composes with `transform` instead of fighting it.

## The five engine lessons

These came from profiling the animation on the live Sunset Logic and
denizaydemir.com pages in Chromium and WebKit. `stumble.js` follows all
five. If you're tempted to "simplify" the animation's shape, read these
first.

### 1. Equal-energy poses, not uniform-random ones

Every letter gets the **same excursion magnitude**. A pose sits on the
amplitude ellipse at a random *angle*, and its rotation is the **full**
rotation amplitude with a random *sign*. The magnitude is never random.

An earlier version drew each offset from a uniform random range. By chance,
later letters often ended up with bigger draws than earlier ones, and the
word looked like it was *degrading* toward its end, like a typo forming.
Fixing the magnitude and randomizing only the direction reads as one
consistent animation.

```js
function pose(amplitude, rotate) {
  const angle = Math.random() * Math.PI * 2;
  const sign = Math.random() < 0.5 ? -1 : 1;
  return [amplitude.x * Math.cos(angle), amplitude.y * Math.sin(angle), rotate * sign];
}
```

### 2. Never animate a transform on an SVG element

Blink won't run a `transform` animation on an SVG element on the
compositor thread, not even on a root `<svg>`. It quietly falls back to
recomputing and repainting on the main thread every frame. There's no
console warning and no visible difference until you profile. On the
production page, the SVG-targeted version cost about 2100ms of main-thread
time over a 6-second idle window. The same animation on a plain HTML
`<div>` wrapping the SVG cost about 93ms.

So wrap whatever moves (an SVG letter, a masked hole) in a plain HTML
element and animate that element's `transform`. That's why
`stumbleElements()` only accepts HTML elements.

### 3. A local `<mask>` or painted `<text>` inside the animated subtree also kills the fast path

Two more ways to lose the compositor fast path, even with the animation on
an HTML element:

- **A `<mask>` (or `<defs>` holding one) defined inside the animated
  subtree.** Blink repaints every frame even though the mask never
  changes. Define the mask in a separate sibling `<svg>` (say
  `width="0" height="0"`) and reference it with `mask="url(#id)"`. Mask
  references resolve by document-wide ID, so this costs nothing. Getting it
  wrong took Paint count from 7 to 2527, and Layout from 0 to 361, over the
  same 6-second idle window.
- **`<text>` painted inside the animated subtree.** It causes the same
  repaint-every-frame regression. If a moving patch needs letterforms (for
  a hover state, say), insert them only while they're needed.

The rule: keep everything under the element you `.animate()` free of local
mask definitions and painted `<text>`. Static geometry, references to
external masks, and raster content like `<image>` are fine.

### 4. WebKit's canvas ink metrics can lie for webfonts

This one matters only if you build a per-letter mask layer like the Sunset
Logic hero. If you measure glyph ink extents with
`CanvasRenderingContext2D.measureText()` (`actualBoundingBoxLeft` and
`actualBoundingBoxRight`) to find where it's safe to cut a per-letter cell,
WebKit sometimes returns the **advance box** for webfonts instead of the
ink box. The measured gap between letters then collapses to roughly the
letter spacing. In production it showed up as a gap of `-0.00006`px between
letters that visibly didn't touch.

When the ink box equals the advance box, fall back to a pixel scan: draw
the glyph on an offscreen canvas, read it back with `getImageData`, and
scan the alpha columns for the real edges. Cache the result per glyph and
font.

### 5. The timing recipe, and why reduced motion cancels instead of pausing

Every letter follows the same shape:

- **Five keyframes**: rest, pose 1, pose 2, pose 3, rest, each segment
  eased `ease-in-out`.
- **Duration** 3.2–4.8s and **delay** 0–1.6s, picked per letter, so
  letters never move in lockstep.
- **Amplitude** about ±2px of translate and ±0.5deg of rotate, chosen as in
  lesson 1.
- **Iterations**: infinite.
- **Reduced motion cancels every animation instead of pausing it.** With
  `fill: 'none'`, a cancelled animation snaps its letter straight back to
  rest. A paused one would freeze each letter mid-drift, which looks like
  a broken layout rather than a calm word. When reduced motion turns off
  again, the animations are rebuilt with new poses instead of resumed.

If you ever need a fallback for an engine where infinite WAAPI animations
aren't viable, reproduce this shape with a `requestAnimationFrame` clock:
continuous time from the frame timestamp (not a tick grid that can drift
after a stall), the same five-keyframe ease-in-out interpolation, and the
same cancel-and-rebuild behavior.

## Where it came from

The effect started as the per-letter drift on the headings of
[denizaydemir.com](https://denizaydemir.com). The
[Sunset Logic](https://sunsetlogic.com) homepage hero then pushed it
further: the headline there is a **knockout**, with the letters cut as
holes in an opaque plate so the scene behind shows through. Each letter is
its own small mask-and-plate patch inside a plain HTML wrapper, and that
wrapper is what wobbles. The mask itself never moves and is never
re-rasterized.

If you port the knockout treatment, your code owns cutting the per-letter
patches and positioning their HTML wrappers (lessons 3 and 4). This library
owns making each wrapper wobble: pass the wrappers to `stumbleElements()`.

## Tests

```sh
npm test
```

No dependencies here either. `test/run.mjs` serves the repo on a local port,
drives headless Chrome over the DevTools protocol with Node built-ins (Node
22+), and runs `test/suite.js` three times in one page: with motion
allowed, with `prefers-reduced-motion: reduce` emulated, and with it cleared
again, so live changes are tested in both directions. Set `CHROME_PATH` if
Chrome isn't in the default location. To run the suite in any other
browser, serve the repo and open `test/index.html`.

## License

[MIT](LICENSE)
