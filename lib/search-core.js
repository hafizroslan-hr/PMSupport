'use strict';
// Search logic shared by the Node server and the static (GitHub Pages) site.
// Works in Node (require) and in the browser (window.SearchCore).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SearchCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const OPTIONS = {
    fields: ['title', 'text', 'fileName'],
    storeFields: ['title'],
    searchOptions: { boost: { title: 3, fileName: 1.5 }, prefix: true, fuzzy: 0.2 },
  };

  const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Section ids look like "folder/file.docx#3".
  const fileOf = (id) => id.slice(0, id.lastIndexOf('#'));

  function newIndex(MiniSearch) {
    return new MiniSearch(OPTIONS);
  }

  function loadIndex(MiniSearch, json) {
    return MiniSearch.loadJSON(json, OPTIONS);
  }

  function addSection(index, s) {
    index.add({ id: s.id, title: s.title, text: s.text, fileName: s.file.replace(/\.[^.]+$/, '') });
  }

  function highlight(text, terms) {
    const safe = escapeHtml(text);
    const usable = terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!usable.length) return safe;
    usable.sort((a, b) => b.length - a.length);
    return safe.replace(new RegExp(`(${usable.join('|')})`, 'gi'), '<mark>$1</mark>');
  }

  function snippet(text, terms) {
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) {
      const i = lower.indexOf(t.toLowerCase());
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    let start = Math.max(0, (at < 0 ? 0 : at) - 90);
    if (start > 0) {
      const sp = text.indexOf(' ', start);
      if (sp >= 0 && sp < start + 30) start = sp + 1;
    }
    let piece = text.slice(start, start + 300);
    if (start + 300 < text.length) piece = piece.replace(/\s+\S*$/, '') + ' …';
    if (start > 0) piece = '… ' + piece;
    return highlight(piece.replace(/\n+/g, ' · '), terms);
  }

  // All words first; if nothing has them all, fall back to entries matching any word.
  function search(index, query, limit = 30) {
    query = query.trim();
    if (!query) return { total: 0, mode: 'all', hits: [] };
    let hits = index.search(query, { combineWith: 'AND' });
    let mode = 'all';
    if (!hits.length) {
      hits = index.search(query, { combineWith: 'OR' });
      mode = 'any';
    }
    return { total: hits.length, mode, hits: hits.slice(0, limit) };
  }

  // Complete the word being typed with words that really occur in the notes,
  // restricted to entries that also match the words before it, plus matching topic titles.
  function suggest(index, query) {
    query = query.trim();
    if (!query) return { queries: [], topics: [] };
    const words = query.toLowerCase().split(/\s+/);
    const last = words.pop();
    const lead = words.join(' ');
    const scores = new Map();
    for (const hit of index.search(query, { fuzzy: 0.2, prefix: true, combineWith: 'AND' })) {
      let candidates = hit.terms.filter((t) => t.startsWith(last));
      if (!candidates.length) candidates = hit.terms.filter((t) => !words.some((w) => t.startsWith(w))); // typo in last word
      for (const t of candidates) scores.set(t, (scores.get(t) || 0) + hit.score);
    }
    const queries = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => (lead ? `${lead} ${term}` : term))
      .filter((s) => s !== query.toLowerCase())
      .slice(0, 5);
    const seen = new Set();
    const topics = [];
    for (const hit of index.search(query, { fields: ['title'], combineWith: 'AND', fuzzy: 0.2, prefix: true })) {
      const key = hit.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push({ id: hit.id, title: hit.title, file: fileOf(hit.id) });
      if (topics.length >= 5) break;
    }
    return { queries, topics };
  }

  return { OPTIONS, escapeHtml, fileOf, newIndex, loadIndex, addSection, highlight, snippet, search, suggest };
});
