// "Share my week" (plan 2026-11-06, wave 2): a picture of the person's own
// week with Kaashify, drawn here on a canvas in the site's look. Only these numbers
// and Kaashify, never the screen or anything the person asked. The host copies
// it to the clipboard and keeps a copy in Pictures; nothing is uploaded.
// window.KaashifyShare.draw(summary, firstName) -> a 1080 x 1350 canvas.
(() => {
  'use strict';
  const W = 1080, H = 1350;
  const INK = '#060810', CREAM = '#f1ecdf', BRASS = '#d1a75f', COBALT = '#00DCFA', MIST = '#b9c1d3';
  function seeded(n) { let s = n >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const mark = new Image();
  mark.src = '../renderer/logo.png';

  function draw(s, name) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = INK; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.55, H * 1.1, 0, W * 0.55, H * 1.1, H * 0.75);
    glow.addColorStop(0, 'rgba(40,52,110,.65)'); glow.addColorStop(1, 'rgba(40,52,110,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    const rnd = seeded(11);
    for (let i = 0; i < 140; i++) { g.fillStyle = `rgba(241,236,223,${(0.15 + rnd() * 0.45).toFixed(2)})`; g.fillRect(rnd() * W, rnd() * H, rnd() < 0.15 ? 2 : 1, rnd() < 0.15 ? 2 : 1); }
    if (mark.complete && mark.naturalWidth) g.drawImage(mark, W - 306, 175, 152, 152);
    const pad = 96;
    g.textBaseline = 'alphabetic';
    g.fillStyle = COBALT; g.font = "500 26px 'JetBrains Mono', monospace";
    const spaced = (t, x, y, gap) => { let cx = x; for (const ch of t) { g.fillText(ch, cx, y); cx += g.measureText(ch).width + gap; } };
    spaced('MY WEEK WITH KAASHIFY', pad, 190, 7);
    g.fillStyle = CREAM; g.font = "400 76px 'Instrument Serif', serif";
    const who = name ? name + "'s week," : 'My week,';
    g.fillText(who, pad, 300);
    g.fillStyle = BRASS; g.font = "italic 400 76px 'Instrument Serif', serif";
    g.fillText('with Kaashify.', pad, 384);
    g.fillStyle = CREAM; g.font = "400 300px 'Instrument Serif', serif";
    g.fillText(String(s.weekDone || 0), pad - 8, 700);
    g.fillStyle = MIST; g.font = "400 40px Inter, sans-serif";
    g.fillText((s.weekDone === 1 ? 'thing' : 'things') + ' done for me this week', pad, 770);
    const rows = [];
    if (s.weekBlocked) rows.push([String(s.weekBlocked), 'feeds kept away']);
    if (s.minutesBack >= 5) rows.push(['~' + (s.minutesBack >= 60 ? Math.floor(s.minutesBack / 60) + 'h ' + String(s.minutesBack % 60).padStart(2, '0') + 'm' : s.minutesBack + 'm'), 'given back, all time (an estimate)']);
    if (s.streak && s.streak.days) rows.push([String(s.streak.days), 'workday' + (s.streak.days === 1 ? '' : 's') + ' in a row']);
    rows.push([String(s.thingsDone || 0), 'things done, all time']);
    let y = 880;
    for (const [big, small] of rows.slice(0, 4)) {
      g.strokeStyle = 'rgba(206,216,246,.18)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(pad, y - 54); g.lineTo(W - pad, y - 54); g.stroke();
      g.fillStyle = CREAM; g.font = "400 60px 'Instrument Serif', serif"; g.fillText(big, pad, y + 6);
      g.fillStyle = MIST; g.font = "400 32px Inter, sans-serif"; g.fillText(small, pad + 230, y);
      y += 96;
    }
    g.fillStyle = MIST; g.font = "500 24px 'JetBrains Mono', monospace";
    spaced('KAASHIFY · KAASHIFY.COM', pad, H - 80, 5);
    return c;
  }
  window.KaashifyShare = { draw, W, H };
})();
