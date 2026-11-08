---
name: pdf-design
description: Use when making a PDF that must look designed (report, summary, one-pager, brief). Build it as HTML+CSS, print it with headless Chrome, check every page as an image. Pair with the pdf skill for merge/split/extract.
---

# Designing a PDF

1. Write `pdfs/<name>/index.html` with inline CSS. A4, `@page { size: A4; margin: 0 }`, each page a `<section class="page">` of 210mm x 297mm with `page-break-after: always`.
2. Design like a product, not a document: one accent colour, a 2-font system stack (big bold headings, 10-11pt body), a 12-column grid, generous whitespace, a cover page with title and date, big numbers for key facts, tables with light row lines, a page number footer.
3. Real content only: take facts from the code, git log or reports. Never invent numbers.
4. Print: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf=pdfs/<name>/<name>.pdf file://$PWD/pdfs/<name>/index.html`
5. Check: `pdftoppm -r 60 -png file.pdf /tmp/pg` then Read each PNG. Fix overflow, cut-off text, orphan headings, empty pages. Repeat until clean.
6. Return the absolute path of the .pdf in the "pdf" field. Keep it short (1-6 pages).
