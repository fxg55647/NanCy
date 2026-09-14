// Builds NanCy's published documentation site: converts a curated set of
// repo Markdown docs into static HTML under _site/, wrapped in a shared
// nav/template. The GitHub Actions workflow (.github/workflows/docs.yml)
// runs this on every push to main that touches docs, then publishes _site/
// to the gh-pages branch — the same push-to-gh-pages pattern used by
// fxg55647/leima's own status/audit pages, adapted here to build a whole
// multi-page site instead of a single JSON/HTML file.
//
// Usage: node --experimental-strip-types scripts/build-docs-site.mts
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, posix as pathPosix } from "node:path";
import { marked } from "marked";
import GithubSlugger from "github-slugger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const siteDir = join(repoRoot, "_site");
const repoUrl = "https://github.com/fxg55647/NanCy";
const commitSha = process.env.GITHUB_SHA?.slice(0, 7) ?? "local build";

// Deliberately excluded: TODO.md and EVAL-RESULTS.md are working notes /
// generated reports that churn often and aren't written for a reader —
// see CLAUDE.md's own docs map. Everything else — root docs plus the whole
// docs/ tree — is published.
const EXCLUDED_ROOT_DOCS = new Set(["TODO.md", "EVAL-RESULTS.md"]);

type DocFile = { repoPath: string; title: string; group: string };

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function listRootMarkdown(): string[] {
  return readdirSync(repoRoot)
    .filter(f => f.endsWith(".md") && !EXCLUDED_ROOT_DOCS.has(f))
    .filter(f => statSync(join(repoRoot, f)).isFile());
}

function listDocsMarkdown(dir: string): string[] {
  const abs = join(repoRoot, dir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = `${dir}/${entry}`;
    const full = join(repoRoot, rel);
    if (statSync(full).isDirectory()) out.push(...listDocsMarkdown(rel));
    else if (entry.endsWith(".md")) out.push(rel);
  }
  return out;
}

// A short human title from a filename: "SECURITY-PHILOSOPHY.md" -> "Security Philosophy",
// "2026-09-14-security-review.md" -> "2026-09-14 Security Review".
function titleFromFilename(repoPath: string): string {
  const base = repoPath.split("/").pop()!.replace(/\.md$/, "");
  return base.split(/[-_]/).map(w => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

function groupFor(repoPath: string): string {
  if (repoPath === "README.md") return "Overview";
  if (!repoPath.includes("/")) return "Overview";
  const top = repoPath.split("/").slice(0, 2).join("/"); // e.g. "docs/architecture"
  if (top === "docs/architecture") return "Architecture";
  if (top === "docs/audits") return "Audits";
  return "Docs";
}

function outputPathFor(repoPath: string): string {
  if (repoPath === "README.md") return "index.html";
  if (!repoPath.includes("/")) return `${repoPath.replace(/\.md$/, "").toLowerCase()}.html`;
  // docs/architecture/foo.md -> architecture/foo.html ; docs/audits/foo.md -> audits/foo.html
  const parts = repoPath.split("/").slice(1); // drop leading "docs"
  const file = parts.pop()!.replace(/\.md$/, "").toLowerCase();
  return [...parts, `${file}.html`].join("/");
}

// GitHub-compatible heading ids, reset per document: without them, every
// #anchor link (README's own table of contents, cross-doc references)
// would point nowhere, since marked doesn't add heading ids by default.
let currentSlugger = new GithubSlugger();
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const slug = currentSlugger.slug(this.parser.parseInline(tokens, this.parser.textRenderer));
      return `<h${depth} id="${slug}">${text}</h${depth}>\n`;
    },
  },
});

const repoPaths = [...listRootMarkdown(), ...listDocsMarkdown("docs")].map(toPosix).sort();
const docs: DocFile[] = repoPaths.map(repoPath => ({
  repoPath,
  title: repoPath === "README.md" ? "NanCy SSIL" : titleFromFilename(repoPath),
  group: groupFor(repoPath),
}));

// repoPath (lowercased, posix) -> output path, for rewriting cross-doc
// Markdown links into working links inside the built site.
const linkMap = new Map<string, string>(docs.map(d => [d.repoPath.toLowerCase(), outputPathFor(d.repoPath)]));

function rewriteMdLinks(html: string, fromRepoPath: string): string {
  const fromDir = pathPosix.dirname(fromRepoPath);
  const fromOutput = outputPathFor(fromRepoPath);
  const fromOutputDir = pathPosix.dirname(fromOutput);
  return html.replace(/href="(?!https?:\/\/|mailto:|#)([^"]+\.md)(#[^"]*)?"/g, (whole, target: string, anchor = "") => {
    const targetRepoPath = pathPosix.normalize(pathPosix.join(fromDir, decodeURIComponent(target)));
    const outputTarget = linkMap.get(targetRepoPath.toLowerCase());
    if (!outputTarget) {
      // Not part of the published set (e.g. TODO.md) — link to the file on
      // GitHub instead of leaving a dead relative link in the built site.
      return `href="${repoUrl}/blob/main/${targetRepoPath}${anchor}"`;
    }
    const relative = pathPosix.relative(fromOutputDir, outputTarget) || outputTarget;
    return `href="${relative}${anchor}"`;
  });
}

const GROUP_ORDER = ["Overview", "Docs", "Architecture", "Audits"];
function navHtml(currentOutput: string): string {
  const byGroup = new Map<string, DocFile[]>();
  for (const d of docs) {
    if (!byGroup.has(d.group)) byGroup.set(d.group, []);
    byGroup.get(d.group)!.push(d);
  }
  const currentDir = pathPosix.dirname(currentOutput);
  const sections = GROUP_ORDER.filter(g => byGroup.has(g)).map(group => {
    const items = byGroup.get(group)!
      .sort((a, b) => (a.repoPath === "README.md" ? -1 : b.repoPath === "README.md" ? 1 : a.title.localeCompare(b.title)))
      .map(d => {
        const out = outputPathFor(d.repoPath);
        const href = pathPosix.relative(currentDir, out) || out;
        const active = out === currentOutput ? ' aria-current="page"' : "";
        return `<li><a href="${href}"${active}>${d.title}</a></li>`;
      }).join("");
    return `<div class="nav-group"><h2>${group}</h2><ul>${items}</ul></div>`;
  }).join("");
  return sections;
}

function pageTemplate(title: string, bodyHtml: string, currentOutput: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — NanCy SSIL</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #5b6472; --border: #e2e5ea;
  --accent: #7c3aed; --code-bg: #f4f4f7; --nav-bg: #fafafa;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161c; --fg: #eef0f4; --muted: #9aa3b2; --border: #2a2e38;
    --accent: #b794f6; --code-bg: #1c1f27; --nav-bg: #191b22;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
.layout { display: flex; min-height: 100vh; }
nav.sidebar { width: 260px; flex-shrink: 0; background: var(--nav-bg); border-right: 1px solid var(--border); padding: 24px 16px; }
nav.sidebar h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 20px 0 6px; }
nav.sidebar ul { list-style: none; margin: 0; padding: 0; }
nav.sidebar li a { display: block; padding: 4px 8px; border-radius: 6px; text-decoration: none; color: var(--fg); font-size: 14px; }
nav.sidebar li a[aria-current="page"] { background: var(--accent); color: #fff; }
nav.sidebar li a:hover { background: var(--border); }
.brand { font-weight: 700; font-size: 18px; margin-bottom: 4px; }
.brand-sub { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
main { flex: 1; min-width: 0; padding: 40px clamp(16px, 5vw, 64px); max-width: 860px; }
main h1:first-child { margin-top: 0; }
pre { background: var(--code-bg); padding: 14px 16px; overflow-x: auto; border-radius: 8px; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; overflow-x: auto; display: block; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
blockquote { border-left: 3px solid var(--accent); margin: 0; padding: 0 16px; color: var(--muted); }
img { max-width: 100%; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
#nav-toggle { display: none; }
.nav-toggle-label { display: none; }
@media (max-width: 800px) {
  .layout { display: block; }
  nav.sidebar { width: auto; border-right: none; border-bottom: 1px solid var(--border); }
  #nav-toggle:not(:checked) ~ .layout nav.sidebar .nav-body { display: none; }
  .nav-toggle-label { display: block; padding: 16px; cursor: pointer; font-weight: 600; }
}
</style>
</head>
<body>
<input type="checkbox" id="nav-toggle">
<div class="layout">
<nav class="sidebar">
<label class="nav-toggle-label" for="nav-toggle">☰ Docs menu</label>
<div class="nav-body">
<div class="brand">NanCy SSIL</div>
<div class="brand-sub"><a href="${repoUrl}">GitHub ↗</a></div>
${navHtml(currentOutput)}
</div>
</nav>
<main>
${bodyHtml}
<footer>Generated from <a href="${repoUrl}">fxg55647/NanCy</a> — commit ${commitSha}. Docs, not audited production guidance; see NanCy's own README warning banner.</footer>
</main>
</div>
</body>
</html>`;
}

rmSync(siteDir, { recursive: true, force: true });
mkdirSync(siteDir, { recursive: true });

for (const doc of docs) {
  currentSlugger = new GithubSlugger();
  const raw = readFileSync(join(repoRoot, doc.repoPath), "utf8");
  const rawHtml = marked.parse(raw, { async: false }) as string;
  const html = rewriteMdLinks(rawHtml, doc.repoPath);
  const outputPath = outputPathFor(doc.repoPath);
  const outFile = join(siteDir, ...outputPath.split("/"));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, pageTemplate(doc.title, html, outputPath));
}

// Jekyll would otherwise ignore files starting with "_"; the site is plain
// static HTML with no Jekyll processing needed, so opt out explicitly.
writeFileSync(join(siteDir, ".nojekyll"), "");

console.log(`Built ${docs.length} page(s) into ${siteDir}`);
