'use strict';

const $ = (id) => document.getElementById(id);
let password = '';
try { password = sessionStorage.getItem('adminPassword') || ''; } catch {}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), 'x-admin-password': password } });
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  if (res.status === 401) {
    showLogin(password ? 'Wrong password.' : '');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showLogin(message) {
  $('login').hidden = false;
  $('content').hidden = true;
  $('summary').textContent = 'Enter the admin password to manage notes.';
  $('loginMsg').replaceChildren(...(message ? [el('div', { className: 'err', textContent: message })] : []));
  $('password').focus();
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  password = $('password').value;
  try { sessionStorage.setItem('adminPassword', password); } catch {}
  load();
});

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function load() {
  let data;
  try {
    data = await api('/api/admin/files');
  } catch (err) {
    if (err.message !== 'unauthorized') $('summary').textContent = err.message;
    return;
  }
  $('login').hidden = true;
  $('content').hidden = false;
  const gitNote = { off: 'Commit and push that folder to keep them in your repo.', commit: 'Changes are committed to git automatically.', push: 'Changes are committed and pushed to git automatically.' }[data.git];
  $('summary').textContent = `${data.stats.files} file(s), ${data.stats.sections} searchable entries. Files are stored in the “${data.notesDir}” folder. ${gitNote}`;
  $('formats').textContent = `Supported: ${data.supported.join(' ')} — for OneNote, File → Export → Word (.docx) gives the best results.`;
  $('fileInput').accept = data.supported.join(',');

  const rows = $('fileRows');
  rows.replaceChildren();
  if (!data.files.length) {
    rows.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'No notes yet. Upload your first file above.' })));
  }
  for (const f of data.files) {
    const name = el('td', { className: 'name' }, el('a', { href: '/notes/' + f.path.split('/').map(encodeURIComponent).join('/'), textContent: f.path, target: '_blank' }));
    if (f.error || f.warning) name.append(el('div', { className: 'note', textContent: f.error || f.warning }));
    const del = el('button', { className: 'btn small danger', type: 'button', textContent: 'Delete' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete “${f.path}” from the notes folder?`)) return;
      del.disabled = true;
      try {
        const out = await api('/api/admin/files?path=' + encodeURIComponent(f.path), { method: 'DELETE' });
        report([{ cls: 'ok', text: `Deleted ${out.deleted}.` + (out.git ? ` ${out.git}` : '') }]);
      } catch (err) {
        report([{ cls: 'err', text: err.message }]);
      }
      load();
    });
    rows.append(
      el('tr', {}, [
        name,
        el('td', { className: 'num', textContent: f.sections }),
        el('td', { className: 'num', textContent: fmtSize(f.size) }),
        el('td', { className: 'num', textContent: new Date(f.modified).toLocaleDateString() }),
        el('td', { className: 'num' }, del),
      ])
    );
  }
}

function report(lines) {
  $('uploadMsg').replaceChildren(...lines.map((l) => el('div', { className: l.cls, textContent: l.text })));
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const body = new FormData();
  body.append('folder', $('folder').value); // must come before the files
  for (const f of files) body.append('files', f);
  report([{ cls: 'ok', text: `Uploading and indexing ${files.length} file(s)…` }]);
  try {
    const out = await api('/api/admin/upload', { method: 'POST', body });
    const lines = [];
    for (const f of out.saved) {
      if (f.error) lines.push({ cls: 'err', text: `${f.path}: saved, but ${f.error}` });
      else if (f.warning) lines.push({ cls: 'warn', text: `${f.path}: ${f.sections} entries indexed. ${f.warning}` });
      else lines.push({ cls: 'ok', text: `${f.path}: ${f.sections} entries indexed.` });
    }
    for (const r of out.rejected) lines.push({ cls: 'err', text: `${r.name}: not saved. ${r.reason}` });
    if (out.git) lines.push({ cls: /failed/i.test(out.git) ? 'err' : 'ok', text: out.git });
    report(lines);
  } catch (err) {
    if (err.message !== 'unauthorized') report([{ cls: 'err', text: `Upload failed: ${err.message}` }]);
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
  $('reindex').disabled = true;
  try {
    const out = await api('/api/admin/reindex', { method: 'POST' });
    report([{ cls: 'ok', text: `Re-indexed: ${out.stats.sections} entries from ${out.stats.files} file(s).` }]);
  } catch (err) {
    if (err.message !== 'unauthorized') report([{ cls: 'err', text: err.message }]);
  }
  $('reindex').disabled = false;
  load();
});

load();
