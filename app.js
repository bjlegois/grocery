(function () {
  'use strict';

  const M = window.GroceryMath;
  const API_URL = (window.GROCERY_CONFIG || {}).API_URL || '';
  const K = { code: 'gp.code', codePrev: 'gp.codePrev', cache: 'gp.cache', queue: 'gp.queue', checked: 'gp.checked', view: 'gp.view', lastStore: 'gp.lastStore' };

  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const EMPTY = { meals: [], packages: [], week: [], extras: [], trip: [], stores: M.DEFAULT_STORES, updated: null };
  let state = Object.assign({}, EMPTY, ls.get(K.cache, {}));
  let queue = ls.get(K.queue, []);
  let checked = ls.get(K.checked, {});
  let view = ls.get(K.view, 'week');
  let sync = 'idle';
  let codeProblem = '';
  let editor = null;

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const same = (a, b) => M.normKey(a) === M.normKey(b);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const byName = (a, b) => a.name.localeCompare(b.name);
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '').slice(0, 8);

  /* ------------------------------------------------------ household code
   * The code is kept in two places: this browser's storage, and the page
   * address (#code=…). The address copy means a bookmark or Home Screen icon
   * carries the code, so a Private tab, another app's built-in browser or
   * cleared Safari data can't lock you out. Browsers never send the part after
   * # to the server, so the code doesn't reach GitHub.
   */
  const code = () => ls.get(K.code, '');

  function hashCode() {
    const m = location.hash.match(/[#&]code=([^&]+)/);
    try { return m ? decodeURIComponent(m[1]).trim() : ''; } catch (e) { return ''; }
  }

  function showCodeInAddress() {
    const c = code();
    const want = c ? '#code=' + encodeURIComponent(c) : '';
    if (location.hash !== want) history.replaceState(history.state, '', location.pathname + location.search + want);
  }

  function setCode(c) {
    const old = code();
    if (old && old !== c) ls.set(K.codePrev, old); // fallback if the new one gets refused
    ls.set(K.code, c);
    codeProblem = '';
    showCodeInAddress();
  }

  function takeSetupLink() {
    const c = hashCode();
    if (!c || c === code()) { showCodeInAddress(); return false; }
    setCode(c);
    return true;
  }
  takeSetupLink();
  // A link can also arrive while the app is already open (only the #hash changes).
  window.addEventListener('hashchange', () => { if (takeSetupLink()) { render(); refresh(); } });

  /* ----------------------------------------------------------------- api */

  // Body is sent as text/plain (fetch's default for a string), which is a
  // CORS "simple request": no preflight, which Apps Script can't answer.
  async function call(action, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: action, code: code() }, payload || {})),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('The spreadsheet sent back something unexpected.'); }
    if (!data.ok) {
      const err = new Error(data.message || 'Something went wrong.');
      err.server = true;
      err.code = data.error;
      throw err;
    }
    return data;
  }

  function adopt(data) {
    state = {
      meals: data.meals || [], packages: data.packages || [], week: data.week || [],
      extras: data.extras || [], trip: data.trip || [], stores: data.stores || M.DEFAULT_STORES,
      updated: data.updated || null,
    };
    saveCache();
    render();
  }

  function saveCache() { ls.set(K.cache, state); }

  // Writes go into a queue saved on the phone, so a change made in a store with
  // one bar of signal isn't lost: it syncs when the connection comes back.
  let flushing = null;

  function enqueue(action, payload) {
    if (action === 'setThisWeek') {
      const start = flushing ? 1 : 0; // queue[0] may already be on the wire
      queue = queue.filter((op, i) => i < start || op.action !== 'setThisWeek');
    }
    queue.push({ action: action, payload: payload });
    ls.set(K.queue, queue);
    flush();
  }

  function flush() {
    if (flushing) return flushing;
    if (!queue.length || !API_URL || !code()) return Promise.resolve();
    flushing = (async () => {
      setSync('saving');
      let last = null;
      let dropped = false;
      try {
        while (queue.length) {
          try {
            last = await call(queue[0].action, queue[0].payload);
          } catch (err) {
            if (err.server && err.code !== 'BAD_CODE' && err.code !== 'NOT_SET_UP') {
              dropped = true;
              toast(err.message);
            } else {
              throw err;
            }
          }
          queue.shift();
          ls.set(K.queue, queue);
        }
        if (dropped) last = await call('all');
        if (last) adopt(last);
        setSync('ok');
      } catch (err) {
        onError(err);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  async function refresh() {
    if (!API_URL || !code()) return;
    if (queue.length || flushing) return flush();
    setSync('loading');
    try {
      const data = await call('all');
      if (!queue.length && !flushing) adopt(data);
      setSync('ok');
    } catch (err) {
      onError(err);
    }
  }

  function onError(err) {
    if (err.server && err.code === 'BAD_CODE') {
      // An old bookmark can override a newer code. Fall back once to the code
      // this phone had before, then give up and ask.
      const prev = ls.get(K.codePrev, '');
      ls.del(K.codePrev);
      if (prev && prev !== code()) {
        ls.set(K.code, prev);
        showCodeInAddress();
        setSync('idle');
        setTimeout(refresh, 0); // after the current save attempt has finished
        return;
      }
      ls.del(K.code);
      showCodeInAddress();
      codeProblem = 'That code didn’t work. Check it and try again.';
      setSync('idle');
      render();
    } else if (err.server) {
      setSync('error');
      toast(err.message);
    } else {
      setSync(queue.length ? 'pending' : 'offline');
    }
  }

  const SYNC_TEXT = {
    idle: '', loading: 'Updating…', saving: 'Saving…', ok: 'Up to date',
    offline: 'No connection, showing saved copy', pending: 'No connection, changes will sync', error: 'Not connected',
  };
  function setSync(s) { sync = s; updateSync(); }
  function updateSync() {
    const el = $('#sync');
    el.textContent = SYNC_TEXT[sync] || '';
    el.dataset.state = sync;
  }

  /* --------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  /* ------------------------------------------------------------- helpers */

  function sortedMeals() { return state.meals.slice().sort(byName); }

  function ingSummary(m) {
    const names = (m.ingredients || []).map(i => i.name);
    if (!names.length) return 'No ingredients yet';
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
  }

  function weekCounts() {
    const out = {};
    state.week.forEach(w => { const k = M.normKey(w); out[k] = (out[k] || 0) + 1; });
    return out;
  }

  function stores() { return state.stores && state.stores.length ? state.stores : M.DEFAULT_STORES; }

  function storeOptions(selected, allowNone) {
    const list = stores().slice();
    if (selected && !list.some(s => s === selected)) list.push(selected);
    return (allowNone ? `<option value=""${selected ? '' : ' selected'}>No usual store</option>` : '') +
      list.map(s => `<option${s === selected ? ' selected' : ''}>${esc(s)}</option>`).join('');
  }

  function storeSlug(s) {
    const k = M.normKey(s);
    return k === 'aldi' ? 'aldi' : k === 'costco' ? 'costco' : k === "pick 'n save" ? 'pns' : k === 'target' ? 'target' : 'other';
  }

  function dataUnits() {
    const set = new Set();
    state.packages.forEach(p => p.unit && set.add(M.unitKey(p.unit)));
    state.meals.forEach(m => (m.ingredients || []).forEach(i => i.unit && set.add(M.unitKey(i.unit))));
    return set;
  }

  function unitOptions(selected) {
    const sel = M.unitKey(selected);
    const listed = new Set();
    const groups = M.UNIT_GROUPS.map(g => {
      const units = g.units.slice();
      if (g.label === 'Other') dataUnits().forEach(u => { if (!M.UNITS[u] && units.indexOf(u) < 0) units.push(u); });
      if (g.label === 'Other' && sel && !M.UNITS[sel] && units.indexOf(sel) < 0) units.push(sel);
      units.forEach(u => listed.add(u));
      return `<optgroup label="${g.label}">${units.map(u => `<option value="${esc(u)}"${u === sel ? ' selected' : ''}>${esc(u)}</option>`).join('')}</optgroup>`;
    });
    return groups.join('');
  }

  function knownIngredient(name) {
    const key = M.normKey(name);
    if (!key) return null;
    const pkg = state.packages.find(p => M.normKey(p.name) === key);
    let display = pkg ? pkg.name : null;
    let unit = pkg && pkg.unit ? M.unitKey(pkg.unit) : null;
    state.meals.forEach(m => (m.ingredients || []).forEach(i => {
      if (M.normKey(i.name) !== key) return;
      if (!display) display = i.name;
      if (!unit && i.unit) unit = M.unitKey(i.unit);
    }));
    return display ? { name: display, unit: unit, pkg: pkg || null } : null;
  }

  function refreshDatalist() {
    const seen = new Map();
    state.packages.forEach(p => p.name && seen.set(M.normKey(p.name), p.name));
    state.meals.forEach(m => (m.ingredients || []).forEach(i => { const k = M.normKey(i.name); if (k && !seen.has(k)) seen.set(k, i.name); }));
    $('#ing-list').innerHTML = Array.from(seen.values()).sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="${esc(n)}"></option>`).join('');
  }

  function qtyInput(q) { return q == null || q === '' ? '' : String(Math.round(Number(q) * 10000) / 10000); }

  /* -------------------------------------------------------------- render */

  function render() {
    renderTabs();
    renderMain();
    updateSync();
  }

  function renderTabs() {
    const tabs = $('#tabs');
    const ready = API_URL && code() && !codeProblem;
    tabs.hidden = !ready;
    if (!ready) return;
    const r = M.buildList(state);
    const left = r.groups.reduce((n, g) => n + g.lines.filter(l => !checked[l.key]).length, 0);
    $$('button', tabs).forEach(b => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('#list-badge').textContent = left ? left : '';
  }

  function renderMain() {
    const main = $('#main');
    const keep = {};
    $$('[data-keep]', main).forEach(el => { keep[el.id] = el.value; });
    const active = document.activeElement && main.contains(document.activeElement) ? document.activeElement.id : null;

    if (!API_URL) main.innerHTML = notConnectedView();
    else if (!code() || codeProblem) main.innerHTML = codeView();
    else main.innerHTML = view === 'list' ? listView() : view === 'meals' ? mealsView() : weekView();

    Object.keys(keep).forEach(id => { const el = document.getElementById(id); if (el && keep[id] != null) el.value = keep[id]; });
    if (active) { const el = document.getElementById(active); if (el) el.focus({ preventScroll: true }); }
  }

  function notConnectedView() {
    return `<section class="setup"><h1>Not connected yet</h1>
      <p>This app needs the address of the Grocery Planner spreadsheet’s web app. Add it to <code>config.js</code> and reload.</p></section>`;
  }

  function codeView() {
    return `<section class="setup"><h1>Connect this phone</h1>
      <p>Open the setup link from a phone that’s already connected, or type the household code.</p>
      <form class="stack" data-form="code" autocomplete="off">
        <input id="code-input" name="code" placeholder="Household code" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
        <button class="btn primary wide" type="submit">Connect</button>
      </form>
      ${codeProblem ? `<p class="err" role="alert">${esc(codeProblem)}</p>` : ''}</section>`;
  }

  function weekView() {
    const meals = sortedMeals();
    const counts = weekCounts();
    const picked = state.week.length;
    let html = `<header class="vh"><h1>This week</h1>
      <p class="lede">${picked ? plural(picked, 'meal') + ' picked' : meals.length ? 'Tap the meals you’re making.' : ''}</p></header>`;
    if (!meals.length) {
      return html + `<div class="empty"><p>No meals saved yet. Add the ones you cook most, then pick them here each week.</p>
        <button class="btn primary wide" data-act="new-meal">Add your first meal</button></div>`;
    }
    html += '<ul class="picks">' + meals.map(m => {
      const n = counts[M.normKey(m.name)] || 0;
      const nm = esc(m.name);
      return `<li class="pick${n ? ' on' : ''}">
        <button class="pick-main" data-act="toggle-meal" data-meal="${nm}" aria-pressed="${n > 0}">
          <span class="tick" aria-hidden="true"></span>
          <span class="pick-text"><span class="pick-name">${nm}</span><span class="pick-sub">${esc(ingSummary(m))}</span></span>
        </button>
        ${n ? `<span class="stepper">
          <button data-act="less" data-meal="${nm}" aria-label="Make ${nm} one less time">−</button>
          <span class="count" aria-label="${n} times">×${n}</span>
          <button data-act="more" data-meal="${nm}" aria-label="Make ${nm} one more time">+</button></span>` : ''}
      </li>`;
    }).join('') + '</ul>';
    const r = M.buildList(state);
    html += `<div class="dock"><button class="btn primary wide" data-act="go" data-view="list">
      See shopping list${r.count ? ' (' + plural(r.count, 'item') + ')' : ''}</button></div>`;
    return html;
  }

  function listView() {
    const r = M.buildList(state);
    const left = r.groups.reduce((n, g) => n + g.lines.filter(l => !checked[l.key]).length, 0);
    const lastStore = ls.get(K.lastStore, 'Other');
    let html = `<header class="vh"><h1>Shopping list</h1>
      <p class="lede">${r.count ? (left ? left + ' of ' + r.count + ' left to get' : 'Everything’s in the cart') : 'Pick meals on This week, or add an item here.'}</p></header>
      <form class="add" data-form="extra" autocomplete="off">
        <input id="extra-input" data-keep name="what" placeholder="Add an item, like 2 lb grapes" autocapitalize="sentences" enterkeyhint="done" aria-label="Item to add">
        <select id="extra-store" data-keep name="store" aria-label="Store">${storeOptions(lastStore)}</select>
        <button class="btn primary" type="submit">Add</button>
      </form>`;
    if (r.missing.length) html += `<p class="notice">Picked but no longer saved: ${esc(r.missing.join(', '))}.</p>`;
    r.groups.forEach(g => {
      const todo = g.lines.filter(l => !checked[l.key]).length;
      const lines = g.lines.slice().sort((a, b) => (checked[a.key] ? 1 : 0) - (checked[b.key] ? 1 : 0));
      html += `<section class="aisle" data-store="${storeSlug(g.store)}">
        <h2 class="sign"><span>${esc(g.store)}</span><span class="left">${todo ? todo + ' to get' : 'All done'}</span></h2>
        <ul class="lines">${lines.map(lineHtml).join('')}</ul></section>`;
    });
    if (r.count || state.week.length) {
      html += `<div class="foot"><button class="btn quiet" data-act="new-week">Start a new week</button>
        <p class="fine">Clears this week’s meals, extras and store changes. Saved meals stay.</p></div>`;
    }
    return html;
  }

  function lineHtml(l) {
    const d = M.describe(l);
    const done = !!checked[l.key];
    const forText = l.kind === 'meal' ? 'For ' + l.meals.join(', ') : 'Extra';
    const k = esc(l.key);
    return `<li class="line${done ? ' done' : ''}${d.fix ? ' needs' : ''}">
      <button class="hit" data-act="check" data-key="${k}" aria-pressed="${done}">
        <span class="box" aria-hidden="true"></span>
        <span class="what">
          <span class="name">${esc(l.name)}</span>
          ${d.main ? `<span class="qty">${esc(d.main)}</span>` : ''}
          ${d.detail ? `<span class="detail">${esc(d.detail)}</span>` : ''}
          <span class="for">${esc(forText)}</span>
        </span>
      </button>
      <div class="ctl">
        <label class="move">Move<select data-act="move" data-key="${k}" aria-label="Move ${esc(l.name)} to another store">${storeOptions(l.store)}</select></label>
        ${d.fix ? `<button class="fix" data-act="pkg" data-key="${k}">${l.status === 'mismatch' ? 'Fix units' : 'Set size'}</button>` : ''}
        ${l.kind === 'extra' ? `<button class="x" data-act="del-extra" data-id="${esc(l.id)}" aria-label="Remove ${esc(l.name)}">×</button>` : ''}
      </div>
    </li>`;
  }

  function mealsView() {
    const meals = sortedMeals();
    const pk = state.packages.slice().sort(byName);
    let html = `<header class="vh"><h1>Meals</h1>
      <p class="lede">${meals.length ? plural(meals.length, 'saved meal') : 'Start with the meals you make most.'}</p></header>
      <button class="btn primary wide" data-act="new-meal">Add a meal</button>`;
    if (meals.length) {
      html += '<ul class="menu">' + meals.map(m => `<li><button data-act="edit-meal" data-meal="${esc(m.name)}">
        <span class="pick-name">${esc(m.name)}</span><span class="pick-sub">${esc(ingSummary(m))}</span></button></li>`).join('') + '</ul>';
    }
    html += `<section class="more"><h2>Package sizes</h2>
      <p class="fine">How each ingredient is sold. The list rounds up to whole packages with these.</p>
      <ul class="menu compact">${pk.map(p => `<li><button data-act="edit-pkg" data-name="${esc(p.name)}">
        <span class="pick-name">${esc(p.name)}</span>
        <span class="pick-sub">${p.size ? esc(M.fmtQty(p.size, p.unit)) : 'No size'}${p.store ? ', ' + esc(p.store) : ''}</span></button></li>`).join('')}</ul>
      <button class="btn quiet" data-act="new-pkg">Add a package size</button></section>
      <section class="more"><h2>Another phone</h2>
      <p class="fine">Send this link once. It connects that phone to the same list.</p>
      <button class="btn quiet" data-act="share-setup">Share setup link</button></section>`;
    return html;
  }

  /* ------------------------------------------------------------- actions */

  function go(v) {
    view = v;
    ls.set(K.view, v);
    render();
    window.scrollTo(0, 0);
  }

  function setWeek(week) {
    state.week = week;
    saveCache();
    render();
    enqueue('setThisWeek', { meals: week });
  }

  function toggleMeal(name) {
    const has = state.week.some(w => same(w, name));
    setWeek(has ? state.week.filter(w => !same(w, name)) : state.week.concat([name]));
  }

  function moreMeal(name) { setWeek(state.week.concat([name])); }

  function lessMeal(name) {
    const w = state.week.slice();
    for (let i = w.length - 1; i >= 0; i--) { if (same(w[i], name)) { w.splice(i, 1); break; } }
    setWeek(w);
  }

  function toggleCheck(key) {
    if (checked[key]) delete checked[key]; else checked[key] = 1;
    ls.set(K.checked, checked);
    if (navigator.vibrate) navigator.vibrate(8);
    render();
  }

  function findLine(key) {
    const r = M.buildList(state);
    for (const g of r.groups) for (const l of g.lines) if (l.key === key) return l;
    return null;
  }

  function moveLine(key, storeName) {
    const l = findLine(key);
    if (!l) return;
    if (l.kind === 'extra') {
      const x = state.extras.find(e => e.id === l.id);
      if (!x) return;
      x.store = storeName;
      saveCache(); render();
      enqueue('addExtra', { id: x.id, item: x.item, qty: x.qty, unit: x.unit, store: x.store });
      return;
    }
    const toDefault = storeName === l.defaultStore;
    state.trip = state.trip.filter(t => !same(t.name, l.name));
    if (!toDefault) state.trip.push({ name: l.name, store: storeName });
    saveCache(); render();
    enqueue('setTripStore', { name: l.name, store: toDefault ? '' : storeName });
  }

  function addExtra(form) {
    const input = form.elements.what;
    const parsed = M.parseExtra(input.value);
    if (!parsed.item) { input.focus(); return; }
    const storeName = form.elements.store.value || 'Other';
    ls.set(K.lastStore, storeName);
    const item = parsed.item.charAt(0).toUpperCase() + parsed.item.slice(1);
    const x = { id: newId(), item: item, qty: parsed.qty, unit: parsed.unit, store: storeName };
    state.extras = state.extras.concat([x]);
    input.value = '';
    saveCache(); render();
    $('#extra-input').focus();
    enqueue('addExtra', x);
  }

  function deleteExtra(id) {
    state.extras = state.extras.filter(x => x.id !== id);
    delete checked['x:' + id];
    ls.set(K.checked, checked);
    saveCache(); render();
    enqueue('deleteExtra', { id: id });
  }

  function newWeek() {
    if (!confirm('Start a new week? This clears the picked meals, extras and store changes. Saved meals stay.')) return;
    state.week = []; state.extras = []; state.trip = [];
    checked = {}; ls.set(K.checked, checked);
    saveCache();
    go('week');
    enqueue('clearThisWeek', {});
  }

  async function shareSetup() {
    const url = location.origin + location.pathname + '#code=' + encodeURIComponent(code());
    if (navigator.share) {
      try { await navigator.share({ title: 'Groceries', text: 'Open this once to connect the grocery app:', url: url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Setup link copied'); }
    catch (e) { window.prompt('Copy this link:', url); }
  }

  /* ------------------------------------------------------------ overlays */

  const overlay = () => $('#overlay');

  function openOverlay(html) {
    const ov = overlay();
    ov.innerHTML = html;
    ov.hidden = false;
    document.body.classList.add('locked');
    history.pushState({ sheet: true }, '');
  }

  function closeOverlay(fromPop) {
    const ov = overlay();
    if (ov.hidden) return;
    ov.hidden = true;
    ov.innerHTML = '';
    document.body.classList.remove('locked');
    editor = null;
    if (!fromPop && history.state && history.state.sheet) history.back();
  }

  window.addEventListener('popstate', () => {
    if (overlay().hidden) return;
    if (editor && editor.dirty && !confirm('Discard your changes?')) { history.pushState({ sheet: true }, ''); return; }
    closeOverlay(true);
  });

  /* Meal editor */

  function openMealEditor(name) {
    const existing = name ? state.meals.find(m => same(m.name, name)) : null;
    editor = { type: 'meal', original: existing ? existing.name : '', dirty: false };
    openOverlay(`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ed-title">
      <div class="sheet-bar">
        <button class="btn quiet" data-ed="cancel">Cancel</button>
        <h2 id="ed-title">${existing ? 'Edit meal' : 'New meal'}</h2>
        <button class="btn primary" data-ed="save-meal">Save</button>
      </div>
      <div class="sheet-body">
        <label class="field"><span>Meal</span>
          <input id="ed-name" value="${esc(existing ? existing.name : '')}" placeholder="Chicken tacos" autocomplete="off" autocapitalize="words" enterkeyhint="next"></label>
        <div class="ing-head" aria-hidden="true"><span>Ingredient</span><span>Amount</span></div>
        <div id="ed-rows"></div>
        <p class="fine">Leave the amount blank for things you use as needed.</p>
        <p class="err" id="ed-err" role="alert"></p>
        ${existing ? '<button class="btn danger" data-ed="delete-meal">Delete this meal</button>' : ''}
      </div></div>`);
    refreshDatalist();
    (existing ? existing.ingredients : []).forEach(i => addRow(i));
    addRow();
    if (!existing) $('#ed-name').focus();
  }

  function addRow(ing) {
    const row = document.createElement('div');
    row.className = 'ing';
    row.innerHTML = `<input class="ing-name" list="ing-list" placeholder="Add ingredient" value="${esc(ing ? ing.name : '')}"
        autocomplete="off" autocapitalize="sentences" enterkeyhint="next" aria-label="Ingredient">
      <input class="ing-qty" inputmode="decimal" placeholder="—" value="${esc(ing ? qtyInput(ing.qty) : '')}" enterkeyhint="next" aria-label="Amount">
      <select class="ing-unit" aria-label="Unit">${unitOptions(ing && ing.unit ? ing.unit : 'ct')}</select>
      <button class="ing-x" type="button" data-ed="remove-row" aria-label="Remove ingredient">×</button>
      <p class="ing-warn"></p>`;
    if (ing) row.dataset.touched = '1'; // existing rows keep their saved unit
    $('#ed-rows').appendChild(row);
    checkRow(row);
    return row;
  }

  function applyKnownUnit(row) {
    const nameEl = $('.ing-name', row);
    const k = knownIngredient(nameEl.value);
    if (!k || row.dataset.touched) return;
    if (k.unit) {
      const sel = $('.ing-unit', row);
      if (!Array.from(sel.options).some(o => o.value === k.unit)) sel.innerHTML = unitOptions(k.unit);
      sel.value = k.unit;
    }
  }

  function checkRow(row) {
    const warn = $('.ing-warn', row);
    const name = $('.ing-name', row).value;
    const qtyText = $('.ing-qty', row).value.trim();
    const unit = $('.ing-unit', row).value;
    let msg = '';
    if (qtyText && M.parseQty(qtyText) == null) {
      msg = 'Amount should be a number, like 2, 1.5 or 1/2.';
    } else {
      const k = knownIngredient(name);
      if (k && k.pkg && M.parseQty(k.pkg.size) && M.convert(1, unit, k.pkg.unit) == null) {
        const pu = M.unitKey(k.pkg.unit);
        msg = `${k.name} is sold in ${pu} (${M.dimLabel(pu)}), and ${unit} can’t be added to that. Pick a ${M.dimLabel(pu)} unit.`;
      }
    }
    warn.textContent = msg;
  }

  function saveMeal() {
    const err = $('#ed-err');
    const name = $('#ed-name').value.replace(/\s+/g, ' ').trim();
    if (!name) { err.textContent = 'Give the meal a name.'; $('#ed-name').focus(); return; }
    if (state.meals.some(m => same(m.name, name) && !same(m.name, editor.original))) {
      err.textContent = `There’s already a meal called “${name}”.`;
      return;
    }
    const ingredients = [];
    let bad = null;
    $$('.ing', $('#ed-rows')).forEach(row => {
      const raw = $('.ing-name', row).value.replace(/\s+/g, ' ').trim();
      if (!raw) return;
      const k = knownIngredient(raw);
      const qtyText = $('.ing-qty', row).value.trim();
      const q = M.parseQty(qtyText);
      if (qtyText && q == null && !bad) bad = row;
      ingredients.push({ name: k ? k.name : raw, qty: q, unit: $('.ing-unit', row).value });
    });
    if (bad) { err.textContent = 'One amount isn’t a number. Use 2, 1.5 or 1/2.'; $('.ing-qty', bad).focus(); return; }

    const original = editor.original;
    state.meals = state.meals.filter(m => !same(m.name, name) && !(original && same(m.name, original)))
      .concat([{ name: name, ingredients: ingredients }]);
    if (original && !same(original, name)) state.week = state.week.map(w => same(w, original) ? name : w);
    saveCache();
    closeOverlay();
    render();
    toast('Saved ' + name);
    enqueue('addMeal', { meal: name, originalName: original || name, ingredients: ingredients });
  }

  function deleteMeal() {
    const name = editor.original;
    if (!confirm(`Delete “${name}”? It also comes off this week.`)) return;
    state.meals = state.meals.filter(m => !same(m.name, name));
    state.week = state.week.filter(w => !same(w, name));
    saveCache();
    closeOverlay();
    render();
    toast('Deleted ' + name);
  }

  /* Package editor */

  function openPkgEditor(name, context) {
    const p = name ? state.packages.find(x => same(x.name, name)) : null;
    const line = context && context.line;
    const unit = p && p.unit ? p.unit : line ? line.recipeUnit : 'ct';
    editor = { type: 'pkg', name: p ? p.name : name || '', dirty: false };
    let hint = 'Example: shredded cheese in an 8 oz bag → 8 oz.';
    if (line && line.status === 'mismatch') {
      const recipeUnits = line.totals.map(t => t.unit).filter(u => M.convert(1, u, line.pkgUnit) == null);
      hint = `Your meals use ${recipeUnits.join(', ')}, but this is set in ${line.pkgUnit} (${M.dimLabel(line.pkgUnit)}). ` +
        `Either enter how much the package holds in ${recipeUnits[0]}, or change those meals to a ${M.dimLabel(line.pkgUnit)} unit.`;
    }
    openOverlay(`<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="pk-title">
      <div class="sheet-bar">
        <button class="btn quiet" data-ed="cancel">Cancel</button>
        <h2 id="pk-title">Package size</h2>
        <button class="btn primary" data-ed="save-pkg">Save</button>
      </div>
      <div class="sheet-body">
        ${editor.name ? `<p class="pk-name">${esc(editor.name)}</p>`
          : `<label class="field"><span>Ingredient</span><input id="pk-name" list="ing-list" autocomplete="off" autocapitalize="sentences" placeholder="Shredded cheese"></label>`}
        <div class="field"><span>Comes in</span>
          <div class="pk-row">
            <input id="pk-size" inputmode="decimal" value="${esc(p && p.size ? qtyInput(p.size) : '')}" placeholder="8" aria-label="Package size">
            <select id="pk-unit" aria-label="Unit">${unitOptions(unit)}</select>
          </div></div>
        <label class="field"><span>Usually buy at</span>
          <select id="pk-store">${storeOptions(p ? p.store : '', true)}</select></label>
        <p class="fine">${esc(hint)}</p>
        <p class="err" id="pk-err" role="alert"></p>
      </div></div>`);
    refreshDatalist();
    (editor.name ? $('#pk-size') : $('#pk-name')).focus();
  }

  function savePkg() {
    const err = $('#pk-err');
    const name = editor.name || $('#pk-name').value.replace(/\s+/g, ' ').trim();
    if (!name) { err.textContent = 'Which ingredient is this for?'; return; }
    const size = M.parseQty($('#pk-size').value);
    if (!size) { err.textContent = 'Enter the package size as a number, like 8 or 1.5.'; $('#pk-size').focus(); return; }
    const k = knownIngredient(name);
    const finalName = k ? k.name : name;
    const pkg = { name: finalName, size: size, unit: $('#pk-unit').value, store: $('#pk-store').value };
    state.packages = state.packages.filter(p => !same(p.name, finalName)).concat([pkg]);
    saveCache();
    closeOverlay();
    render();
    toast('Saved ' + finalName);
    enqueue('setPackage', pkg);
  }

  /* -------------------------------------------------------------- events */

  document.addEventListener('click', e => {
    const ed = e.target.closest('[data-ed]');
    if (ed && overlay().contains(ed)) { onEditorClick(ed, e); return; }
    if (e.target === overlay()) { onEditorClick({ dataset: { ed: 'cancel' } }, e); return; }
    const a = e.target.closest('[data-act]');
    if (!a || a.tagName === 'SELECT') return;
    const d = a.dataset;
    switch (d.act) {
      case 'go': go(d.view); break;
      case 'toggle-meal': toggleMeal(d.meal); break;
      case 'more': moreMeal(d.meal); break;
      case 'less': lessMeal(d.meal); break;
      case 'check': toggleCheck(d.key); break;
      case 'pkg': {
        const l = findLine(d.key);
        if (l) openPkgEditor(l.name, { line: l });
        break;
      }
      case 'del-extra': deleteExtra(d.id); break;
      case 'new-week': newWeek(); break;
      case 'new-meal': openMealEditor(null); break;
      case 'edit-meal': openMealEditor(d.meal); break;
      case 'edit-pkg': openPkgEditor(d.name); break;
      case 'new-pkg': openPkgEditor(null); break;
      case 'share-setup': shareSetup(); break;
    }
  });

  function onEditorClick(el, e) {
    switch (el.dataset.ed) {
      case 'cancel':
        if (editor && editor.dirty && !confirm('Discard your changes?')) return;
        closeOverlay();
        break;
      case 'save-meal': saveMeal(); break;
      case 'delete-meal': deleteMeal(); break;
      case 'save-pkg': savePkg(); break;
      case 'remove-row': {
        const row = el.closest('.ing');
        const rows = $('#ed-rows');
        row.remove();
        editor.dirty = true;
        const all = $$('.ing', rows);
        if (!all.length || $('.ing-name', all[all.length - 1]).value.trim()) addRow();
        break;
      }
    }
    if (e && e.preventDefault) e.preventDefault();
  }

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('select[data-act="move"]')) { moveLine(t.dataset.key, t.value); return; }
    const row = t.closest && t.closest('.ing');
    if (row) {
      if (t.classList.contains('ing-unit')) row.dataset.touched = '1';
      if (t.classList.contains('ing-name')) applyKnownUnit(row);
      checkRow(row);
    }
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (editor && overlay().contains(t)) editor.dirty = true;
    const row = t.closest && t.closest('.ing');
    if (!row) return;
    if (t.classList.contains('ing-name')) {
      const rows = $$('.ing', $('#ed-rows'));
      if (row === rows[rows.length - 1] && t.value.trim()) addRow();
      if (knownIngredient(t.value) && M.normKey(knownIngredient(t.value).name) === M.normKey(t.value)) applyKnownUnit(row);
    }
    checkRow(row);
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !overlay().contains(e.target)) return;
    const t = e.target;
    if (t.id === 'ed-name') { e.preventDefault(); const first = $('.ing-name', $('#ed-rows')); if (first) first.focus(); return; }
    const row = t.closest('.ing');
    if (!row) return;
    e.preventDefault();
    if (t.classList.contains('ing-name')) { $('.ing-qty', row).focus(); return; }
    if (t.classList.contains('ing-qty')) {
      const next = row.nextElementSibling;
      if (next) $('.ing-name', next).focus();
    }
  });

  document.addEventListener('submit', e => {
    const f = e.target;
    e.preventDefault();
    if (f.dataset.form === 'extra') addExtra(f);
    if (f.dataset.form === 'code') {
      const v = f.elements.code.value.trim();
      if (!v) return;
      setCode(v);
      render();
      refresh();
    }
  });

  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
  }

  render();
  refresh();
})();
