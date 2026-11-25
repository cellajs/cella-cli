import { launchBrowser } from './browser';

/**
 * A report's Markdown as one HTML page: headings, tables (the first cell of a row is its header), lists, `> ` notes,
 * bold, code and `*(...)*` asides. `extraStyle` is CSS appended to the shared look.
 */
export function toHtml(markdown: string, title: string, extraStyle = '') {
  const inline = (text: string) =>
    text
      .replace(/&(?!lt;|gt;|amp;)/g, '&amp;')
      .replace(/<(?!br>)/g, '&lt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*\((.+?)\)\*/g, '<em>($1)</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  const cells = (line: string) =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((value) => inline(value.trim().replace(/\\\|/g, '|').replace(/\\\\/g, '\\')));
  const body: string[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) body.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    else if (line.startsWith('| ')) {
      const head = cells(line);
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i].startsWith('| '); i++) {
        const [first, ...rest] = cells(lines[i]);
        rows.push(`<tr><th scope="row">${first}</th>${rest.map((value) => `<td>${value}</td>`).join('')}</tr>`);
      }
      i -= 1;
      body.push(
        `<table><thead><tr>${head.map((value) => `<th scope="col">${value}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
      );
    } else if (line.startsWith('- ')) {
      const items: string[] = [];
      for (; i < lines.length && lines[i].startsWith('- '); i++) items.push(`<li>${inline(lines[i].slice(2))}</li>`);
      i -= 1;
      body.push(`<ul>${items.join('')}</ul>`);
    } else if (line.startsWith('> ')) body.push(`<p class="note">${inline(line.slice(2))}</p>`);
    else if (line.trim()) body.push(`<p>${inline(line)}</p>`);
  }
  const style =
    'body{font:11pt/1.45 system-ui,sans-serif;color:#111;margin:0}h1{font-size:20pt}h2{font-size:14pt;margin-top:1.6em}h3{font-size:12pt}' +
    'table{border-collapse:collapse;width:100%;margin:.6em 0}th,td{border:1px solid #777;padding:5px 7px;text-align:left;vertical-align:top;font-size:9.5pt}' +
    'thead th{background:#eee}tbody th{font-weight:600}.note{border-left:4px solid #b45309;padding-left:10px}tr{break-inside:avoid}';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${style}${extraStyle}</style></head><body>${body.join('\n')}</body></html>`;
}

/** The page as a tagged A4 PDF with an outline, printed by the app's own Playwright Chromium. */
export async function writePdf(repoRoot: string, html: string, path: string): Promise<void> {
  const browser = await launchBrowser(repoRoot);
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.pdf({
      path,
      format: 'A4',
      tagged: true,
      outline: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    });
  } finally {
    await browser.close();
  }
}
