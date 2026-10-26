// Measures screen-grab latency with desktopCapturer (cold vs warm, full vs
// small thumbnails). Reads only image sizes; saves nothing.
// Run: npx electron test/capture-timing.e2e.js
const { app, desktopCapturer, screen } = require('electron');

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const full = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
  const time = async (label, size) => {
    const t0 = performance.now();
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const t1 = performance.now();
    const bmp = src.thumbnail.toBitmap();
    const t2 = performance.now();
    console.log(`${label.padEnd(18)} getSources ${Math.round(t1 - t0)} ms, toBitmap ${Math.round(t2 - t1)} ms (${src.thumbnail.getSize().width}x${src.thumbnail.getSize().height}, ${bmp.length} bytes)`);
  };
  await time('cold full', full);
  await time('warm full', full);
  await time('warm full', full);
  await time('warm tiny', { width: 1, height: 1 });
  await time('warm full', full);
  app.exit(0);
});
