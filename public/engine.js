'use strict';
// Data source for the search page. On GitHub Pages (static site) the search runs
// in the browser against data/index.json; with the Node server it calls /api.

const Engine = (() => {
  let booting;

  const getJson = (url) => fetch(url).then((r) => r.json());
  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.append(s);
    });

  async function boot() {
    let manifest = null;
    try {
      const res = await fetch('data/manifest.json', { cache: 'no-cache' });
      if (res.ok) manifest = await res.json();
    } catch {}
    if (!manifest) return { mode: 'server' };
    await Promise.all([loadScript('vendor/minisearch.js'), loadScript('search-core.js')]);
    const v = '?v=' + manifest.version;
    const text = await fetch('data/index.json' + v).then((r) => r.text());
    return {
      mode: 'static',
      manifest,
      v,
      index: SearchCore.loadIndex(MiniSearch, text),
      fids: new Map(manifest.files.map((f) => [f.path, f.fid])),
      loaded: new Map(), // fid -> Promise of Map(sectionId -> section)
    };
  }

  const ready = () => (booting ||= boot());

  function loadFile(ctx, fid) {
    if (!ctx.loaded.has(fid)) {
      ctx.loaded.set(
        fid,
        getJson(`data/files/${fid}.json${ctx.v}`).then((d) => new Map(d.sections.map((s) => [s.id, s])))
      );
    }
    return ctx.loaded.get(fid);
  }

  async function sectionOf(ctx, id) {
    const sections = await loadFile(ctx, ctx.fids.get(SearchCore.fileOf(id)));
    return sections.get(id);
  }

  return {
    async stats() {
      const ctx = await ready();
      return ctx.mode === 'static' ? ctx.manifest.stats : getJson('api/stats');
    },

    async suggest(q) {
      const ctx = await ready();
      return ctx.mode === 'static' ? SearchCore.suggest(ctx.index, q) : getJson('api/suggest?q=' + encodeURIComponent(q));
    },

    async search(q) {
      const ctx = await ready();
      if (ctx.mode !== 'static') return getJson('api/search?q=' + encodeURIComponent(q));
      const { total, mode, hits } = SearchCore.search(ctx.index, q, 30);
      const results = await Promise.all(
        hits.map(async (hit) => {
          const s = await sectionOf(ctx, hit.id);
          return {
            id: hit.id,
            title: s.title,
            titleHtml: SearchCore.highlight(s.title, hit.terms),
            file: SearchCore.fileOf(hit.id),
            snippet: SearchCore.snippet(s.text, hit.terms),
          };
        })
      );
      return { total, mode, results };
    },

    async section(id) {
      const ctx = await ready();
      if (ctx.mode !== 'static') return getJson('api/section?id=' + encodeURIComponent(id));
      const s = await sectionOf(ctx, id);
      return { id, title: s.title, file: SearchCore.fileOf(id), html: s.html };
    },
  };
})();
