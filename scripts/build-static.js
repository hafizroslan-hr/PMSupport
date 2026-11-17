'use strict';
// Builds the static site (for GitHub Pages) into dist/:
//   dist/                 the web pages
//   dist/data/index.json  search index
//   dist/data/files/N.json  full content of each note file (loaded on demand)
//   dist/notes/           the original uploaded files

const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const { SUPPORTED } = require('../lib/parsers');

const root = path.join(__dirname, '..');
const OUT = path.resolve(process.env.OUT_DIR || path.join(root, 'dist'));
const NOTES = path.resolve(process.env.NOTES_DIR || path.join(root, 'onenotes'));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'data', 'files'), { recursive: true });
  fs.cpSync(path.join(root, 'public'), OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'vendor'));
  fs.copyFileSync(path.join(root, 'node_modules', 'minisearch', 'dist', 'umd', 'index.js'), path.join(OUT, 'vendor', 'minisearch.js'));
  fs.copyFileSync(path.join(root, 'lib', 'search-core.js'), path.join(OUT, 'search-core.js'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  const store = new Store(NOTES);
  await store.refresh();
  if (fs.existsSync(NOTES)) {
    fs.cpSync(NOTES, path.join(OUT, 'notes'), { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
  }

  // Folder of the notes inside the repo (used by the admin page to write via the GitHub API).
  const rel = path.relative(root, NOTES).split(path.sep).join('/');
  const notesDir = rel.startsWith('..') || !rel ? 'onenotes' : rel;
  const version = Date.now().toString(36);
  const files = store.fileList().map((f, fid) => ({ ...f, fid }));
  for (const f of files) {
    const sections = store.files.get(f.path).sections.map(({ id, title, text, html }) => ({ id, title, text, html }));
    fs.writeFileSync(path.join(OUT, 'data', 'files', `${f.fid}.json`), JSON.stringify({ sections }));
  }
  fs.writeFileSync(path.join(OUT, 'data', 'index.json'), JSON.stringify(store.index.toJSON()));
  fs.writeFileSync(
    path.join(OUT, 'data', 'manifest.json'),
    JSON.stringify({
      version,
      builtAt: new Date().toISOString(),
      repo: process.env.GITHUB_REPOSITORY || '',
      notesDir: notesDir,
      supported: SUPPORTED,
      stats: store.stats(),
      files,
    })
  );

  const bad = files.filter((f) => f.error);
  console.log(`Built ${OUT}: ${store.stats().sections} entries from ${files.length} file(s).`);
  for (const f of bad) console.warn(`Warning: ${f.path}: ${f.error}`);
})();
