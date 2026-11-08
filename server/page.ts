// Pages for the colony's findings: the markdown an agent wrote, shown as plain HTML.
// Everything is escaped before any markdown is read, links go only to http and https addresses, and the
// pages carry no scripts, so text an agent copied from the web cannot act on the colony.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const link = (url: string, label: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

function inline(text: string): string {
  // code spans are set aside first, so what is inside them stays as written
  const codes: string[] = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => link(url, label));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, before: string, url: string) => `${before}${link(url, url)}`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        if (/^\s*\|?\s*:?-{2,}/.test(lines[i])) continue;
        rows.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
      }
      i--;
      const [head = [], ...body] = rows;
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    const item = line.match(/^\s*[-*+]\s+(.*)$/) ?? line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (item) {
      const tag = /^\s*[-*+]\s/.test(line) ? 'ul' : 'ol';
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(item[1]);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // an indented line carries on the list item above it
    if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

const STYLE = `
:root { color-scheme: dark; }
body { margin: 0; background: #071416; color: #d9e7e4; font: 17px/1.6 "Iowan Old Style", "Palatino Linotype", Georgia, serif; }
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1rem 5rem; }
h1 { font-weight: 500; font-style: italic; font-size: 1.85rem; line-height: 1.25; margin: 0.3rem 0 1.2rem; color: #f1f7f5; }
h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.3; margin: 2rem 0 0.6rem; color: #eef6f4; }
strong { color: #fff; }
a { color: #7fe3c9; text-underline-offset: 2px; overflow-wrap: anywhere; }
code, pre { font: 0.88em ui-monospace, Menlo, monospace; background: #0d2124; border-radius: 4px; }
code { padding: 0.1em 0.3em; }
pre { padding: 0.8rem 1rem; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; font-size: 0.92em; display: block; overflow-x: auto; margin: 1rem 0; }
th, td { border-bottom: 1px solid #1d3a3e; padding: 0.45rem 0.7rem; text-align: left; vertical-align: top; }
th { color: #eef6f4; font-weight: 600; }
blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 2px solid #2b5458; color: #b8ccc8; }
hr { border: 0; border-top: 1px solid #1d3a3e; margin: 2rem 0; }
.kicker, .meta, .back { font: 13px/1.5 -apple-system, system-ui, sans-serif; color: #7f9a96; }
.kicker { letter-spacing: 0.06em; text-transform: uppercase; }
.back { margin-top: 3rem; }
ol.findings { list-style: none; padding: 0; }
ol.findings li { padding: 1rem 0; border-bottom: 1px solid #14292c; }
ol.findings a { font-style: italic; font-size: 1.1rem; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

// one finished answer: the question, the one-line finding and the full report, as the lead wrote them
export function findingPage(markdown: string, all: string): string {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'A finding';
  return shell(title, `<p class="kicker">The colony found</p>\n${renderMarkdown(markdown)}\n<p class="back"><a href="${all}">All findings</a></p>`);
}

export interface Listed {
  href: string;
  ask: string;
  finding: string;
  when: string;
}

export function indexPage(items: Listed[]): string {
  const rows = items.map(i => `<li><a href="${esc(i.href)}">${esc(i.ask)}</a><br>${esc(i.finding)}<div class="meta">${esc(i.when)}</div></li>`).join('');
  return shell('Findings', `<p class="kicker">The colony's findings</p><h1>Findings</h1>${items.length ? `<ol class="findings">${rows}</ol>` : '<p>Nothing has finished yet.</p>'}`);
}
