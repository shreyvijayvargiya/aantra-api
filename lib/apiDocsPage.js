import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const DOCS_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"docs.md",
);

/** @type {{ html: string | null, mtimeMs: number }} */
const cache = { html: null, mtimeMs: 0 };

marked.setOptions({
	gfm: true,
	breaks: false,
});

const HTTP_METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.trim();
}

/** @param {string} line */
function parseParamBullet(line) {
	const patterns = [
		/^[-*]\s+`([^`]+)`(?:\s+\(([^)]+)\))?(?:\s+[—–-]\s+)(.+)$/,
		/^[-*]\s+`([^`]+)`(?:\s+\(([^)]+)\))?\s*$/,
		/^[-*]\s+`([^`]+)`\s+[—–-]\s+(.+)$/,
	];
	for (const re of patterns) {
		const m = line.match(re);
		if (!m) continue;
		return {
			name: m[1],
			type: m[2] || "—",
			description: (m[3] || "—").trim(),
		};
	}
	return null;
}

/** Convert **Required** / **Optional** bullet blocks into markdown tables. */
function preprocessParamTables(md) {
	const lines = md.split("\n");
	const out = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const sectionMatch = line.match(/^\*\*(Required|Optional)\*\*\s*$/);
		if (!sectionMatch) {
			out.push(line);
			i++;
			continue;
		}

		const required = sectionMatch[1] === "Required";
		const bullets = [];
		let j = i + 1;
		while (j < lines.length) {
			const next = lines[j];
			if (next.trim() === "") {
				j++;
				continue;
			}
			if (
				next.startsWith("#") ||
				next.match(/^\*\*(Required|Optional|Response|Query params|Path params)\*\*/)
			) {
				break;
			}
			const param = parseParamBullet(next.trim());
			if (!param) break;
			bullets.push(param);
			j++;
		}

		if (bullets.length === 0) {
			out.push(line);
			i++;
			continue;
		}

		out.push("");
		out.push(
			`| Field | Type | ${required ? "Required" : "Optional"} | Description |`,
		);
		out.push("| --- | --- | --- | --- |");
		for (const p of bullets) {
			const reqCell = required ? "Yes" : "No";
			out.push(
				`| \`${p.name}\` | ${p.type} | ${reqCell} | ${p.description} |`,
			);
		}
		out.push("");
		i = j;
	}

	return out.join("\n");
}

/** @returns {{ id: string, method: string, path: string, label: string, group: string }[]} */
function extractNavItems(md) {
	const items = [];
	let currentGroup = "Overview";

	for (const line of md.split("\n")) {
		if (line.startsWith("## ") && !HTTP_METHOD_RE.test(line.slice(3))) {
			currentGroup = line.slice(3).trim();
			continue;
		}
		const m = line.match(/^##\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
		if (!m) continue;
		const method = m[1].toUpperCase();
		const route = m[2];
		const label = `${method} ${route}`;
		items.push({
			id: slugify(label),
			method,
			path: route,
			label,
			group: currentGroup,
		});
	}

	return items;
}

function methodBadgeClass(method) {
	const m = method.toUpperCase();
	if (m === "GET") return "method-get";
	if (m === "POST") return "method-post";
	if (m === "PUT" || m === "PATCH") return "method-put";
	if (m === "DELETE") return "method-delete";
	return "method-other";
}

function enhanceEndpointHeadings(html) {
	return html.replace(
		/<h2 id="([^"]*)">((?:GET|POST|PUT|PATCH|DELETE)\s+\S+)<\/h2>/gi,
		(_match, id, title) => {
			const m = title.match(HTTP_METHOD_RE);
			if (!m) return `<h2 id="${id}">${title}</h2>`;
			const method = m[1].toUpperCase();
			const route = m[2];
			const cls = methodBadgeClass(method);
			return `<div class="endpoint-header" id="${id}">
  <div class="endpoint-badge-row">
    <span class="method-badge ${cls}">${method}</span>
    <code class="endpoint-path">${route}</code>
  </div>
</div>`;
		},
	);
}

function buildSidebarNav(navItems) {
	const groups = new Map();
	for (const item of navItems) {
		if (!groups.has(item.group)) groups.set(item.group, []);
		groups.get(item.group).push(item);
	}

	let html = "";
	for (const [group, items] of groups) {
		if (group === "Overview" && items.length === 0) continue;
		html += `<div class="nav-group">`;
		html += `<div class="nav-group-title">${escapeHtml(group)}</div>`;
		html += `<ul class="nav-list">`;
		for (const item of items) {
			const cls = methodBadgeClass(item.method);
			html += `<li>
  <a href="#${item.id}" class="nav-link" data-nav-id="${item.id}">
    <span class="nav-method ${cls}">${item.method}</span>
    <span class="nav-path">${escapeHtml(item.path)}</span>
  </a>
</li>`;
		}
		html += `</ul></div>`;
	}

	html += `<div class="nav-group">
  <div class="nav-group-title">Reference</div>
  <ul class="nav-list">
    <li><a href="#authentication" class="nav-link" data-nav-id="authentication">Authentication</a></li>
    <li><a href="#content-types" class="nav-link" data-nav-id="content-types">Content types</a></li>
    <li><a href="#rate-limits-per-ip" class="nav-link" data-nav-id="rate-limits-per-ip">Rate limits</a></li>
    <li><a href="#endpoint-overview" class="nav-link" data-nav-id="endpoint-overview">Endpoint overview</a></li>
  </ul>
</div>`;

	return html;
}

function escapeHtml(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function wrapDocsHtml(bodyHtml, navItems) {
	const title = "Aantraa API";
	const sidebarNav = buildSidebarNav(navItems);
	const enhancedBody = enhanceEndpointHeadings(bodyHtml);

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Documentation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --mint: #0d9373;
      --mint-hover: #0b7d62;
      --mint-soft: rgba(13, 147, 115, 0.1);
      --bg: #ffffff;
      --bg-subtle: #f9fafb;
      --sidebar-bg: #fbfbfc;
      --surface: #ffffff;
      --text: #111827;
      --text-secondary: #4b5563;
      --text-muted: #6b7280;
      --border: #e5e7eb;
      --border-strong: #d1d5db;
      --code-bg: #f3f4f6;
      --pre-bg: #111827;
      --pre-text: #e5e7eb;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.04);
      --shadow-md: 0 4px 12px rgba(0,0,0,.06);
      --radius: 10px;
      --sidebar-w: 280px;
      --header-h: 56px;
      --get: #0d9373;
      --get-bg: rgba(13,147,115,.12);
      --post: #2563eb;
      --post-bg: rgba(37,99,235,.12);
      --put: #d97706;
      --put-bg: rgba(217,119,6,.12);
      --delete: #dc2626;
      --delete-bg: rgba(220,38,38,.12);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0c0e;
        --bg-subtle: #111318;
        --sidebar-bg: #0f1014;
        --surface: #16181d;
        --text: #f3f4f6;
        --text-secondary: #d1d5db;
        --text-muted: #9ca3af;
        --border: #272a33;
        --border-strong: #374151;
        --code-bg: #1f232b;
        --pre-bg: #0d0f14;
        --pre-text: #e5e7eb;
        --mint-soft: rgba(13, 147, 115, 0.18);
        --shadow-sm: 0 1px 2px rgba(0,0,0,.3);
        --shadow-md: 0 4px 12px rgba(0,0,0,.4);
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
      font-size: 15px;
      line-height: 1.65;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
    }
    code, pre, .endpoint-path {
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    /* Top bar */
    .topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: var(--header-h);
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0 1.25rem;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    .topbar-brand {
      display: flex;
      align-items: center;
      gap: .6rem;
      text-decoration: none;
      color: var(--text);
      font-weight: 700;
      font-size: .95rem;
      white-space: nowrap;
    }
    .brand-icon {
      width: 28px; height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--mint), #14b8a6);
      display: grid;
      place-items: center;
      color: #fff;
      font-size: .75rem;
      font-weight: 700;
    }
    .topbar-search-wrap {
      flex: 1;
      max-width: 420px;
      position: relative;
    }
    .topbar-search {
      width: 100%;
      padding: .5rem .75rem .5rem 2.25rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-subtle);
      color: var(--text);
      font: inherit;
      font-size: .875rem;
      outline: none;
      transition: border-color .15s, box-shadow .15s;
    }
    .topbar-search:focus {
      border-color: var(--mint);
      box-shadow: 0 0 0 3px var(--mint-soft);
    }
    .search-icon {
      position: absolute;
      left: .7rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      pointer-events: none;
      font-size: .9rem;
    }
    .topbar-links {
      display: flex;
      gap: .5rem;
      margin-left: auto;
    }
    .topbar-links a {
      font-size: .8125rem;
      color: var(--text-secondary);
      text-decoration: none;
      padding: .35rem .65rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      transition: background .15s, color .15s;
    }
    .topbar-links a:hover {
      background: var(--bg-subtle);
      color: var(--text);
    }
    .menu-btn {
      display: none;
      background: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: .4rem .55rem;
      cursor: pointer;
      color: var(--text);
      font-size: 1.1rem;
      line-height: 1;
    }

    /* Layout */
    .shell {
      display: flex;
      padding-top: var(--header-h);
      min-height: 100vh;
    }
    .sidebar {
      position: fixed;
      top: var(--header-h);
      left: 0;
      width: var(--sidebar-w);
      height: calc(100vh - var(--header-h));
      overflow-y: auto;
      padding: 1.25rem 1rem 2rem;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      z-index: 50;
    }
    .sidebar::-webkit-scrollbar { width: 6px; }
    .sidebar::-webkit-scrollbar-thumb {
      background: var(--border-strong);
      border-radius: 3px;
    }
    .nav-group { margin-bottom: 1.25rem; }
    .nav-group-title {
      font-size: .7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--text-muted);
      padding: 0 .5rem;
      margin-bottom: .4rem;
    }
    .nav-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .nav-link {
      display: flex;
      align-items: center;
      gap: .45rem;
      padding: .35rem .5rem;
      border-radius: 6px;
      text-decoration: none;
      color: var(--text-secondary);
      font-size: .8125rem;
      line-height: 1.35;
      transition: background .12s, color .12s;
    }
    .nav-link:hover {
      background: var(--mint-soft);
      color: var(--text);
    }
    .nav-link.active {
      background: var(--mint-soft);
      color: var(--mint);
      font-weight: 500;
    }
    .nav-method {
      font-size: .625rem;
      font-weight: 700;
      padding: .15rem .35rem;
      border-radius: 4px;
      flex-shrink: 0;
      letter-spacing: .02em;
    }
    .nav-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .method-get { background: var(--get-bg); color: var(--get); }
    .method-post { background: var(--post-bg); color: var(--post); }
    .method-put { background: var(--put-bg); color: var(--put); }
    .method-delete { background: var(--delete-bg); color: var(--delete); }
    .method-other { background: var(--code-bg); color: var(--text-muted); }

    .main {
      flex: 1;
      margin-left: var(--sidebar-w);
      min-width: 0;
    }
    .content {
      max-width: 820px;
      margin: 0 auto;
      padding: 2.5rem 2rem 5rem;
    }

    /* Docs typography */
    .docs > h1:first-child {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -.03em;
      margin: 0 0 .75rem;
      line-height: 1.2;
    }
    .docs > p:first-of-type {
      color: var(--text-secondary);
      font-size: 1.05rem;
      margin-top: 0;
    }
    .docs h2 {
      font-size: 1.35rem;
      font-weight: 600;
      margin: 2.5rem 0 1rem;
      padding-top: .5rem;
      scroll-margin-top: calc(var(--header-h) + 1rem);
      letter-spacing: -.02em;
    }
    .docs h2:not(.endpoint-header h2) {
      border-bottom: 1px solid var(--border);
      padding-bottom: .5rem;
    }
    .docs h3 {
      font-size: 1rem;
      font-weight: 600;
      margin: 1.75rem 0 .65rem;
      scroll-margin-top: calc(var(--header-h) + 1rem);
      color: var(--text);
    }
    .docs h4 {
      font-size: .9rem;
      font-weight: 600;
      margin: 1.25rem 0 .5rem;
      color: var(--text-secondary);
    }
    .docs p, .docs li { color: var(--text-secondary); }
    .docs strong { color: var(--text); font-weight: 600; }
    .docs a {
      color: var(--mint);
      text-decoration: none;
      font-weight: 500;
    }
    .docs a:hover { text-decoration: underline; }
    .docs ul, .docs ol {
      padding-left: 1.35rem;
      margin: .5rem 0 1rem;
    }
    .docs li { margin: .3rem 0; }
    .docs hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 2.5rem 0;
    }
    .docs code {
      font-size: .84em;
      background: var(--code-bg);
      padding: .15em .4em;
      border-radius: 5px;
      color: var(--text);
      border: 1px solid var(--border);
    }
    .docs pre {
      margin: 1rem 0 1.25rem;
      padding: 1rem 1.15rem;
      background: var(--pre-bg);
      color: var(--pre-text);
      border-radius: var(--radius);
      overflow-x: auto;
      font-size: .8125rem;
      line-height: 1.55;
      box-shadow: var(--shadow-sm);
      border: 1px solid var(--border);
    }
    .docs pre code {
      background: none;
      border: none;
      padding: 0;
      color: inherit;
      font-size: inherit;
    }

    /* Endpoint headers */
    .endpoint-header {
      margin: 2.75rem 0 1.25rem;
      scroll-margin-top: calc(var(--header-h) + 1rem);
    }
    .endpoint-badge-row {
      display: flex;
      align-items: center;
      gap: .75rem;
      flex-wrap: wrap;
      padding: 1rem 1.15rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
    }
    .method-badge {
      font-size: .7rem;
      font-weight: 700;
      padding: .3rem .55rem;
      border-radius: 6px;
      letter-spacing: .04em;
    }
    .endpoint-path {
      font-size: .95rem;
      font-weight: 500;
      color: var(--text);
      word-break: break-all;
    }

    /* Tables */
    .table-wrap {
      margin: 1rem 0 1.5rem;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      background: var(--surface);
    }
    .docs table {
      width: 100%;
      border-collapse: collapse;
      font-size: .875rem;
      min-width: 480px;
    }
    .docs thead {
      background: var(--bg-subtle);
    }
    .docs th {
      text-align: left;
      font-weight: 600;
      font-size: .75rem;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: var(--text-muted);
      padding: .7rem 1rem;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    .docs td {
      padding: .7rem 1rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      color: var(--text-secondary);
    }
    .docs tr:last-child td { border-bottom: none; }
    .docs tbody tr:hover td {
      background: var(--mint-soft);
    }
    .docs td:first-child code {
      font-weight: 500;
      color: var(--mint);
      border-color: transparent;
      background: var(--mint-soft);
    }
    .docs td:nth-child(3) {
      font-size: .8125rem;
      white-space: nowrap;
    }

    /* Callout-style first paragraph after h2 */
    .docs blockquote {
      margin: 1rem 0;
      padding: .85rem 1rem;
      border-left: 3px solid var(--mint);
      background: var(--mint-soft);
      border-radius: 0 var(--radius) var(--radius) 0;
      color: var(--text-secondary);
    }
    .docs blockquote p { margin: 0; }

    /* Mobile */
    @media (max-width: 900px) {
      .menu-btn { display: block; }
      .topbar-search-wrap { max-width: none; }
      .sidebar {
        transform: translateX(-100%);
        transition: transform .2s ease;
        box-shadow: var(--shadow-md);
      }
      .sidebar.open { transform: translateX(0); }
      .main { margin-left: 0; }
      .content { padding: 1.5rem 1.15rem 4rem; }
      .sidebar-overlay {
        display: none;
        position: fixed;
        inset: 0;
        top: var(--header-h);
        background: rgba(0,0,0,.4);
        z-index: 40;
      }
      .sidebar-overlay.open { display: block; }
    }
    @media (max-width: 600px) {
      .topbar-links { display: none; }
    }

    .no-results {
      display: none;
      padding: .75rem;
      color: var(--text-muted);
      font-size: .8125rem;
      text-align: center;
    }
    .nav-link.hidden { display: none; }
    .nav-group.empty { display: none; }
  </style>
</head>
<body>
  <header class="topbar">
    <button class="menu-btn" id="menuBtn" aria-label="Toggle navigation">☰</button>
    <a class="topbar-brand" href="/docs">
      <span class="brand-icon">A</span>
      <span>Aantraa API</span>
    </a>
    <div class="topbar-search-wrap">
      <span class="search-icon">⌕</span>
      <input type="search" class="topbar-search" id="docSearch" placeholder="Search endpoints…" autocomplete="off" />
    </div>
    <div class="topbar-links">
      <a href="/">Health</a>
      <a href="/api/docs.md">Markdown</a>
    </div>
  </header>

  <div class="shell">
    <div class="sidebar-overlay" id="sidebarOverlay"></div>
    <aside class="sidebar" id="sidebar">
      <div class="no-results" id="noResults">No matching endpoints</div>
      ${sidebarNav}
    </aside>
    <main class="main">
      <article class="content">
        <div class="docs">${enhancedBody}</div>
      </article>
    </main>
  </div>

  <script>
    (function () {
      const menuBtn = document.getElementById("menuBtn");
      const sidebar = document.getElementById("sidebar");
      const overlay = document.getElementById("sidebarOverlay");
      const search = document.getElementById("docSearch");
      const noResults = document.getElementById("noResults");

      function toggleSidebar(open) {
        sidebar.classList.toggle("open", open);
        overlay.classList.toggle("open", open);
      }
      menuBtn.addEventListener("click", () => toggleSidebar(!sidebar.classList.contains("open")));
      overlay.addEventListener("click", () => toggleSidebar(false));

      // Wrap tables for horizontal scroll styling
      document.querySelectorAll(".docs table").forEach((table) => {
        if (!table.parentElement.classList.contains("table-wrap")) {
          const wrap = document.createElement("div");
          wrap.className = "table-wrap";
          table.parentNode.insertBefore(wrap, table);
          wrap.appendChild(table);
        }
      });

      // Highlight Yes in Required column
      document.querySelectorAll(".docs td").forEach((td) => {
        if (td.textContent.trim() === "Yes") td.style.color = "var(--mint)";
        if (td.textContent.trim() === "Yes") td.style.fontWeight = "600";
      });

      // Active nav on scroll
      const navLinks = Array.from(document.querySelectorAll(".nav-link[data-nav-id]"));
      const sections = navLinks.map((link) => {
        const id = link.getAttribute("data-nav-id");
        return { link, el: document.getElementById(id) };
      }).filter((s) => s.el);

      function setActive() {
        const y = window.scrollY + 80;
        let current = sections[0];
        for (const s of sections) {
          if (s.el.offsetTop <= y) current = s;
        }
        navLinks.forEach((l) => l.classList.remove("active"));
        if (current) current.link.classList.add("active");
      }
      window.addEventListener("scroll", setActive, { passive: true });
      setActive();

      // Search filter
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let anyVisible = false;
        document.querySelectorAll(".nav-group").forEach((group) => {
          let groupVisible = false;
          group.querySelectorAll(".nav-link").forEach((link) => {
            const text = link.textContent.toLowerCase();
            const match = !q || text.includes(q);
            link.classList.toggle("hidden", !match);
            if (match) { groupVisible = true; anyVisible = true; }
          });
          group.classList.toggle("empty", !groupVisible);
        });
        noResults.style.display = q && !anyVisible ? "block" : "none";
      });

      // Close mobile nav on link click
      navLinks.forEach((link) => {
        link.addEventListener("click", () => toggleSidebar(false));
      });
    })();
  </script>
</body>
</html>`;
}

const renderer = new marked.Renderer();

renderer.heading = function heading({ tokens, depth }) {
	const text = this.parser.parseInline(tokens);
	const plain = tokens
		.map((t) => ("text" in t ? t.text : ""))
		.join("")
		.trim();
	const id = slugify(plain);
	if (depth <= 3) {
		return `<h${depth} id="${id}">${text}</h${depth}>\n`;
	}
	return `<h${depth}>${text}</h${depth}>\n`;
};

marked.use({ renderer });

export async function readApiDocsMarkdown() {
	return readFile(DOCS_PATH, "utf8");
}

export async function renderApiDocsHtml() {
	const st = await stat(DOCS_PATH);
	if (cache.html && cache.mtimeMs === st.mtimeMs) {
		return cache.html;
	}
	const rawMd = await readFile(DOCS_PATH, "utf8");
	const md = preprocessParamTables(rawMd);
	const navItems = extractNavItems(md);
	const bodyHtml = marked.parse(md);
	const html = wrapDocsHtml(bodyHtml, navItems);
	cache.html = html;
	cache.mtimeMs = st.mtimeMs;
	return html;
}
