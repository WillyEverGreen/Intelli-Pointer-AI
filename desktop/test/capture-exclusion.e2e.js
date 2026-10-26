// Verifies that windows with content protection are left out of
// desktopCapturer screenshots, which is what lets the selection overlay
// appear instantly while the screen is captured behind it.
// Only reads the colour of the two test windows' pixels; saves nothing.
// Run: npx electron test/capture-exclusion.e2e.js
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWindow(x, color, protect) {
  const win = new BrowserWindow({
    x, y: 40, width: 120, height: 120, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: color,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (protect) win.setContentProtection(true);
  win.loadURL(`data:text/html,<body style="margin:0;background:${color}"></body>`);
  return win;
}

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const protectedWin = makeWindow(d.bounds.x + 40, '#ff0000', true);
  const normalWin = makeWindow(d.bounds.x + 200, '#00ff00', false);
  await wait(600);
  protectedWin.showInactive();
  normalWin.showInactive();
  await wait(600);

  const size = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
  const t0 = Date.now();
  const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const grabMs = Date.now() - t0;
  const img = src.thumbnail;
  const { width } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const pixel = (cssX, cssY) => {
    const px = Math.round(cssX * d.scaleFactor);
    const py = Math.round(cssY * d.scaleFactor);
    const i = (py * width + px) * 4;
    return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i] };
  };
  const red = pixel(100, 100);
  const green = pixel(260, 100);
  const isRed = red.r > 200 && red.g < 60 && red.b < 60;
  const isGreen = green.g > 200 && green.r < 60 && green.b < 60;
  console.log(`grab ${grabMs} ms at ${size.width}x${size.height}`);
  console.log(`${!isRed ? 'PASS' : 'FAIL'} protected window is excluded from the capture`);
  console.log(`${isGreen ? 'PASS' : 'FAIL'} normal window is captured (control)`);
  app.exit(!isRed && isGreen ? 0 : 1);
});
