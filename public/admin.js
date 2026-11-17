'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

const keep = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const cleanName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const noteHref = (p) => 'notes/' + encPath(p);

class AuthError extends Error {}

// ---------- backend 1: the Node server (npm start) ----------

function serverBackend() {
  let password = keep.get('adminPassword');
  const api = async (url, options = {}) => {
    const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), 'x-admin-password': password } });
    const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
    if (res.status === 401) throw new AuthError(password ? 'Wrong password.' : '');
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };
  return {
    kind: 'server',
    setPassword(p) { password = p; keep.set('adminPassword', p); },
    async list() {
      const d = await api('api/admin/files');
      const gitNote = { off: 'Commit and push that folder to keep them in your repo.', commit: 'Changes are committed to git automatically.', push: 'Changes are committed and pushed to git automatically.' }[d.git];
      return {
        files: d.files,
        supported: d.supported,
        summary: `${d.stats.files} file(s), ${d.stats.sections} searchable entries. Files are stored in the “${d.notesDir}” folder. ${gitNote}`,
      };
    },
    async upload(files, folder) {
      const body = new FormData();
      body.append('folder', folder); // must come before the files
      for (const f of files) body.append('files', f);
      const out = await api('api/admin/upload', { method: 'POST', body });
      return {
        saved: out.saved.map((f) => ({ path: f.path, sections: f.sections, warning: f.warning, error: f.error })),
        rejected: out.rejected,
        note: out.git,
      };
    },
    async remove(path) {
      const out = await api('api/admin/files?path=' + encodeURIComponent(path), { method: 'DELETE' });
      return out.git || '';
    },
  };
}

// ---------- backend 2: GitHub Pages site, writing to the repo via the GitHub API ----------

function githubBackend(manifest) {
  const state = { repo: keep.get('ghRepo') || manifest.repo || '', token: keep.get('ghToken'), branch: '' };
  const notesDir = manifest.notesDir || 'onenotes';

  const gh = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch('https://api.github.com' + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + state.token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (res.status === 401) throw new AuthError('GitHub rejected the token. Create a new one and reconnect.');
    if (!res.ok) {
      const err = new Error(data.message || `GitHub error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
  const contents = (path) => `/repos/${state.repo}/contents/${encPath(path)}`;
  const currentSha = async (path) => {
    try {
      return (await gh(`${contents(path)}?ref=${encodeURIComponent(state.branch)}`)).sha;
    } catch (err) {
      if (err.status === 404) return undefined;
      throw err;
    }
  };
  const toBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read the file'));
      r.readAsDataURL(file);
    });

  return {
    kind: 'github',
    state,
    manifest,
    async connect(repo, token) {
      state.repo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
      state.token = token.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(state.repo)) throw new Error('Enter the repository as owner/name.');
      let info;
      try {
        info = await gh(`/repos/${state.repo}`);
      } catch (err) {
        if (err.status === 404) throw new Error('Repository not found, or the token has no access to it.');
        throw err;
      }
      if (!info.permissions || !info.permissions.push) throw new Error('This token can only read the repository. Give it Contents: Read and write.');
      state.branch = info.default_branch;
      keep.set('ghRepo', state.repo);
      keep.set('ghToken', state.token);
    },
    async resume() {
      if (!state.token || !state.repo) throw new AuthError('');
      await this.connect(state.repo, state.token);
    },
    disconnect() {
      keep.del('ghToken');
      state.token = '';
    },
    async list() {
      let tree = [];
      try {
        const data = await gh(`/repos/${state.repo}/git/trees/${encodeURIComponent(state.branch)}?recursive=1`);
        tree = data.tree || [];
      } catch (err) {
        if (err.status !== 404 && err.status !== 409) throw err; // empty repo
      }
      const live = new Map(manifest.files.map((f) => [f.path, f]));
      const prefix = notesDir + '/';
      const supported = new Set(manifest.supported);
      const files = tree
        .filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && supported.has(t.path.slice(t.path.lastIndexOf('.')).toLowerCase()))
        .map((t) => {
          const path = t.path.slice(prefix.length);
          const built = live.get(path);
          const isLive = built && built.size === t.size;
          return { path, size: t.size, sections: isLive ? built.sections : null, warning: isLive ? built.warning : null, error: isLive ? built.error : null, status: isLive ? 'Live' : 'Publishing…' };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      const pending = files.filter((f) => f.status !== 'Live').length;
      return {
        files,
        supported: manifest.supported,
        summary: `Connected to ${state.repo} (${state.branch}). ${files.length} file(s) in “${notesDir}”.` + (pending ? ` ${pending} not on the site yet: the site rebuilds in a minute or two after each change, then reload this page.` : ''),
      };
    },
    async upload(files, folder) {
      const dir = folder.split(/[\\/]/).map(cleanName).filter((s) => s && s !== '..').join('/');
      const saved = [];
      const rejected = [];
      const supported = new Set(manifest.supported);
      for (const f of files) {
        const name = cleanName(f.name);
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
        if (!name || !supported.has(ext)) {
          rejected.push({ name: f.name, reason: `Unsupported file type. Use: ${manifest.supported.join(', ')}` });
          continue;
        }
        if (f.size > 95 * 1024 * 1024) {
          rejected.push({ name: f.name, reason: 'Larger than 95 MB, which GitHub does not accept.' });
          continue;
        }
        const rel = dir ? `${dir}/${name}` : name;
        const repoPath = `${notesDir}/${rel}`;
        const content = await toBase64(f);
        const sha = await currentSha(repoPath); // sequential on purpose: parallel commits to one branch conflict
        await gh(contents(repoPath), { method: 'PUT', body: { message: `Add/update note: ${rel}`, content, branch: state.branch, ...(sha ? { sha } : {}) } });
        saved.push({ path: rel, sections: null, status: 'Publishing…' });
      }
      return { saved, rejected, note: saved.length ? 'Saved to your repo. The site rebuilds in a minute or two; reload this page afterwards to see the entries indexed.' : '' };
    },
    async remove(path) {
      const repoPath = `${notesDir}/${path}`;
      const sha = await currentSha(repoPath);
      if (!sha) throw new Error('File not found in the repo.');
      await gh(contents(repoPath), { method: 'DELETE', body: { message: `Remove note: ${path}`, sha, branch: state.branch } });
      return 'Removed from your repo. The site rebuilds in a minute or two.';
    },
  };
}

// ---------- page ----------

let backend;

function report(lines) {
  $('uploadMsg').replaceChildren(...lines.map((l) => el('div', { className: l.cls, textContent: l.text })));
}

function show(which) {
  $('login').hidden = which !== 'login';
  $('connect').hidden = which !== 'connect';
  $('content').hidden = which !== 'content';
}

async function load() {
  let data;
  try {
    data = await backend.list();
  } catch (err) {
    if (err instanceof AuthError) return needAuth(err.message);
    $('summary').textContent = err.message;
    return;
  }
  show('content');
  $('summary').textContent = data.summary;
  $('formats').textContent = `Supported: ${data.supported.join(' ')} — for OneNote, File → Export → Word (.docx) gives the best results.`;
  $('fileInput').accept = data.supported.join(',');

  const rows = $('fileRows');
  rows.replaceChildren();
  if (!data.files.length) {
    rows.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'No notes yet. Upload your first file above.' })));
  }
  for (const f of data.files) {
    const name = el('td', { className: 'name' }, el('a', { href: noteHref(f.path), textContent: f.path, target: '_blank' }));
    if (f.error || f.warning) name.append(el('div', { className: 'note', textContent: f.error || f.warning }));
    const del = el('button', { className: 'btn small danger', type: 'button', textContent: 'Delete' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete “${f.path}” from the notes folder?`)) return;
      del.disabled = true;
      try {
        const note = await backend.remove(f.path);
        report([{ cls: 'ok', text: `Deleted ${f.path}. ${note}`.trim() }]);
      } catch (err) {
        if (err instanceof AuthError) return needAuth(err.message);
        report([{ cls: 'err', text: err.message }]);
      }
      load();
    });
    rows.append(
      el('tr', {}, [
        name,
        el('td', { className: 'num' + (f.sections == null ? ' na' : ''), textContent: f.sections == null ? '–' : f.sections }),
        el('td', { className: 'num', textContent: fmtSize(f.size) }),
        el('td', { className: 'num', textContent: f.status || new Date(f.modified).toLocaleDateString() }),
        el('td', { className: 'num' }, del),
      ])
    );
  }
  if (backend.kind === 'github') {
    const out = el('button', { className: 'btn small secondary', type: 'button', textContent: 'Disconnect this device' });
    out.addEventListener('click', () => { backend.disconnect(); needAuth(''); });
    $('summary').append(' ', out);
  }
}

function needAuth(message) {
  if (backend.kind === 'github') {
    show('connect');
    $('summary').textContent = 'Connect this device to your repository to manage notes.';
    $('repo').value = backend.state.repo;
    $('connectMsg').replaceChildren(...(message ? [el('div', { className: 'err', textContent: message })] : []));
    $('token').focus();
  } else {
    show('login');
    $('summary').textContent = 'Enter the admin password to manage notes.';
    $('loginMsg').replaceChildren(...(message ? [el('div', { className: 'err', textContent: message })] : []));
    $('password').focus();
  }
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  backend.setPassword($('password').value);
  load();
});

$('connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('connectMsg').replaceChildren(el('div', { className: 'ok', textContent: 'Checking…' }));
  try {
    await backend.connect($('repo').value, $('token').value);
    $('token').value = '';
    load();
  } catch (err) {
    $('connectMsg').replaceChildren(el('div', { className: 'err', textContent: err.message }));
  }
});

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  report([{ cls: 'ok', text: `Uploading ${files.length} file(s)…` }]);
  try {
    const out = await backend.upload(files, $('folder').value);
    const lines = [];
    for (const f of out.saved) {
      if (f.error) lines.push({ cls: 'err', text: `${f.path}: saved, but ${f.error}` });
      else if (f.warning) lines.push({ cls: 'warn', text: `${f.path}: ${f.sections} entries indexed. ${f.warning}` });
      else if (f.sections == null) lines.push({ cls: 'ok', text: `${f.path}: saved.` });
      else lines.push({ cls: 'ok', text: `${f.path}: ${f.sections} entries indexed.` });
    }
    for (const r of out.rejected) lines.push({ cls: 'err', text: `${r.name}: not saved. ${r.reason}` });
    if (out.note) lines.push({ cls: /failed/i.test(out.note) ? 'err' : 'ok', text: out.note });
    report(lines);
  } catch (err) {
    if (err instanceof AuthError) return needAuth(err.message);
    report([{ cls: 'err', text: `Upload failed: ${err.message}` }]);
  }
  $('fileInput').value = '';
  load();
}

const drop = $('drop');
$('pick').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => uploadFiles(e.target.files));
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

$('reindex').addEventListener('click', async () => {
  const btn = $('reindex');
  btn.disabled = true;
  try {
    if (backend.kind === 'server') {
      const res = await fetch('api/admin/reindex', { method: 'POST', headers: { 'x-admin-password': keep.get('adminPassword') } });
      const out = await res.json();
      report([{ cls: 'ok', text: `Re-indexed: ${out.stats.sections} entries from ${out.stats.files} file(s).` }]);
    } else {
      report([{ cls: 'ok', text: 'The site re-indexes itself whenever a note changes. To force a rebuild, run the “Deploy knowledge hub” workflow from the Actions tab of your repo.' }]);
    }
  } catch (err) {
    report([{ cls: 'err', text: err.message }]);
  }
  btn.disabled = false;
  load();
});

(async function start() {
  let manifest = null;
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (res.ok) manifest = await res.json();
  } catch {}
  if (manifest) {
    backend = githubBackend(manifest);
    $('reindex').hidden = true;
    try {
      await backend.resume();
    } catch (err) {
      return needAuth(err instanceof AuthError ? err.message : err.message);
    }
  } else {
    backend = serverBackend();
  }
  load();
})();
