'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const multer = require('multer');
const { Store } = require('./lib/store');
const { SUPPORTED } = require('./lib/parsers');

const PORT = process.env.PORT || 3000;
const NOTES_DIR = path.resolve(process.env.NOTES_DIR || path.join(__dirname, 'onenotes'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const AUTO_COMMIT = process.env.AUTO_COMMIT === '1' || process.env.AUTO_PUSH === '1';
const AUTO_PUSH = process.env.AUTO_PUSH === '1';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 95); // GitHub rejects files over 100 MB

const store = new Store(NOTES_DIR);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/notes', express.static(NOTES_DIR, { dotfiles: 'deny' }));

// ---------- public API ----------

app.get('/api/stats', (req, res) => res.json(store.stats()));
app.get('/api/suggest', (req, res) => res.json(store.suggest(String(req.query.q || ''))));
app.get('/api/search', (req, res) => res.json(store.search(String(req.query.q || ''))));
app.get('/api/section', (req, res) => {
  const s = store.sections.get(String(req.query.id || ''));
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ id: s.id, title: s.title, file: s.file, html: s.html });
});

// ---------- admin API ----------

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const given = Buffer.from(String(req.get('x-admin-password') || ''));
  const want = Buffer.from(ADMIN_PASSWORD);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.status(401).json({ error: 'Admin password required' });
}

const cleanName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();

// Resolve a client-supplied relative path and make sure it stays inside the notes folder.
function safeRel(rel) {
  const abs = path.resolve(NOTES_DIR, String(rel || ''));
  if (abs === NOTES_DIR || !abs.startsWith(NOTES_DIR + path.sep)) return null;
  return path.relative(NOTES_DIR, abs).split(path.sep).join('/');
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: __dirname }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + stderr).trim() }));
  });
}

// Optionally record changes to the notes folder in git (AUTO_COMMIT=1 / AUTO_PUSH=1).
async function gitSync(message) {
  if (!AUTO_COMMIT) return null;
  await git(['add', '-A', '--', NOTES_DIR]);
  const commit = await git(['commit', '-m', message, '--', NOTES_DIR]);
  if (!commit.ok) return /nothing to commit|no changes added/i.test(commit.out) ? 'No changes to commit.' : `Git commit failed: ${commit.out}`;
  if (!AUTO_PUSH) return 'Committed to git (not pushed).';
  const push = await git(['push']);
  return push.ok ? 'Committed and pushed to git.' : `Committed, but git push failed: ${push.out}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, fs.mkdtempSync(path.join(require('os').tmpdir(), 'kb-upload-'))),
    filename: (req, file, cb) => cb(null, 'upload'),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/files', (req, res) =>
  res.json({ files: store.fileList(), stats: store.stats(), supported: SUPPORTED, notesDir: path.relative(__dirname, NOTES_DIR) || '.', git: AUTO_PUSH ? 'push' : AUTO_COMMIT ? 'commit' : 'off' })
);

admin.post('/upload', upload.array('files'), async (req, res) => {
  const folder = String(req.body.folder || '').split(/[\\/]/).map(cleanName).filter(Boolean).join('/');
  const saved = [];
  const rejected = [];
  for (const f of req.files || []) {
    // multer hands us the name as latin1; browsers send UTF-8.
    const name = cleanName(path.basename(Buffer.from(f.originalname, 'latin1').toString('utf8')));
    const rel = safeRel(folder ? `${folder}/${name}` : name);
    if (!name || !rel || !SUPPORTED.includes(path.extname(name).toLowerCase())) {
      rejected.push({ name: f.originalname, reason: `Unsupported file type. Use: ${SUPPORTED.join(', ')}` });
    } else {
      const dest = path.join(NOTES_DIR, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.path, dest);
      saved.push(rel);
    }
    fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
  }
  await store.refresh(saved);
  const gitStatus = saved.length ? await gitSync(`Add/update notes: ${saved.join(', ')}`.slice(0, 200)) : null;
  res.json({
    saved: saved.map((rel) => store.fileList().find((f) => f.path === rel)),
    rejected,
    git: gitStatus,
    stats: store.stats(),
  });
});

admin.delete('/files', async (req, res) => {
  const rel = safeRel(req.query.path);
  if (!rel || !store.files.has(rel)) return res.status(404).json({ error: 'File not found' });
  fs.rmSync(path.join(NOTES_DIR, rel));
  await store.refresh();
  res.json({ deleted: rel, git: await gitSync(`Remove note: ${rel}`), stats: store.stats() });
});

admin.post('/reindex', async (req, res) => {
  store.files.clear();
  await store.refresh();
  res.json({ stats: store.stats() });
});

app.use('/api/admin', admin);

app.use((err, req, res, next) => {
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 500).json({ error: tooBig ? `File is larger than the ${MAX_UPLOAD_MB} MB limit.` : err.message });
});

store.refresh().then(() => {
  const s = store.stats();
  app.listen(PORT, () => {
    console.log(`Knowledge hub running at http://localhost:${PORT}  (admin: /admin)`);
    console.log(`Indexed ${s.sections} knowledge entries from ${s.files} file(s) in ${NOTES_DIR}`);
    if (!ADMIN_PASSWORD) console.log('Note: ADMIN_PASSWORD is not set, so the admin page is open to anyone who can reach this server.');
  });
});
