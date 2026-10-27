// Builds docs/IntelliPointer-Report.pdf (and .html) from docs/REPORT.md.
//   cd desktop && npm run report
// Uses Electron's PDF printing and the `marked` package already in desktop/.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { marked } = require(path.join(__dirname, '..', '..', 'desktop', 'node_modules', 'marked'));

const docs = path.join(__dirname, '..');
app.disableHardwareAcceleration();

const CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 10.5pt/1.5 "Segoe UI", Arial, sans-serif; color: #111827; }
  h1 { font-size: 22pt; margin: 0 0 6pt; } h2 { font-size: 15pt; margin: 20pt 0 6pt; border-bottom: 1px solid #d1d5db; padding-bottom: 3pt; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; page-break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9.5pt; page-break-inside: auto; }
  th, td { border: 1px solid #d1d5db; padding: 4pt 6pt; vertical-align: top; text-align: left; }
  th { background: #f3f4f6; } tr { page-break-inside: avoid; }
  code { font: 9pt Consolas, monospace; background: #f3f4f6; padding: 0 3pt; border-radius: 3pt; }
  pre { background: #f3f4f6; padding: 8pt; border-radius: 4pt; font-size: 8.5pt; overflow: hidden; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 8pt 0; padding: 4pt 10pt; border-left: 3px solid #9ca3af; color: #374151; background: #f9fafb; }
  img { max-width: 100%; display: block; margin: 8pt auto; page-break-inside: avoid; }
  em { color: #4b5563; } hr { border: 0; border-top: 1px solid #e5e7eb; margin: 14pt 0; }
  a { color: inherit; text-decoration: none; }
`;

app.whenReady().then(async () => {
  let md = fs.readFileSync(path.join(docs, 'REPORT.md'), 'utf8');
  // Embed images so the HTML and PDF are self-contained.
  md = md.replace(/!\[([^\]]*)\]\(([^)\s]+\.png)(?:\s+\"[^\"]*\")?\)/g, (_m, alt, file) => {
    const data = fs.readFileSync(path.join(docs, file)).toString('base64');
    return `![${alt}](data:image/png;base64,${data})`;
  });
  // The college logo is optional: used when docs/latex/figures/frcrce-logo.png exists.
  const logoFile = path.join(docs, 'latex', 'figures', 'frcrce-logo.png');
  const logo = fs.existsSync(logoFile)
    ? `<p style="text-align:center"><img style="height:90pt;margin:0 auto" src="data:image/png;base64,${fs.readFileSync(logoFile).toString('base64')}" alt="Fr. Conceicao Rodrigues College of Engineering"></p>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>IntelliPointer AI report</title><style>${CSS}</style></head><body>${logo}${marked.parse(md, { gfm: true })}</body></html>`;
  fs.writeFileSync(path.join(docs, 'IntelliPointer-Report.html'), html); // git-ignored
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadFile(path.join(docs, 'IntelliPointer-Report.html')); // a data: URL is capped at 2 MB
  const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(path.join(docs, 'IntelliPointer-Report.pdf'), pdf);
  console.log(`wrote IntelliPointer-Report.pdf (${Math.round(pdf.length / 1024)} KB)`);
  app.exit(0);
});
