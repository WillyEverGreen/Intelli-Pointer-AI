// Renders SVG files to PNG with Electron (no extra dependencies): the SVG is
// drawn onto a canvas in a hidden page and read back, so no GPU or visible
// window is needed.
//   cd desktop && npx electron ../docs/tools/svg-to-png.js ../docs/architecture.svg ../docs/sequence.svg
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SCALE = 2; // crisp in documents
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<body></body>');
  for (const file of process.argv.slice(2).filter((a) => a.endsWith('.svg'))) {
    const svg = fs.readFileSync(file, 'utf8');
    const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = ${Number(w) * SCALE};
        c.height = ${Number(h) * SCALE};
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG failed to load'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
    })`);
    const out = file.replace(/\.svg$/, '.png');
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${path.basename(out)} (${w}x${h} @${SCALE}x)`);
  }
  app.exit(0);
});
