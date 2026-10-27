# LaTeX report

Professional LaTeX version of the project report, structured like a thesis:
cover, index, abstract, lists of figures and tables, introduction, three main
chapters, conclusion, references and annexes (including the register of every
experiment, by name).

## Build

- **Overleaf (easiest):** upload `docs/IntelliPointer-Report-LaTeX.zip`, set the main document to `main.tex`, compile with pdfLaTeX.
- **On your PC:** install MiKTeX or TeX Live, then run `pdflatex main` twice in this folder (twice so the table of contents and lists fill in).

## Add the college logo

Save the Fr. CRCE logo as **`figures/frcrce-logo.png`**. The cover picks it up automatically; without it the cover simply has no logo.

## Edit

The chapters in `content/` are **generated** from `docs/REPORT.md` and `docs/EXPERIMENTS.md`. Edit those, then:

```bash
node docs/tools/build-latex.js     # regenerate the chapters
node docs/tools/check-latex.js     # structure check (no TeX needed)
```

Hand-written files: `main.tex`, `styles.sty`, `common/cover.tex`, `content/01-index.tex`, `content/02-abstract.tex`, `content/03-lists.tex`. Fill in the submission date and academic year on the cover (`common/cover.tex`).

The layout follows the structure of the school template you shared, but uses standard LaTeX packages only (that template's `inf-pucv` class is not available here).
