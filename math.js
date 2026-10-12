/* Grocery math: units, totals, packages, leftovers. Pure functions, no DOM.
   Loaded by the app in the browser and by the tests in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GroceryMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_STORES = ['Aldi', 'Costco', "Pick 'n Save", 'Target', 'Other'];

  // Weight and volume are different physical quantities. Converting between
  // them needs a density, which varies by ingredient (a cup of shredded cheese
  // weighs far less than a cup of milk), so the app never guesses across them.
  const UNITS = {
    // weight, base = gram
    oz:    { dim: 'weight', toBase: 28.349523125 },
    lb:    { dim: 'weight', toBase: 453.59237 },
    g:     { dim: 'weight', toBase: 1 },
    kg:    { dim: 'weight', toBase: 1000 },
    // volume, base = millilitre (US customary)
    'fl oz': { dim: 'volume', toBase: 29.5735295625 },
    tsp:   { dim: 'volume', toBase: 4.92892159375 },
    tbsp:  { dim: 'volume', toBase: 14.78676478125 },
    cup:   { dim: 'volume', toBase: 236.5882365 },
    pt:    { dim: 'volume', toBase: 473.176473 },
    qt:    { dim: 'volume', toBase: 946.352946 },
    gal:   { dim: 'volume', toBase: 3785.411784 },
    ml:    { dim: 'volume', toBase: 1 },
    l:     { dim: 'volume', toBase: 1000 },
    // count
    ct:    { dim: 'count', toBase: 1 },
  };

  const ALIASES = {
    '': 'ct', each: 'ct', ea: 'ct', count: 'ct', pc: 'ct', pcs: 'ct', piece: 'ct', pieces: 'ct', whole: 'ct',
    ounce: 'oz', ounces: 'oz', 'oz.': 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb', 'lb.': 'lb',
    gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg',
    'fl. oz': 'fl oz', 'fl.oz': 'fl oz', floz: 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
    cups: 'cup', c: 'cup', tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
    teaspoon: 'tsp', teaspoons: 'tsp', gallon: 'gal', gallons: 'gal', quart: 'qt', quarts: 'qt',
    pint: 'pt', pints: 'pt', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  };

  const UNIT_GROUPS = [
    { label: 'Count',  units: ['ct'] },
    { label: 'Weight', units: ['oz', 'lb', 'g', 'kg'] },
    { label: 'Volume', units: ['fl oz', 'cup', 'tbsp', 'tsp', 'gal', 'qt', 'pt', 'ml', 'l'] },
    { label: 'Other',  units: ['can', 'jar', 'bag', 'box', 'pkg', 'bunch', 'clove', 'slice', 'scoop', 'serving'] },
  ];

  function unitKey(u) {
    let s = String(u == null ? '' : u).trim().toLowerCase().replace(/\s+/g, ' ');
    if (Object.prototype.hasOwnProperty.call(ALIASES, s)) return ALIASES[s];
    if (UNITS[s]) return s;
    if (s.length > 2 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1); // scoops → scoop
    return s;
  }

  function unitInfo(u) {
    const key = unitKey(u);
    const known = UNITS[key];
    return known ? { key: key, dim: known.dim, toBase: known.toBase }
                 : { key: key, dim: 'other:' + key, toBase: 1 };
  }

  function dimLabel(u) {
    const d = unitInfo(u).dim;
    return d.startsWith('other:') ? unitInfo(u).key : d;
  }

  /** Converts qty between units of the same quantity; null if they don't convert. */
  function convert(qty, from, to) {
    const a = unitInfo(from);
    const b = unitInfo(to);
    if (a.dim !== b.dim) return null;
    return qty * a.toBase / b.toBase;
  }

  /** "1.5", "1/2", "1 1/2", "1½", "2,5" → number. Blank or junk → null. */
  function parseQty(input) {
    if (typeof input === 'number') return isFinite(input) && input > 0 ? input : null;
    let s = String(input == null ? '' : input).trim().replace(',', '.');
    if (!s) return null;
    const vulgar = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
    s = s.replace(/[½¼¾⅓⅔⅛]/g, function (m) { return ' ' + vulgar[m]; }).trim();
    let total = 0;
    const parts = s.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (/^(\d+\.?\d*|\.\d+)$/.test(p)) total += parseFloat(p);
      else if (/^\d+\/\d+$/.test(p)) {
        const ab = p.split('/').map(Number);
        if (!ab[1]) return null;
        total += ab[0] / ab[1];
      } else return null;
    }
    return total > 0 ? total : null;
  }

  function normKey(name) {
    return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function fmt(n) {
    if (n == null || !isFinite(n)) return '';
    if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function fmtQty(n, unit) {
    const u = unitKey(unit);
    return fmt(n) + (u ? ' ' + u : '');
  }

  function canonStore(s, stores) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return 'Other';
    const hit = stores.find(function (x) { return x.toLowerCase() === t.toLowerCase(); });
    return hit || t;
  }

  /** Sums quantities per physical quantity, each expressed in the first unit seen. */
  function sumByUnit(parts) {
    const out = [];
    parts.forEach(function (p) {
      const info = unitInfo(p.unit);
      const slot = out.find(function (o) { return unitInfo(o.unit).dim === info.dim; });
      if (slot) slot.qty += convert(p.qty, p.unit, slot.unit);
      else out.push({ qty: p.qty, unit: info.key });
    });
    return out;
  }

  /**
   * The core feature. For each ingredient across the picked meals:
   *   total    = Σ qty, converted into the package's unit
   *   packages = ceil(total / packageSize)
   *   leftover = packages × packageSize − total
   * Without a package size the line says "buy as needed". If a recipe's unit
   * can't convert to the package's unit (cups vs weight-ounces) the line says
   * so instead of producing a wrong number.
   */
  function buildList(data) {
    const meals = data.meals || [];
    const week = data.week || [];
    const packages = data.packages || [];
    const trip = data.trip || [];
    const extras = data.extras || [];
    const stores = (data.stores && data.stores.length) ? data.stores : DEFAULT_STORES;

    const mealBy = new Map(meals.map(function (m) { return [normKey(m.name), m]; }));
    const pkgBy = new Map(packages.filter(function (p) { return p.name; })
      .map(function (p) { return [normKey(p.name), p]; }));
    const tripBy = new Map(trip.map(function (t) { return [normKey(t.name), t.store]; }));

    const acc = new Map();
    const missing = [];
    week.forEach(function (pick) {
      const meal = mealBy.get(normKey(pick));
      if (!meal) { missing.push(pick); return; }
      (meal.ingredients || []).forEach(function (ing) {
        const key = normKey(ing.name);
        if (!key) return;
        if (!acc.has(key)) acc.set(key, { key: key, name: String(ing.name).trim(), parts: [], meals: [] });
        const a = acc.get(key);
        a.parts.push({ qty: parseQty(ing.qty), unit: ing.unit });
        if (a.meals.indexOf(meal.name) < 0) a.meals.push(meal.name);
      });
    });

    const lines = [];
    acc.forEach(function (a) {
      const pkg = pkgBy.get(a.key);
      const known = a.parts.filter(function (p) { return p.qty != null; });
      const line = {
        key: a.key,
        name: a.name,
        kind: 'meal',
        meals: a.meals,
        store: canonStore(tripBy.has(a.key) ? tripBy.get(a.key) : (pkg && pkg.store), stores),
        defaultStore: canonStore(pkg && pkg.store, stores),
        storeOverridden: tripBy.has(a.key),
        someAsNeeded: known.length < a.parts.length,
        recipeUnit: known.length ? unitKey(known[0].unit) : (a.parts[0] ? unitKey(a.parts[0].unit) : 'ct'),
      };
      const size = pkg ? parseQty(pkg.size) : null;
      if (size) {
        const pu = unitInfo(pkg.unit).key;
        line.pkgSize = size;
        line.pkgUnit = pu;
        let total = 0;
        let mismatch = false;
        known.forEach(function (p) {
          const v = convert(p.qty, p.unit, pu);
          if (v == null) mismatch = true; else total += v;
        });
        if (mismatch) {
          line.status = 'mismatch';
          line.totals = sumByUnit(known);
        } else if (total <= 0) {
          line.status = 'asNeeded';
          line.totals = [];
        } else {
          // Tolerance stops float noise (16 tbsp = 1.0000000002 cup) from buying an extra package.
          const count = Math.max(1, Math.ceil(total / size - 1e-9));
          line.status = 'packaged';
          line.total = total;
          line.packages = count;
          line.leftover = Math.max(0, count * size - total);
        }
      } else {
        line.status = 'asNeeded';
        line.totals = sumByUnit(known);
      }
      lines.push(line);
    });

    extras.forEach(function (x) {
      lines.push({
        key: 'x:' + x.id,
        id: x.id,
        name: x.item,
        kind: 'extra',
        status: 'extra',
        store: canonStore(x.store, stores),
        qty: parseQty(x.qty),
        unit: x.unit,
      });
    });

    const groups = new Map();
    lines.forEach(function (l) {
      if (!groups.has(l.store)) groups.set(l.store, []);
      groups.get(l.store).push(l);
    });
    const order = Array.from(groups.keys()).sort(function (a, b) {
      const ia = stores.indexOf(a), ib = stores.indexOf(b);
      const ra = a === 'Other' ? 2 : ia >= 0 ? 0 : 1;
      const rb = b === 'Other' ? 2 : ib >= 0 ? 0 : 1;
      if (ra !== rb) return ra - rb;
      if (ra === 0) return ia - ib;
      return a.localeCompare(b);
    });

    return {
      groups: order.map(function (store) {
        return {
          store: store,
          lines: groups.get(store).sort(function (a, b) { return a.name.localeCompare(b.name); }),
        };
      }),
      count: lines.length,
      missing: missing,
    };
  }

  /** Human text for a list line: main = what to grab, detail = the why. */
  function describe(line) {
    if (line.status === 'packaged') {
      const each = line.pkgUnit === 'ct' && line.pkgSize === 1;
      const main = each ? 'Buy ' + line.packages
                        : 'Buy ' + line.packages + ' × ' + fmtQty(line.pkgSize, line.pkgUnit);
      const left = line.leftover < 0.005 ? 'none left over' : fmtQty(line.leftover, line.pkgUnit) + ' left over';
      let detail = 'Need ' + fmtQty(line.total, line.pkgUnit) + ', ' + left;
      if (line.someAsNeeded) detail += ' (plus some as needed)';
      return { main: main, detail: detail };
    }
    if (line.status === 'mismatch') {
      return {
        main: line.totals.map(function (t) { return fmtQty(t.qty, t.unit); }).join(' + '),
        detail: 'Package is in ' + line.pkgUnit + ' (' + dimLabel(line.pkgUnit) + '), recipe uses ' +
          line.totals.filter(function (t) { return unitInfo(t.unit).dim !== unitInfo(line.pkgUnit).dim; })
            .map(function (t) { return t.unit; }).join(', ') + '. These don’t convert.',
        fix: true,
      };
    }
    if (line.status === 'asNeeded') {
      const amt = (line.totals || []).map(function (t) { return fmtQty(t.qty, t.unit); }).join(' + ');
      return {
        main: amt ? amt + ', buy as needed' : 'Buy as needed',
        detail: line.pkgSize ? '' : 'No package size yet',
        fix: !line.pkgSize,
      };
    }
    // extra
    return { main: line.qty ? fmtQty(line.qty, line.unit) : '', detail: '' };
  }

  /** "2 lb grapes" → {qty:2, unit:'lb', item:'grapes'}; "paper towels" → {item}. */
  function parseExtra(text) {
    const s = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
    const words = s.split(' ');
    const qty = words.length > 1 ? parseQty(words[0]) : null;
    if (qty == null) return { item: s, qty: null, unit: '' };
    let rest = words.slice(1);
    let unit = '';
    const two = rest.slice(0, 2).join(' ').toLowerCase();
    if (rest.length > 2 && unitKey(two) === 'fl oz') { unit = 'fl oz'; rest = rest.slice(2); }
    else if (rest.length > 1 && UNITS[unitKey(rest[0])] && unitKey(rest[0]) !== 'ct') { unit = unitKey(rest[0]); rest = rest.slice(1); }
    const item = rest.join(' ');
    return item ? { item: item, qty: qty, unit: unit || 'ct' } : { item: s, qty: null, unit: '' };
  }

  return {
    DEFAULT_STORES: DEFAULT_STORES,
    UNITS: UNITS,
    UNIT_GROUPS: UNIT_GROUPS,
    unitKey: unitKey,
    unitInfo: unitInfo,
    dimLabel: dimLabel,
    convert: convert,
    parseQty: parseQty,
    normKey: normKey,
    fmt: fmt,
    fmtQty: fmtQty,
    canonStore: canonStore,
    sumByUnit: sumByUnit,
    buildList: buildList,
    describe: describe,
    parseExtra: parseExtra,
  };
});
