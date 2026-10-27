// Generates the LaTeX chapters in docs/latex/ from docs/REPORT.md and
// docs/EXPERIMENTS.md, so the report has one source of truth.
//
//   node docs/tools/build-latex.js
//
// Hand-written files (never overwritten): main.tex, styles.sty,
// common/cover.tex, content/02-abstract.tex, content/03-lists.tex.
// Generated files (edit the Markdown instead):
//   content/04-introduction.tex, content/sections/{1-description,2-development,3-results}.tex,
//   content/05-conclusion.tex, content/06-bibliography.tex, content/07-annexes.tex
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require(path.join(__dirname, '..', '..', 'desktop', 'node_modules', 'marked'));

const docs = path.join(__dirname, '..');
const out = path.join(docs, 'latex');
const unmapped = new Set();

// ---------- escaping ----------

const UNICODE = {
  '→': '\\ensuremath{\\rightarrow}', '←': '\\ensuremath{\\leftarrow}', '↔': '\\ensuremath{\\leftrightarrow}',
  '≈': '\\ensuremath{\\approx}', '×': '\\ensuremath{\\times}', '≥': '\\ensuremath{\\geq}', '≤': '\\ensuremath{\\leq}',
  '≠': '\\ensuremath{\\neq}', '±': '\\ensuremath{\\pm}', 'Σ': '\\ensuremath{\\Sigma}', '−': '-', '‑': '-', '‐': '-',
  '–': '--', '—': '---', '·': '\\textperiodcentered{}', '•': '\\textbullet{}', '…': '\\ldots{}',
  '“': '``', '”': "''", '‘': '`', '’': "'", '«': '\\guillemotleft{}', '»': '\\guillemotright{}',
  '°': '\\textdegree{}', '§': '\\S{}', '\u00a0': '~', '\u2009': '\\,', '\u202f': '\\,', '✔': '', '✓': '', '✅': '', '✖': '', '❌': '',
  '↑': '\\ensuremath{\\uparrow}', '↓': '\\ensuremath{\\downarrow}', '⇒': '\\ensuremath{\\Rightarrow}',
};
const ASCII_FOR_CODE = { '├': '|', '└': '`', '─': '-', '│': '|', '→': '->', '←': '<-', '…': '...', '·': '.', '—': '-', '–': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '×': 'x', '≈': '~', '≥': '>=', '≤': '<=', '↔': '<->', '✓': '', '✔': '' };

function decode(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

function escapeText(input) {
  let s = '';
  for (const ch of decode(input)) {
    if (UNICODE[ch] !== undefined) s += UNICODE[ch];
    else if (ch === '\\') s += '\\textbackslash{}';
    else if (ch === '{') s += '\\{';
    else if (ch === '}') s += '\\}';
    else if (ch === '&') s += '\\&';
    else if (ch === '%') s += '\\%';
    else if (ch === '$') s += '\\$';
    else if (ch === '#') s += '\\#';
    else if (ch === '_') s += '\\_';
    else if (ch === '~') s += '\\textasciitilde{}';
    else if (ch === '^') s += '\\textasciicircum{}';
    else if (ch === '<') s += '\\textless{}';
    else if (ch === '>') s += '\\textgreater{}';
    else if (ch === '|') s += '\\textbar{}';
    else if (ch === '"') s += '\\textquotedbl{}';
    else if (ch.codePointAt(0) > 0x24f) {
      unmapped.add(ch);
    } else s += ch;
  }
  return s;
}

// Inline code: monospace, with places where a long identifier may break.
function escapeCode(input) {
  let s = '';
  for (const ch of decode(input)) {
    if (ASCII_FOR_CODE[ch] !== undefined) s += ASCII_FOR_CODE[ch];
    else s += escapeText(ch);
    if ('/._-:,'.includes(ch)) s += '\\allowbreak{}';
  }
  return s;
}

// ---------- inline ----------

function inline(tokens = []) {
  return tokens.map((t) => {
    switch (t.type) {
      case 'text': return t.tokens ? inline(t.tokens) : escapeText(t.text);
      case 'escape': return escapeText(t.text);
      case 'strong': return `\\textbf{${inline(t.tokens)}}`;
      case 'em': return `\\emph{${inline(t.tokens)}}`;
      case 'del': return inline(t.tokens);
      case 'codespan': return `\\texttt{${escapeCode(t.text)}}`;
      case 'br': return '\\\\ ';
      case 'link': {
        const url = String(t.href).replace(/%/g, '\\%').replace(/#/g, '\\#');
        if (decode(t.text) === t.href) return `\\url{${url}}`;
        return `\\href{${url}}{${inline(t.tokens)}}`;
      }
      case 'html': return '';
      case 'image': return '';
      default: return t.raw ? escapeText(t.raw) : '';
    }
  }).join('');
}

const plain = (tokens) => decode((tokens || []).map((t) => t.text || '').join(''));

// ---------- blocks ----------

function stripNumber(title) {
  return title.replace(/^(Appendix\s+[A-Z]\.\s+)/, '').replace(/^\d+(\.\d+)*\.?\s+/, '').replace(/^[A-G]\.(\d+)?\s+/, '').trim();
}

function renderTable(tok, caption) {
  const n = tok.header.length;
  const weight = tok.header.map((h, c) => {
    const lens = [plain(h.tokens).length, ...tok.rows.map((r) => plain(r[c].tokens).length)];
    return Math.min(46, Math.max(6, Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)));
  });
  const total = weight.reduce((a, b) => a + b, 0);
  const spec = weight.map((w) => `>{\\raggedright\\arraybackslash}p{\\dimexpr(\\linewidth-${2 * n}\\tabcolsep)*${(w / total).toFixed(3)}\\relax}`).join('');
  const head = `\\rowcolor{tblhead}${tok.header.map((h) => `\\textbf{${inline(h.tokens)}}`).join(' & ')} \\\\`;
  const rows = tok.rows.map((r) => `${r.map((c) => inline(c.tokens)).join(' & ')} \\\\`).join('\n');
  return [
    '{\\small',
    `\\begin{longtable}{${spec}}`,
    `\\caption{${escapeText(caption)}}\\\\`,
    `\\toprule\n${head}\n\\midrule\n\\endfirsthead`,
    `\\toprule\n${head}\n\\midrule\n\\endhead`,
    '\\bottomrule\n\\endfoot',
    rows,
    '\\bottomrule',
    '\\end{longtable}',
    '}',
  ].join('\n');
}

function renderList(tok) {
  const env = tok.ordered ? 'enumerate' : 'itemize';
  const items = tok.items.map((it) => {
    const body = it.tokens.map((t) => {
      if (t.type === 'list') return `\n${renderList(t)}`;
      if (t.type === 'text' || t.type === 'paragraph') return inline(t.tokens || [{ type: 'text', text: t.text }]);
      return '';
    }).join(' ');
    return `\\item ${body}`;
  });
  return `\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}`;
}

function renderBlocks(tokens, ctx) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading': {
        const title = stripNumber(plain(t.tokens));
        ctx.heading = title;
        ctx.tableCount = 0;
        const cmd = { 2: 'section', 3: 'subsection', 4: 'subsubsection' }[t.depth] || 'paragraph';
        parts.push(`\\${cmd}{${escapeText(title)}}`);
        break;
      }
      case 'paragraph': {
        const only = t.tokens.length === 1 && t.tokens[0].type === 'image' ? t.tokens[0] : null;
        if (only) {
          // The caption is the italic paragraph that follows ("Figure N. ...").
          let j = i + 1;
          while (tokens[j]?.type === 'space') j += 1; // blank line between the image and its caption
          const next = tokens[j];
          let caption = only.text || '';
          if (next && next.type === 'paragraph' && next.tokens[0]?.type === 'em' && /^Figure\s+\d/.test(plain(next.tokens[0].tokens))) {
            caption = plain(next.tokens[0].tokens).replace(/^Figure\s+\d+\.\s*/, '');
            i = j;
          }
          const file = path.basename(only.href);
          ctx.figures.add(file);
          parts.push(`\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=\\linewidth]{${file}}\n\\caption{${escapeText(caption)}}\n\\end{figure}`);
        } else {
          parts.push(inline(t.tokens));
        }
        break;
      }
      case 'list': parts.push(renderList(t)); break;
      case 'table': {
        ctx.tableCount += 1;
        const caption = ctx.tableCount > 1 ? `${ctx.heading} (continued, ${ctx.tableCount})` : ctx.heading || 'Table';
        parts.push(renderTable(t, caption));
        break;
      }
      case 'code': {
        const code = decode(t.text).replace(/[^\x00-\x7f]/g, (c) => ASCII_FOR_CODE[c] ?? '?');
        parts.push(`\\begin{lstlisting}\n${code}\n\\end{lstlisting}`);
        break;
      }
      case 'blockquote': parts.push(`\\begin{quote}\n${renderBlocks(t.tokens, ctx)}\n\\end{quote}`); break;
      default: break; // space, hr, html
    }
  }
  return parts.join('\n\n');
}

// ---------- sections of the Markdown files ----------

function splitSections(md) {
  const sections = [];
  let current = { title: '', tokens: [] };
  for (const t of marked.lexer(md, { gfm: true })) {
    if (t.type === 'heading' && t.depth === 2) {
      sections.push(current);
      current = { title: plain(t.tokens), tokens: [t] };
    } else current.tokens.push(t);
  }
  sections.push(current);
  return sections;
}

const header = (what) => `% GENERATED by docs/tools/build-latex.js from ${what}. Do not edit: change the Markdown and rebuild.\n`;
const figures = new Set();

function chapter(title, label, sections) {
  const ctx = { heading: '', tableCount: 0, figures };
  const body = sections.map((s) => renderBlocks(s.tokens, ctx)).join('\n\n');
  return `${header('docs/REPORT.md')}\\chapter{${escapeText(title)}}\\label{${label}}\n\n${body}\n`;
}

function write(rel, text) {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`wrote ${path.relative(docs, file)}`);
}

const report = splitSections(fs.readFileSync(path.join(docs, 'REPORT.md'), 'utf8'));
const byNumber = (...nums) => report.filter((s) => nums.some((n) => new RegExp(`^${n}\\.\\s`).test(s.title)));
const byTitle = (re) => report.filter((s) => re.test(s.title));

write('content/04-introduction.tex', chapter('Introduction', 'ch:intro', byNumber(1, 2)));
write('content/sections/1-description.tex', chapter('Project Description and Design', 'ch:design', byNumber(3, 4, 5)));
write('content/sections/2-development.tex', chapter('Development and Security', 'ch:development', byNumber(6, 7)));
write('content/sections/3-results.tex', chapter('Testing and Results', 'ch:results', byNumber(8)));
write('content/05-conclusion.tex', chapter('Conclusions and Future Work', 'ch:conclusion', [...byNumber(9), ...byNumber(10)]));

// Bibliography from the numbered list in section 11.
{
  const sec = byNumber(11)[0];
  const list = sec.tokens.find((t) => t.type === 'list');
  const items = list.items.map((it, i) => `\\bibitem{ref${i + 1}} ${inline(it.tokens[0].tokens)}`);
  write('content/06-bibliography.tex', `${header('docs/REPORT.md')}\\begin{thebibliography}{99}\n${items.join('\n')}\n\\end{thebibliography}\n`);
}

// Annexes: rubric map, appendices, and the register of experiments.
{
  const ctx = { heading: '', tableCount: 0, figures };
  const rubric = byTitle(/^Where each rubric criterion/);
  const appendices = byTitle(/^Appendix/);
  const exp = splitSections(fs.readFileSync(path.join(docs, 'EXPERIMENTS.md'), 'utf8'));
  const expIntro = exp[0].tokens.filter((t) => t.type === 'paragraph');
  const expBody = exp.slice(1).map((s) => renderBlocks(s.tokens, ctx)).join('\n\n');
  const text = [
    `${header('docs/REPORT.md and docs/EXPERIMENTS.md')}\\chapter{Annexes}\\label{ch:annexes}`,
    renderBlocks(rubric.flatMap((s) => s.tokens), ctx),
    renderBlocks(appendices.flatMap((s) => s.tokens), ctx),
    `\\section{Register of experiments}\\label{sec:experiments}`,
    renderBlocks(expIntro, ctx),
    expBody,
  ].join('\n\n');
  write('content/07-annexes.tex', `${text}\n`);
}

// Copy the figures next to the LaTeX sources so the folder is self-contained (Overleaf).
fs.mkdirSync(path.join(out, 'figures'), { recursive: true });
for (const f of new Set([...figures, 'architecture.png', 'sequence.png'])) {
  fs.copyFileSync(path.join(docs, f), path.join(out, 'figures', f));
}

if (unmapped.size) console.warn(`WARNING: characters dropped (no LaTeX mapping): ${[...unmapped].join(' ')}`);
