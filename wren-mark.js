// The Wren logo, drawn on a canvas so the service worker (toolbar icon), the player bar, and
// icons/build.html (which exports the PNG icons) can share it. Three logos and five colors,
// chosen by clicking the logo on the player bar.
// `var` so injecting it into a page twice is harmless.

var WREN_MARK = {
  // g: the logo's gradient. accent/text: the player's accent color, and accent-colored text,
  // each as [light mode, dark mode].
  palettes: {
    ember: { name: 'Ember', g: ['#ffb547', '#ff5e3a'], accent: ['#ff5e3a', '#ff6a45'], text: ['#e5482a', '#ff8a66'] },
    rose: { name: 'Rose', g: ['#ff9ac1', '#e0457b'], accent: ['#e0457b', '#f0609a'], text: ['#c93368', '#ff8fb8'] },
    dusk: { name: 'Dusk', g: ['#5ac8fa', '#3a5bff'], accent: ['#3a6bff', '#5a86ff'], text: ['#2f5be0', '#8aa8ff'] },
    moss: { name: 'Moss', g: ['#a8e063', '#1f9d6b'], accent: ['#1f9d6b', '#2fb57f'], text: ['#17845a', '#6fd3a0'] },
    ink: { name: 'Ink', g: ['#636366', '#1c1c1e'], accent: ['#3a3a3c', '#aeaeb2'], text: ['#1d1d1f', '#f5f5f7'] },
  },
  shapes: {
    soundtail: 'Soundtail', // a wren whose cocked tail is a fan of three sound-level bars
    songbird: 'Songbird',   // a wren singing, with sound waves from its beak
    wave: 'Wave',           // a W drawn as a voice waveform
  },
  tile: 'M30 0 H70 C88 0 100 12 100 30 V70 C100 88 88 100 70 100 H30 C12 100 0 88 0 70 V30 C0 12 12 0 30 0Z',
  // Soundtail's bars: [x, y, angle, length], from the base where they meet the body.
  feathers: [[33, 60, -60, 26], [33, 60, -40, 34], [33, 60, -20, 28]],
  // Three levels move while reading: seconds per cycle and starting offset. Slow and out of
  // step, so the logo breathes rather than bounces.
  sway: [[2.4, 0], [2.0, 0.7], [2.8, 1.3]],
  depth: 0.2, // levels dip to 80% at the bottom of a sway

  // Levels (1 = at rest) at time t seconds.
  levels(t) {
    return this.sway.map(([period, offset]) => 1 - this.depth * (1 - Math.cos(2 * Math.PI * (t + offset) / period)) / 2);
  },

  // How far a level is from its dip: 1 at rest, 0 at the bottom of a sway.
  rest(level) {
    return (level - (1 - this.depth)) / this.depth;
  },

  // round: a circular tile (the player bar) instead of a rounded square (the toolbar).
  draw(ctx, size, { shape = 'soundtail', color = 'ember', levels = [1, 1, 1], pad = 0, round = false } = {}) {
    const pal = this.palettes[color] || this.palettes.ember;
    const k = (size - 2 * pad) / 100;
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.translate(pad, pad);
    ctx.scale(k, k);
    let tile;
    if (round) {
      tile = new Path2D();
      tile.arc(50, 50, 50, 0, 2 * Math.PI);
    } else {
      tile = new Path2D(this.tile);
    }
    const grad = ctx.createLinearGradient(0, 0, 100, 100);
    grad.addColorStop(0, pal.g[0]);
    grad.addColorStop(1, pal.g[1]);
    ctx.fillStyle = grad;
    ctx.fill(tile);
    const sheen = ctx.createLinearGradient(0, 0, 0, 100);
    sheen.addColorStop(0, 'rgba(255,255,255,.22)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fill(tile);
    if (round) {
      // Keep the drawing clear of the circle's edge.
      ctx.translate(50, 50);
      ctx.scale(0.86, 0.86);
      ctx.translate(-50, -50);
    }
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineJoin = ctx.lineCap = 'round';
    (this.shapes[shape] ? this[shape] : this.soundtail).call(this, ctx, levels, pal);
    ctx.restore();
  },

  soundtail(ctx, levels, pal) {
    this.feathers.forEach(([x, y, angle, len], i) => {
      const h = len * levels[i];
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle * Math.PI / 180);
      ctx.beginPath();
      ctx.roundRect(-3.25, 2 - h, 6.5, h, 3.25);
      ctx.fill();
      ctx.restore();
    });
    this.bird(ctx, pal, { body: [47, 63, 20, 15], head: [62, 50, 11.5], beak: 'M70.5 46 L80 49.5 L70.5 53 Z', eye: [65, 47.5, 2.3] });
  },

  songbird(ctx, levels, pal) {
    ctx.save();
    ctx.translate(25, 57);
    ctx.rotate(-32 * Math.PI / 180);
    ctx.beginPath();
    ctx.roundRect(-6, -27, 12, 30, 6);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 3.2;
    ctx.stroke(new Path2D('M30 74 L28 82 M44 76 L44 83'));
    this.bird(ctx, pal, { body: [41, 60, 21, 16.5], head: [55, 46, 12], beak: 'M64 41.5 L74 45.5 L64 49.5 Z', eye: [58, 43.5, 2.4] });
    // The sound waves pulse while reading.
    ctx.lineWidth = 4.2;
    [['M78.5 38.5 A10 10 0 0 1 78.5 52.5', levels[0]], ['M84 32 A18 18 0 0 1 84 59', levels[1]]].forEach(([d, level]) => {
      ctx.globalAlpha = 0.3 + 0.7 * this.rest(level);
      ctx.stroke(new Path2D(d));
    });
    ctx.globalAlpha = 1;
  },

  wave(ctx, levels) {
    // Peaks and troughs of the W; the middle and outer ones swell and settle with their own
    // levels while reading.
    const xs = [14, 32, 50, 68, 86];
    const ys = [0, 1, 2, 1, 0].map((li, i) => {
      const amp = 13 * (0.45 + 0.55 * this.rest(levels[li]));
      return 50 + (i % 2 ? amp : -amp);
    });
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < xs.length; i++) ctx.bezierCurveTo(xs[i - 1] + 9, ys[i - 1], xs[i] - 8, ys[i], xs[i], ys[i]);
    ctx.lineWidth = 9;
    ctx.stroke();
  },

  bird(ctx, pal, { body, head, beak, eye }) {
    ctx.beginPath();
    ctx.ellipse(body[0], body[1], body[2], body[3], 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head[0], head[1], head[2], 0, 2 * Math.PI);
    ctx.fill();
    const b = new Path2D(beak);
    ctx.lineWidth = 2;
    ctx.fill(b);
    ctx.stroke(b);
    ctx.fillStyle = pal.g[1];
    ctx.beginPath();
    ctx.arc(eye[0], eye[1], eye[2], 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#fff';
  },
};
