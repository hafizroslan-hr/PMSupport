'use strict';

const $ = (id) => document.getElementById(id);
const input = $('q');
const suggestBox = $('suggest');
const resultsEl = $('results');
const hintEl = $('hint');

let items = []; // current suggestions
let active = -1;
let suggestSeq = 0;
let debounce;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

// ---------- autocomplete ----------

function closeSuggest() {
  suggestBox.hidden = true;
  active = -1;
}

function renderSuggest() {
  suggestBox.replaceChildren();
  items.forEach((item, i) => {
    const li = el('li', { role: 'option', className: i === active ? 'active' : '' }, [
      el('span', { className: 'kind', textContent: item.type === 'topic' ? 'Topic' : 'Search' }),
      el('span', { className: 'label', textContent: item.label }),
    ]);
    if (item.file) li.append(el('span', { className: 'from', textContent: item.file }));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      choose(item);
    });
    suggestBox.append(li);
  });
  suggestBox.hidden = !items.length;
}

async function loadSuggest() {
  const q = input.value.trim();
  const seq = ++suggestSeq;
  if (!q) {
    items = [];
    return closeSuggest();
  }
  let data;
  try {
    data = await Engine.suggest(q);
  } catch {
    return;
  }
  if (seq !== suggestSeq) return; // a newer keystroke won
  items = [
    ...data.queries.map((s) => ({ type: 'query', label: s })),
    ...data.topics.map((t) => ({ type: 'topic', label: t.title, file: t.file, id: t.id })),
  ];
  active = -1;
  renderSuggest();
}

function choose(item) {
  input.value = item.label;
  runSearch(item.label, item.type === 'topic' ? item.id : null);
}

input.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(loadSuggest, 120);
});
input.addEventListener('focus', () => {
  if (items.length) suggestBox.hidden = false;
});
input.addEventListener('blur', closeSuggest);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeSuggest();
  if (suggestBox.hidden || !items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = items.length + 1; // extra slot = "nothing selected"
    active = ((active + 1 + (e.key === 'ArrowDown' ? 1 : n - 1)) % n) - 1;
    renderSuggest();
  } else if (e.key === 'Enter' && active >= 0) {
    e.preventDefault();
    choose(items[active]);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// ---------- search ----------

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(input.value);
});

async function runSearch(query, openId, push = true) {
  query = query.trim();
  clearTimeout(debounce);
  suggestSeq++;
  closeSuggest();
  if (push) history.pushState(null, '', query ? '?q=' + encodeURIComponent(query) : location.pathname);
  document.body.classList.toggle('searched', !!query);
  resultsEl.replaceChildren();
  hintEl.hidden = !query;
  if (!query) return;
  hintEl.textContent = 'Searching…';
  let data;
  try {
    data = await Engine.search(query);
  } catch {
    hintEl.textContent = 'Search failed. Reload the page and try again.';
    return;
  }
  if (!data.results.length) {
    hintEl.hidden = true;
    resultsEl.append(
      el('li', { className: 'empty' }, [
        el('p', { textContent: `Nothing found for “${query}”.` }),
        el('p', { textContent: 'Try fewer or different words, or upload the note that covers it from Manage notes.' }),
      ])
    );
    return;
  }
  const shown = data.results.length;
  hintEl.textContent =
    (data.total > shown ? `Top ${shown} of ${data.total} entries` : `${shown} ${shown === 1 ? 'entry' : 'entries'}`) +
    (data.mode === 'any' ? ' — no entry has all your words, showing partial matches' : '');
  for (const r of data.results) resultsEl.append(resultCard(r, r.id === openId));
  if (openId) {
    const open = resultsEl.querySelector('.result.open');
    if (open) resultsEl.prepend(open);
  }
}

function resultCard(r, open) {
  const li = el('li', { className: 'result' });
  const head = el('button', { type: 'button' });
  head.setAttribute('aria-expanded', 'false');
  const h2 = el('h2');
  h2.innerHTML = r.titleHtml; // escaped + highlighted by the server
  const snippet = el('p', { className: 'snippet' });
  snippet.innerHTML = r.snippet; // escaped + highlighted by the server
  head.append(h2, el('div', { className: 'source', textContent: r.file }), snippet);
  li.append(head);

  let detail = null;
  async function toggle() {
    if (detail) {
      detail.hidden = !detail.hidden;
    } else {
      detail = el('div', { className: 'detail', textContent: 'Loading…' });
      li.append(detail);
      try {
        const s = await Engine.section(r.id);
        detail.innerHTML = s.html; // sanitized by the server at index time
        const link = el('a', { href: 'notes/' + s.file.split('/').map(encodeURIComponent).join('/'), textContent: s.file, target: '_blank' });
        detail.append(el('div', { className: 'foot' }, ['Source: ', link]));
      } catch {
        detail.textContent = 'Could not load this entry.';
      }
    }
    const isOpen = !detail.hidden;
    li.classList.toggle('open', isOpen);
    snippet.hidden = isOpen;
    head.setAttribute('aria-expanded', String(isOpen));
  }
  head.addEventListener('click', toggle);
  if (open) {
    li.classList.add('open');
    toggle();
  }
  return li;
}

// ---------- startup ----------

function fromUrl() {
  const q = new URLSearchParams(location.search).get('q') || '';
  input.value = q;
  runSearch(q, null, false);
}
window.addEventListener('popstate', fromUrl);
fromUrl();

Engine.stats().then((s) => {
  $('stats').textContent = s.sections
    ? `Search ${s.sections} knowledge ${s.sections === 1 ? 'entry' : 'entries'} from ${s.files} ${s.files === 1 ? 'note file' : 'note files'}`
    : 'No notes loaded yet — add some from Manage notes';
}).catch(() => {});
