'use strict';
// In-memory knowledge index built from the files in the notes folder.

const fs = require('fs');
const path = require('path');
const MiniSearch = require('minisearch');
const { parseFile, SUPPORTED } = require('./parsers');
const Core = require('./search-core');

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
    const index = Core.newIndex(MiniSearch);
    for (const file of this.files.values()) {
      for (const s of file.sections) {
        this.sections.set(s.id, s);
        Core.addSection(index, s);
      }
    }
    this.index = index;
    this.indexedAt = new Date().toISOString();
  }

  search(query, limit = 30) {
    if (!this.index) return { total: 0, results: [] };
    const { total, mode, hits } = Core.search(this.index, query, limit);
    const results = hits.map((hit) => {
      const s = this.sections.get(hit.id);
      return {
        id: s.id,
        title: s.title,
        titleHtml: Core.highlight(s.title, hit.terms),
        file: s.file,
        snippet: Core.snippet(s.text, hit.terms),
        score: Math.round(hit.score * 100) / 100,
      };
    });
    return { total, mode, results };
  }

  suggest(query) {
    return this.index ? Core.suggest(this.index, query) : { queries: [], topics: [] };
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
