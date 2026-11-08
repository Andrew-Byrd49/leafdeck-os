// Markdown for the Claude Code app's transcript: what Claude Code writes, as the desktop app shows it. Headings,
// paragraphs, nested lists and task lists, quotes, tables, rules, fenced code (with its language and a copy button),
// inline code, bold, italics, strikethrough, links and file paths. Everything is escaped first; nothing from the text
// becomes markup it didn't ask for. Links open in Leafdeck's browser (data-url); files in the editor (data-file).
import { esc } from '../util.js';

const URL_RE = /^(https?:\/\/|mailto:)/i;

function inline(src) {
  // Code spans first, kept out of the other rules.
  const codes = [];
  let s = String(src).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => {
    codes.push(code.trim() ? code.replace(/^ (.*) $/, '$1') : code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // Links: [label](url). Bare URLs too.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    const u = url.replace(/&amp;/g, '&');
    if (URL_RE.test(u)) return `<a href="#" data-url="${esc(u)}">${label}</a>`;
    if (/^[\w./-]+(:\d+)?$/.test(u) && !u.startsWith('//')) return `<a href="#" data-file="${esc(u)}">${label}</a>`;
    return label;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => `${pre}<a href="#" data-url="${url}">${url}</a>`);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[\s).,!?:;<]|$)/g, '$1<i>$2</i>').replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s).,!?:;<]|$)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[Number(i)];
    // A file path in backticks (src/app.js, src/app.js:42) opens in the editor.
    if (/^[\w.@-]*[\w-]\/[\w./@-]+\.\w+(:\d+)?$|^[\w-]+\.(js|ts|tsx|jsx|cjs|mjs|py|rs|go|md|json|css|html|sh|toml|yaml|yml)(:\d+)?$/.test(c)) return `<code class="cm-path" data-file="${esc(c)}">${esc(c)}</code>`;
    return `<code>${esc(c)}</code>`;
  });
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const close = fence[2];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(close)) code.push(lines[i++].slice(fence[1].length));
      i++;
      out.push(codeBlock(code.join('\n'), fence[3]));
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const lvl = Math.min(6, h[1].length + 2);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(`<div class="cm-table"><table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => td('td', r[j] ?? '', j)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+•]|\d+[.)])\s+/.test(line)) {
      flush();
      const block = [];
      while (i < lines.length && (lines[i].trim() === '' ? /^\s*([-*+•]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i + 1] || '') : /^\s*([-*+•]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i]))) block.push(lines[i++]);
      out.push(list(block));
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('');
}

/** A list and the lists inside it, by indentation. */
function list(block) {
  const first = /^(\s*)([-*+•]|\d+[.)])\s+/.exec(block[0]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  for (const l of block) {
    const m = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(l);
    if (m && m[1].length <= indent) items.push([m[3]]);
    else if (items.length) items.at(-1).push(l.slice(Math.min(indent + 2, l.length - l.trimStart().length)));
  }
  const li = (it) => {
    let [head, ...rest] = it;
    let box = '';
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(head);
    if (task) {
      box = `<span class="cm-check${task[1] === ' ' ? '' : ' on'}"></span>`;
      head = task[2];
    }
    const sub = rest.filter((l) => l.trim());
    return `<li${task ? ' class="cm-task"' : ''}>${box}${inline(head)}${sub.length ? markdown(sub.join('\n')) : ''}</li>`;
  };
  return ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${items.map(li).join('')}</ol>` : `<ul>${items.map(li).join('')}</ul>`;
}

export function codeBlock(code, lang = '') {
  return `<div class="cm-code"><div class="cm-code-head"><span>${esc(lang || 'text')}</span><button class="cm-copy" type="button" title="Copy">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
}
