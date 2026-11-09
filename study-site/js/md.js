/* Renderizador de Markdown minimalista (sem dependências).
 * Suporta: títulos, parágrafos, listas (aninhadas e de tarefas), tabelas,
 * blocos de código (```lang), mermaid, citações e callouts estilo Obsidian
 * (> [!tip] Título), linhas horizontais e formatação inline.
 */
(function () {
  "use strict";

  const CALLOUT_ICONS = {
    note: "ℹ️", info: "ℹ️", tip: "💡", hint: "💡", important: "❗", warning: "⚠️", caution: "⚠️",
    danger: "⛔", success: "✅", abstract: "📋", summary: "📋", example: "🧪", question: "❓", quote: "💬",
  };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function slug(s) {
    return String(s).toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  }

  // ---------- inline ----------
  function inline(text, opts) {
    const codes = [];
    let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = esc(s);
    // autolinks <https://...>
    s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, u) => link(u, u, opts));
    // images ![alt](src) -> show alt text only (images do repositório original não são incluídas)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => alt ? `<em class="img-alt">[imagem: ${alt}]</em>` : "");
    // links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, t, u) => link(u, t, opts, true));
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + esc(codes[+i]) + "</code>");
    return s;
  }

  function link(url, label, opts, labelIsHtml) {
    const raw = url.replace(/&amp;/g, "&");
    const resolved = opts && opts.resolveLink ? opts.resolveLink(raw) : null;
    const text = labelIsHtml ? label : esc(label);
    if (resolved) return `<a href="${esc(resolved)}">${text}</a>`;
    if (/^https?:/i.test(raw)) return `<a href="${esc(raw)}" target="_blank" rel="noopener">${text}</a>`;
    if (raw.startsWith("#")) return `<a href="javascript:void(0)" data-anchor="${esc(raw.slice(1))}">${text}</a>`;
    return `<span class="dead-link" title="${esc(raw)}">${text}</span>`;
  }

  // ---------- blocks ----------
  function render(md, opts) {
    opts = opts || {};
    const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
    return blocks(lines, opts);
  }

  function isTableSep(l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l); }
  function splitRow(l) {
    let t = l.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    const cells = []; let cur = ""; let inCode = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "`") inCode = !inCode;
      if (ch === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
      if (ch === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function blocks(lines, opts) {
    let out = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) { i++; continue; }

      // fenced code
      const fence = line.match(/^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/);
      if (fence) {
        const marker = fence[2]; const lang = fence[3].toLowerCase(); const indent = fence[1].length;
        const buf = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) {
          buf.push(lines[i].slice(Math.min(indent, lines[i].search(/\S|$/))));
          i++;
        }
        i++;
        const code = buf.join("\n");
        if (lang === "mermaid") out += `<div class="mermaid-wrap"><pre class="mermaid">${esc(code)}</pre></div>`;
        else out += `<pre class="code"><code class="lang-${esc(lang || "text")}">${esc(code)}</code>${lang ? `<span class="code-lang">${esc(lang)}</span>` : ""}</pre>`;
        continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) {
        const lvl = h[1].length; const html = inline(h[2], opts);
        out += `<h${lvl} id="${slug(h[2])}">${html}</h${lvl}>`;
        i++; continue;
      }

      // hr
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out += "<hr>"; i++; continue; }

      // blockquote / callout
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        const m = buf[0] && buf[0].match(/^\[!(\w+)\]([+-]?)\s*(.*)$/);
        if (m) {
          const type = m[1].toLowerCase(); const title = m[3] || defaultTitle(type);
          const body = blocks(buf.slice(1), opts);
          out += `<div class="callout callout-${esc(type)}"><div class="callout-title"><span>${CALLOUT_ICONS[type] || "📌"}</span> ${inline(title, opts)}</div>${body ? `<div class="callout-body">${body}</div>` : ""}</div>`;
        } else {
          out += `<blockquote>${blocks(buf, opts)}</blockquote>`;
        }
        continue;
      }

      // table
      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(c => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "");
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(splitRow(lines[i])); i++; }
        const al = j => aligns[j] ? ` style="text-align:${aligns[j]}"` : "";
        out += `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => `<th${al(j)}>${inline(c, opts)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map(r => `<tr>${head.map((_, j) => `<td${al(j)}>${inline(r[j] || "", opts)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`;
        continue;
      }

      // list
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const res = list(lines, i, opts);
        out += res.html; i = res.next; continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && lines[i].trim() !== "" &&
        !/^\s*(#{1,6}\s|>|```|~~~|([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
        !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) &&
        !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
        buf.push(lines[i].trim()); i++;
      }
      if (buf.length) out += `<p>${inline(buf.join(" "), opts)}</p>`;
      else i++;
    }
    return out;
  }

  function defaultTitle(type) {
    return ({ tip: "Dica", note: "Nota", important: "Importante", warning: "Atenção", abstract: "Resumo", success: "Resposta", example: "Exemplo" })[type] || type;
  }

  function list(lines, start, opts) {
    const baseIndent = lines[start].search(/\S/);
    const ordered = /^\s*\d+[.)]/.test(lines[start]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") {
        // continua a lista se a próxima linha não vazia for item/continuação indentada
        let j = i + 1; while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && lines[j].search(/\S/) >= baseIndent && /^\s*([-*+]|\d+[.)])\s+/.test(lines[j]) && lines[j].search(/\S/) === baseIndent) { i = j; continue; }
        if (j < lines.length && lines[j].search(/\S/) > baseIndent) { i = j; continue; }
        break;
      }
      const ind = l.search(/\S/);
      const m = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (m && ind === baseIndent) {
        items.push({ text: m[2], sub: [] }); i++; continue;
      }
      if (ind > baseIndent && items.length) { items[items.length - 1].sub.push(l.slice(Math.min(ind, baseIndent + 2))); i++; continue; }
      if (ind < baseIndent || m) break;
      // linha de continuação preguiçosa
      if (items.length) { items[items.length - 1].text += " " + l.trim(); i++; continue; }
      break;
    }
    const tag = ordered ? "ol" : "ul";
    const html = `<${tag}>` + items.map(it => {
      let t = it.text; let cls = "";
      const task = t.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) { cls = ' class="task"'; t = `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ` + inline(task[2], opts); }
      else t = inline(t, opts);
      const sub = it.sub.length ? blocks(it.sub, opts) : "";
      return `<li${cls}>${t}${sub}</li>`;
    }).join("") + `</${tag}>`;
    return { html, next: i };
  }

  window.MD = { render, inline, esc, slug };
})();
