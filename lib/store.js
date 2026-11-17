'use strict';
// In-memory knowledge index built from the files in the notes folder.

const fs = require('fs');
const path = require('path');
const MiniSearch = require('minisearch');
const { parseFile, SUPPORTED, escapeHtml } = require('./parsers');

class Store {
  constructor(notesDir) {
    this.notesDir = notesDir;
    this.files = new Map(); // relative path -> { path, size, modified, sections: [], warning, error }
    this.sections = new Map(); // id -> section
    this.index = null;
    this.indexedAt = null;
  }

  listNoteFiles(dir = this.notesDir, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...this.listNoteFiles(path.join(dir, entry.name), rel));
      else if (SUPPORTED.includes(path.extname(entry.name).toLowerCase())) out.push(rel);
    }
    return out;
  }

  async loadFile(rel) {
    const abs = path.join(this.notesDir, rel);
    const stat = fs.statSync(abs);
    const record = { path: rel, size: stat.size, modified: stat.mtime.toISOString(), sections: [], warning: null, error: null };
    try {
      const { sections, warning } = await parseFile(abs);
      record.warning = warning;
      record.sections = sections.map((s, i) => ({ ...s, id: `${rel}#${i}`, file: rel }));
    } catch (err) {
      record.error = `Could not read this file: ${err.message}`;
    }
    this.files.set(rel, record);
    return record;
  }

  // Re-read the folder. Only files in `only` (or all, when omitted) are re-parsed.
  async refresh(only) {
    fs.mkdirSync(this.notesDir, { recursive: true });
    const onDisk = this.listNoteFiles();
    for (const rel of [...this.files.keys()]) if (!onDisk.includes(rel)) this.files.delete(rel);
    for (const rel of onDisk) {
      if (!only || only.includes(rel) || !this.files.has(rel)) await this.loadFile(rel);
    }
    this.rebuildIndex();
  }

  rebuildIndex() {
    this.sections = new Map();
    const index = new MiniSearch({
      fields: ['title', 'text', 'file'],
      searchOptions: { boost: { title: 3, file: 1.5 }, prefix: true, fuzzy: 0.2 },
    });
    for (const file of this.files.values()) {
      for (const s of file.sections) {
        this.sections.set(s.id, s);
        index.add({ id: s.id, title: s.title, text: s.text, file: s.file.replace(/\.[^.]+$/, '') });
      }
    }
    this.index = index;
    this.indexedAt = new Date().toISOString();
  }

  snippet(text, terms) {
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
    return this.highlight(piece.replace(/\n+/g, ' · '), terms);
  }

  highlight(text, terms) {
    const safe = escapeHtml(text);
    const usable = terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!usable.length) return safe;
    usable.sort((a, b) => b.length - a.length);
    return safe.replace(new RegExp(`(${usable.join('|')})`, 'gi'), '<mark>$1</mark>');
  }

  search(query, limit = 30) {
    query = query.trim();
    if (!query || !this.index) return { total: 0, results: [] };
    let hits = this.index.search(query, { combineWith: 'AND' });
    let mode = 'all';
    if (!hits.length) {
      hits = this.index.search(query, { combineWith: 'OR' });
      mode = 'any';
    }
    const results = hits.slice(0, limit).map((hit) => {
      const s = this.sections.get(hit.id);
      return {
        id: s.id,
        title: s.title,
        titleHtml: this.highlight(s.title, hit.terms),
        file: s.file,
        snippet: this.snippet(s.text, hit.terms),
        score: Math.round(hit.score * 100) / 100,
      };
    });
    return { total: hits.length, mode, results };
  }

  suggest(query) {
    query = query.trim();
    if (!query || !this.index) return { queries: [], topics: [] };
    // Complete the word being typed with words that actually occur in the notes,
    // restricted to entries that also match the words before it.
    const words = query.toLowerCase().split(/\s+/);
    const last = words.pop();
    const lead = words.join(' ');
    const scores = new Map();
    for (const hit of this.index.search(query, { fuzzy: 0.2, prefix: true, combineWith: 'AND' })) {
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
    for (const hit of this.index.search(query, { fields: ['title'], combineWith: 'AND', fuzzy: 0.2, prefix: true })) {
      const s = this.sections.get(hit.id);
      const key = s.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push({ id: s.id, title: s.title, file: s.file });
      if (topics.length >= 5) break;
    }
    return { queries, topics };
  }

  stats() {
    return { files: this.files.size, sections: this.sections.size, indexedAt: this.indexedAt };
  }

  fileList() {
    return [...this.files.values()]
      .map((f) => ({ path: f.path, size: f.size, modified: f.modified, sections: f.sections.length, warning: f.warning, error: f.error }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = { Store };
