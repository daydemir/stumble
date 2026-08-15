# stumble

The per-letter wobble animation from [denizaydemir.com](https://denizaydemir.com)
and the [Sunset Logic](https://sunsetlogic.com) hero, extracted into a
standalone, zero-dependency library. Each letter drifts through a small
random-looking pose cycle — a couple of pixels of translate, half a degree
of rotate — that reads as a word breathing rather than a page glitching.

It looks trivial. It is not: getting it to run on the compositor thread,
at 60fps, on both Chromium and WebKit, without measurable main-thread cost,
took several rounds of profiling against real engine behavior. This README
exists so the next implementer doesn't have to rediscover any of it.

## Install

No package, no build step. Copy `stumble.js` into your project and import
it as an ES module:

```html
<script type="module">
  import { stumble } from './stumble.js';
</script>
```

## Usage

### Plain text — let stumble split the letters

```js
import { stumble } from './stumble.js';

const controller = stumble(document.querySelector('h1'), {
  amplitude: 2,     // px, radius of the pose ellipse (or {x, y})
  rotate: 0.5,       // degrees, full rotation amplitude
  durationRange: [3.2, 4.8],  // seconds, randomized per letter
  delayRange: [0, 1.6],       // seconds, randomized per letter
});

// controller.stop() / controller.start() / controller.destroy()
```

`stumble(el, opts)` replaces `el`'s text content with one `<span
style="display:inline-block">` per non-space character (spaces stay as
plain text nodes so wrapping and selection keep working), then animates
each span. `controller.destroy()` restores the element's original
`innerHTML`.

### Pre-split elements — e.g. a knockout mask-hole build

If your letters already exist as separate elements — for instance, HTML
divs positioned over holes cut in an SVG mask, the way sunsetlogic.com's
knockout hero works (see Lesson 2 below for why those wrapper divs have to
be HTML, not SVG) — drive them directly:

```js
import { stumbleElements } from './stumble.js';

const letters = document.querySelectorAll('.hero-letter');
const controller = stumbleElements(letters, { amplitude: 2, rotate: 0.5 });
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `amplitude` | `2` | Radius (px) of the ellipse each pose sits on. A number applies to both axes (circle); pass `{ x, y }` for an anisotropic ellipse. |
| `rotate` | `0.5` | Rotation amplitude in degrees. Every pose gets ±this, never less. |
| `durationRange` | `[3.2, 4.8]` | Seconds. Each letter's cycle duration is randomized once in this range. |
| `delayRange` | `[0, 1.6]` | Seconds. Each letter's start delay is randomized once in this range, so letters don't move in lockstep. |
| `active` | `true` | Start animating immediately. |
| `respectReducedMotion` | `true` | Watch `prefers-reduced-motion: reduce` and cancel animations while it's set (see Lesson 5). |

### Controller

Both `stumble()` and `stumbleElements()` return:

```ts
{
  start(): void;    // (re)start animating
  stop(): void;     // cancel animations, letters snap to rest
  destroy(): void;  // stop() + release listeners; stumble() also restores original DOM
}
```

## The five engine lessons

These came out of profiling the animation on the real Sunset Logic and
denizaydemir.com pages across Chromium and WebKit. All five are encoded in
`stumble.js` — this section is here so a future implementer who is tempted
to "simplify" the animation shape understands what each piece is buying.

### 1. Equal-energy poses, not uniform-random ones

Every letter gets the **same excursion magnitude**. A pose is chosen by
picking a random *angle* on the amplitude ellipse (radius `amplitude`, or
`(amplitude.x, amplitude.y)` if anisotropic) and a random *sign* for
rotation at **full** rotation amplitude — never a random magnitude.

The bug this fixes isn't hypothetical: drawing each letter's translate
distance from a uniform random range (instead of fixing the magnitude and
randomizing only the angle) made later letters in a word visibly wobble
harder than earlier ones, purely by chance clustering across a run. Deniz's
read on it was immediate and specific: it looked like the word was
*degrading* toward its end, like a typo forming. Equal energy — same
magnitude, random direction — reads as a single consistent animation
instead.

```js
function pose(amplitude, rotate) {
  const angle = Math.random() * Math.PI * 2;
  const x = amplitude.x * Math.cos(angle);
  const y = amplitude.y * Math.sin(angle);
  const r = rotate * (Math.random() < 0.5 ? -1 : 1);
  return [x, y, r];
}
```

### 2. Never animate a transform on an SVG element — animate an HTML wrapper

Blink (Chromium) will not run a `transform` animation targeting an SVG
element on the compositor thread — not even a root `<svg>`. It silently
falls back to recomputing and repainting on the main thread, every single
vsync, with no console warning and no visible functional difference until
you profile it. Measured on the production page: the SVG-targeted version
cost roughly 2100ms of main-thread busy time over a 6-second idle window;
the identical animation retargeted onto a plain HTML `<div>` wrapping the
SVG cost about 93ms.

The fix is structural: wrap whatever visually moves (an SVG letter patch,
a masked hole, anything) in a plain HTML element, and animate *that*
element's `transform`. Never call `.animate()` (or apply a CSS transform
transition/animation) directly on an `<svg>`, a `<text>`, a `<g>`, or any
other SVG-namespace element if you want the compositor fast path.

This is why `stumbleElements()`'s contract is "pass HTML elements" — if
your letters are conceptually SVG (e.g. mask holes), the caller is
responsible for giving each one an HTML div wrapper positioned on top, and
passing *those* divs in.

### 3. A local `<mask>`/`<defs>`, or painted `<text>`, inside the animated subtree also kills the fast path

Two more ways to accidentally disqualify the same compositor fast path,
even once you've correctly moved the animation onto an HTML element:

- If that HTML element's subtree contains an SVG `<mask>` (or `<defs>`
  holding one) **scoped locally inside it**, Blink still falls back to a
  full repaint every frame — even though the mask content is 100% static
  and only an ancestor's transform is changing. The fix: define the
  `<mask>` in an external sibling `<svg>` (e.g. `width="0" height="0"`,
  positioned off to the side) and reference it from inside the animated
  subtree the normal way, `mask="url(#id)"` — SVG mask references resolve
  by document-wide ID lookup, so this costs nothing at render time and
  everything at compositor-eligibility time. Measured effect of getting
  this wrong: Paint count went from 7 to 2527 and Layout from 0 to 361
  over the same 6-second idle window.

- Independently of masking, any `<text>` **painted directly inside** the
  animated subtree disqualifies the same fast path too — verified as the
  identical paint-every-frame regression, with the mask hoisted out
  correctly and the only remaining difference being a `<text>` element
  physically inside the moving element. If you need letterforms inside a
  moving patch (e.g. for a hover state), build and insert that content
  lazily — only while it's actually needed — rather than baking it into
  the animated subtree at construction time.

Net rule: keep the *entire* subtree of whatever element you `.animate()`
free of local `<mask>`/`<defs>` definitions and free of painted `<text>`.
Static geometry, references to externally-defined masks, and raster
content (e.g. `<image>`) are fine; local mask definitions and live text
painting are not.

### 4. WebKit's canvas ink-metric APIs can lie for webfonts — have a pixel-scan fallback

If your implementation measures per-glyph ink extents via
`CanvasRenderingContext2D.measureText()`'s `actualBoundingBoxLeft` /
`actualBoundingBoxRight` (for example, to figure out where it's safe to cut
a per-letter clipping cell without slicing through a letterform), don't
trust those numbers unconditionally on WebKit. For some webfonts, WebKit
returns the **advance box** instead of the actual ink box — left edge at
0, right edge at the character's advance width — which collapses your
measured "ink gap" between letters down to essentially the letter-spacing
value. On a production measurement this showed up as a gap of
`-0.00006`px, i.e. WebKit reported letters as touching or overlapping when
they visibly were not.

Detect the degenerate case (ink box ≈ advance box) and fall back to an
actual pixel scan: draw the glyph to an offscreen canvas at a known
transform, read back `getImageData`, and scan alpha columns for the true
left/right ink edges. Cache per glyph+font-string; it's a one-time cost
per unique character.

This library doesn't include per-glyph ink measurement (it animates
whatever elements you give it — see Lessons 2 and 3 for what those
elements need to look like), but if you build the mask-hole-cutting layer
described in the note on sunsetlogic.com below, budget for this.

### 5. The timing recipe, and why reduced motion cancels instead of pauses

The shape every letter's animation follows:

- **4 waypoints**: rest → pose 1 → pose 2 → pose 3 → rest, each segment
  eased `ease-in-out`.
- **Duration**: 3.2–4.8s, randomized per letter.
- **Delay**: 0–1.6s, randomized per letter, so letters don't move in
  lockstep even with identical durations.
- **Amplitude**: ~±2px translate (the pose ellipse radius), ±0.5deg
  rotate — see Lesson 1 for how poses are actually chosen on that ellipse.
- **Iteration**: infinite.
- **`prefers-reduced-motion: reduce`**: **cancel** every animation, don't
  pause it. This library uses WAAPI's `fill: 'none'` (the default), which
  means a *cancelled* animation snaps its element straight back to the
  untransformed rest state. Pausing instead would freeze each letter
  wherever it happened to be mid-drift — which reads as a broken layout, a
  typo, not as a calm resting word. When reduced motion is turned back
  off, animations are rebuilt fresh (new random poses), not resumed from
  wherever they were cancelled.

If you're implementing a fallback for an engine or context where WAAPI
infinite animations aren't viable (the original site had to do this for
engines that couldn't support the compositor-patch architecture at all),
reproduce this same shape with a manual rAF clock: continuous time from
the raw timestamp (not a quantized tick grid, so nothing can drift or need
resnapping after a stall), the same four-waypoint/ease-in-out interpolation,
and the same cancel-on-reduce/rebuild-on-un-reduce behavior.

## Note: sunsetlogic.com's knockout hero

The Sunset Logic homepage hero renders its headline as a **knockout** —
the letters are literal holes cut in an opaque plate (an SVG mask), with a
lower layer (sky, gradient, video) showing through. That hero uses this
exact same wobble architecture: each letter is cut into its own small
mask-and-plate patch (not one mask for the whole word — see Lesson 3 on
why per-letter patches, each rasterised once, matter), wrapped in a plain
HTML `.mover` div, and it's that div's `transform` that
`stumbleElements()`-equivalent code animates (Lesson 2). The mask itself
never moves and is never re-rasterised after the initial build; only the
HTML wrapper's compositor layer moves.

If you're porting the knockout treatment elsewhere, the split of concerns
is: your own code owns cutting per-letter mask patches and positioning
their HTML wrapper divs (including the ink-measurement fallback in Lesson
4 for cutting safe cell boundaries); this library owns making each
wrapper div wobble correctly once it exists. Call `stumbleElements()` with
the wrapper divs.

## Files

- `stumble.js` — the library. Exports `stumble(el, opts)` and
  `stumbleElements(els, opts)`.
- `demo/index.html` — self-contained demo, no build step. Serve the repo
  root with any static file server and open `demo/index.html`.
- `LICENSE` — MIT.

## License

MIT, © Sunset Logic. See `LICENSE`.
