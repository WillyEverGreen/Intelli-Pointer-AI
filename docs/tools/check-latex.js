// Structural check of the LaTeX sources when no TeX compiler is available:
// balanced braces, matched \begin/\end, and that every \import target and
// image resolves. Run: node docs/tools/check-latex.js
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'latex');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tex|sty)$/.test(e.name)) files.push(p);
  }
})(root);

let problems = 0;
const report = (file, msg) => {
  problems += 1;
  console.log(`BAD  ${path.relative(root, file)}: ${msg}`);
};

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const noComments = raw.replace(/(^|[^\\])%.*$/gm, '$1');
  const noCode = noComments.replace(/\\begin\{lstlisting\}[\s\S]*?\\end\{lstlisting\}/g, '');

  const braces = noCode.replace(/\\[{}]/g, '');
  let depth = 0;
  for (const c of braces) {
    depth += c === '{' ? 1 : c === '}' ? -1 : 0;
    if (depth < 0) break;
  }
  if (depth !== 0) report(file, `unbalanced braces (${depth})`);

  const stack = [];
  for (const m of noCode.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else if (stack.pop() !== m[2]) report(file, `\\end{${m[2]}} does not match`);
  }
  if (stack.length) report(file, `unclosed environment: ${stack.join(', ')}`);

  for (const m of noCode.matchAll(/\\import\{([^}]*)\}\{([^}]*)\}/g)) {
    if (!fs.existsSync(path.join(root, m[1], m[2]))) report(file, `missing imported file ${m[1]}${m[2]}`);
  }
  // Images guarded by \IfFileExists (the optional college logo) may be absent.
  const required = noCode.split('\n').filter((l) => !l.includes('\\IfFileExists')).join('\n');
  for (const m of required.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    if (!fs.existsSync(path.join(root, 'figures', m[1])) && !fs.existsSync(path.join(root, m[1]))) report(file, `missing image ${m[1]}`);
  }
}
const logo = fs.existsSync(path.join(root, 'figures', 'frcrce-logo.png'));
console.log(`${files.length} files checked; college logo ${logo ? 'present' : 'NOT found (add docs/latex/figures/frcrce-logo.png)'}`);
console.log(problems ? `${problems} problem(s)` : 'LaTeX structure OK');
process.exit(problems ? 1 : 0);
