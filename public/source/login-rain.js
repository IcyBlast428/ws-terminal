export function startLoginRain(canvas, foreground) {
  const context = canvas?.getContext('2d', { alpha: true });
  if (!context || !foreground) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0; let height = 0; let columns = []; let protectedArea;
  let frame = 0; let previous = 0; let clock = 0;
  let disposed = false;

  function resize() {
    width = innerWidth; height = innerHeight;
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.font = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
    context.textAlign = 'center';
    protectedArea = foreground.getBoundingClientRect();
    const count = Math.min(100, Math.ceil(width / 26));
    columns = Array.from({ length: count }, (_, index) => ({
      x: (index + 0.5) * width / count, y: Math.random() * height,
      speed: 28 + Math.random() * 35, length: 10 + Math.floor(Math.random() * 17),
      seed: Math.floor(Math.random() * 10000), cyan: index % 5 === 0
    }));
    paint();
  }

  function paint() {
    context.clearRect(0, 0, width, height);
    for (const column of columns) {
      for (let index = 0; index < column.length; index++) {
        const y = column.y - index * 19;
        if (y < -20 || y > height + 20) continue;
        // Leave a quiet, feathered area behind the form without blurring its text.
        const dx = Math.max(protectedArea.left - 50 - column.x, 0, column.x - protectedArea.right - 50);
        const dy = Math.max(protectedArea.top - 45 - y, 0, y - protectedArea.bottom - 45);
        const distance = Math.min(1, Math.hypot(dx, dy) / 170);
        const quiet = 0.10 + 0.90 * distance * distance * (3 - 2 * distance);
        const tail = 1 - index / column.length;
        context.globalAlpha = quiet * (index === 0 ? 0.64 : 0.30 * tail * tail);
        context.fillStyle = index === 0 ? '#94c9ac' : column.cyan ? '#559eaa' : '#4ca67a';
        const digit = (column.seed + index * 7 + Math.floor(clock / 420 + index / 3)) % 10;
        context.fillText(String(digit), column.x, y);
      }
    }
    context.globalAlpha = 1;
  }

  function tick(now) {
    frame = 0;
    if (disposed || document.hidden || reducedMotion.matches) return;
    if (!previous) previous = now;
    const elapsed = now - previous;
    if (elapsed >= 1000 / 24) {
      const delta = Math.min(elapsed, 100);
      clock += delta; previous = now;
      for (const column of columns) {
        column.y += column.speed * delta / 1000;
        if (column.y - column.length * 19 > height) column.y = -20;
      }
      paint();
    }
    frame = requestAnimationFrame(tick);
  }

  function resume() {
    cancelAnimationFrame(frame); frame = 0; previous = 0;
    if (!disposed && !document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(tick);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(foreground);
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', resume);
  reducedMotion.addEventListener('change', resume);
  // Suspend on pagehide, but resume if the browser restores this page from its cache.
  const hide = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
  addEventListener('pagehide', hide);
  addEventListener('pageshow', resume);
  resize(); resume();
  return () => {
    disposed = true; hide(); observer.disconnect();
    removeEventListener('resize', resize); removeEventListener('pagehide', hide); removeEventListener('pageshow', resume);
    document.removeEventListener('visibilitychange', resume); reducedMotion.removeEventListener('change', resume);
  };
}
