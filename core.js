/*!
 * CoFocus — collaboration relationship analysis core.
 * Pure, dependency-free, deterministic. Runs in the browser and in Node.
 *
 * Pipeline:
 *   raw imports -> dedupe -> weighted pair graph -> connected components
 *   -> normalized Laplacian spectrum -> spectral grouping -> membership
 *   matching across runs -> weight-perturbation stability.
 *
 * The people array produced by buildGraph is the single shared roster:
 * matrix construction, grouping and run comparison all index into it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoFocus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 1e-10;
  const SUPPORT_THRESHOLD = 0.05;

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function zeros(n, m) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = new Array(m).fill(0);
    return a;
  }

  function identity(n) {
    const a = zeros(n, n);
    for (let i = 0; i < n; i++) a[i][i] = 1;
    return a;
  }

  function sum(arr) {
    return arr.reduce((s, x) => s + x, 0);
  }

  function median(arr) {
    const vals = arr.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!vals.length) return 0;
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }

  function uniqStrings(arr) {
    const out = [];
    const seen = new Set();
    for (const item of arr || []) {
      const s = String(item == null ? '' : item).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function pairKey(a, b) {
    return a < b ? a + ':' + b : b + ':' + a;
  }

  function kmeans(rows, k, rng, restarts) {
    const n = rows.length;
    const d = n ? rows[0].length : 0;
    const kk = Math.max(1, Math.min(k, n));
    if (!n) return { labels: [], inertia: 0 };
    if (kk === 1) return { labels: new Array(n).fill(0), inertia: 0 };

    const sqDist = (a, b) => {
      let s = 0;
      for (let j = 0; j < d; j++) {
        const t = a[j] - b[j];
        s += t * t;
      }
      return s;
    };

    let best = null;
    for (let attempt = 0; attempt < restarts; attempt++) {
      const centers = [];
      const first = Math.floor(rng() * n) % n;
      centers.push(rows[first].slice());
      const d2 = rows.map((r) => sqDist(r, centers[0]));
      for (let c = 1; c < kk; c++) {
        const total = sum(d2);
        let pick;
        if (total <= EPS) {
          pick = (first + c) % n;
        } else {
          let target = rng() * total;
          pick = n - 1;
          for (let i = 0; i < n; i++) {
            target -= d2[i];
            if (target <= 0) {
              pick = i;
              break;
            }
          }
        }
        centers.push(rows[pick].slice());
        for (let i = 0; i < n; i++) d2[i] = Math.min(d2[i], sqDist(rows[i], centers[c]));
      }

      const labels = new Array(n).fill(0);
      let inertia = Infinity;
      for (let iter = 0; iter < 100; iter++) {
        let changed = false;
        inertia = 0;
        for (let i = 0; i < n; i++) {
          let bestC = 0;
          let bestD = Infinity;
          for (let c = 0; c < kk; c++) {
            const dd = sqDist(rows[i], centers[c]);
            if (dd < bestD - EPS) {
              bestD = dd;
              bestC = c;
            }
          }
          inertia += bestD;
          if (labels[i] !== bestC) {
            labels[i] = bestC;
            changed = true;
          }
        }
        const counts = new Array(kk).fill(0);
        const next = zeros(kk, d);
        for (let i = 0; i < n; i++) {
          counts[labels[i]]++;
          for (let j = 0; j < d; j++) next[labels[i]][j] += rows[i][j];
        }
        for (let c = 0; c < kk; c++) {
          if (!counts[c]) {
            let far = 0;
            let farD = -1;
            for (let i = 0; i < n; i++) {
              const dd = sqDist(rows[i], centers[labels[i]]);
              if (dd > farD) {
                farD = dd;
                far = i;
              }
            }
            centers[c] = rows[far].slice();
          } else {
            for (let j = 0; j < d; j++) centers[c][j] = next[c][j] / counts[c];
          }
        }
        if (!changed && iter > 0) break;
      }
      if (!best || inertia < best.inertia - EPS) best = { labels, inertia };
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 1. Data conversion: imports -> dedupe -> pair shares -> W
   * ------------------------------------------------------------------ */

  function normalizeEvent(raw, ctx) {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${ctx.index + 1} 行不是对象`);
    const id = String(raw.id == null ? '' : raw.id).trim();
    if (!id) throw new Error(`第 ${ctx.index + 1} 行缺少事项编号`);
    let year = null;
    if (raw.year != null && String(raw.year).trim() !== '') {
      year = Number(raw.year);
      if (!Number.isFinite(year)) throw new Error(`第 ${ctx.index + 1} 行（${id}）的年份不是数字`);
    }
    let weight = 1;
    if (raw.weight != null && String(raw.weight).trim() !== '') {
      weight = Number(raw.weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`第 ${ctx.index + 1} 行（${id}）的权重必须是正数`);
      }
    }
    const people = uniqStrings(raw.people);
    if (people.length < 2) {
      throw new Error(`第 ${ctx.index + 1} 行（${id}）至少需要 2 位不同人员，实际 ${people.length} 位`);
    }
    return {
      id,
      title: raw.title == null || String(raw.title).trim() === '' ? id : String(raw.title).trim(),
      year,
      weight,
      people,
    };
  }

  /**
   * Normalization rules for a matter with m participants. Both rules keep
   * the *per-pair* weight falling as headcount rises, so one all-hands
   * cannot out-pull a series of small matters just by having more people.
   *
   * - `per-matter` (default): the whole matter has a fixed budget (1 ×
   *   its own weight), split evenly across all C(m,2) pairs. Share is
   *   1 / C(m,2); the matter's total contribution is constant no matter
   *   how many people join.
   * - `per-person`: each participant brings a budget of 1, shared across
   *   their m-1 partners. Share is 1 / (m-1). This is the Newman-style
   *   co-authorship weighting; the matter's total mass grows linearly with
   *   headcount, but each individual pair still gets a small share.
   *
   * The choice is explicit, is persisted in the run options, and is
   * displayed in the UI: it changes the numbers, not just the labels.
   */
  function pairShare(m, rule, matterBudget, matterWeight) {
    const budget = matterBudget * (matterWeight == null ? 1 : matterWeight);
    if (rule === 'per-person') return budget / (m - 1);
    return budget / ((m * (m - 1)) / 2);
  }

  /**
   * Accumulation transform applied once to the summed pair share:
   * `sqrt` grows sub-linearly in the number of shared matters, so a pair
   * that happens to co-occur in fifteen events does not get fifteen times
   * the pull of a pair that co-occurred once. `linear` keeps the raw sum.
   */
  function transformShare(total, transform) {
    if (transform === 'linear') return total;
    return Math.sqrt(Math.max(0, total));
  }

  function buildGraph(events, options) {
    const opts = Object.assign(
      {
        matterBudget: 1,
        pairRule: 'per-matter', // 'per-matter' | 'per-person'
        pairTransform: 'sqrt', // 'sqrt' | 'linear'
        duplicatePolicy: 'first', // 'first' | 'last'
        roster: [], // every known person; unmatched people stay isolated
        source: 'input',
      },
      options || {}
    );
    if (!Number.isFinite(opts.matterBudget) || opts.matterBudget <= 0) {
      throw new Error('matterBudget 必须是正数');
    }
    if (opts.pairRule !== 'per-person' && opts.pairRule !== 'per-matter') {
      throw new Error("pairRule 必须是 'per-person' 或 'per-matter'");
    }
    if (opts.pairTransform !== 'sqrt' && opts.pairTransform !== 'linear') {
      throw new Error("pairTransform 必须是 'sqrt' 或 'linear'");
    }
    if (opts.duplicatePolicy !== 'first' && opts.duplicatePolicy !== 'last') {
      throw new Error("duplicatePolicy 必须是 'first' 或 'last'");
    }

    const peopleSet = new Set();
    for (const p of opts.roster || []) {
      const s = String(p == null ? '' : p).trim();
      if (s) peopleSet.add(s);
    }

    const byId = new Map();
    const ordered = [];
    const rawEvents = events || [];
    const errors = [];
    const duplicates = [];
    let invalid = 0;

    for (let i = 0; i < rawEvents.length; i++) {
      let ev;
      try {
        ev = normalizeEvent(rawEvents[i], { index: i });
      } catch (e) {
        invalid++;
        errors.push(e.message);
        continue;
      }
      if (byId.has(ev.id)) {
        const first = byId.get(ev.id);
        duplicates.push({
          id: ev.id,
          index: i,
          kept: opts.duplicatePolicy === 'first' ? first.index : i,
          policy: opts.duplicatePolicy,
        });
        if (opts.duplicatePolicy === 'first') continue;
        const prevIdx = ordered.findIndex((x) => x.id === ev.id);
        if (prevIdx >= 0) ordered[prevIdx] = ev;
        continue;
      }
      byId.set(ev.id, { id: ev.id, index: i });
      ordered.push(ev);
      for (const p of ev.people) peopleSet.add(p);
    }

    const people = Array.from(peopleSet).sort((a, b) => a.localeCompare(b));
    const index = new Map(people.map((p, i) => [p, i]));
    const n = people.length;
    const raw = zeros(n, n);
    const matters = [];

    for (const ev of ordered) {
      const m = ev.people.length;
      const share = pairShare(m, opts.pairRule, opts.matterBudget, ev.weight);
      const memberIdx = ev.people.map((p) => index.get(p));
      const pairs = [];
      for (let a = 0; a < m; a++) {
        for (let b = a + 1; b < m; b++) {
          const ia = memberIdx[a];
          const ib = memberIdx[b];
          raw[ia][ib] += share;
          raw[ib][ia] += share;
          pairs.push([ia, ib, share]);
        }
      }
      matters.push({
        id: ev.id,
        title: ev.title,
        year: ev.year,
        weight: ev.weight,
        memberIdx,
        m,
        pairCount: (m * (m - 1)) / 2,
        share,
        total: (m * (m - 1)) / 2 * share,
        budget: opts.matterBudget * ev.weight,
        pairs,
        source: opts.source,
      });
    }

    const W = matrixFromMatters(people.length, matters, opts.pairTransform);
    return {
      people,
      index,
      W,
      matters,
      stats: {
        rowsReceived: rawEvents.length,
        matters: ordered.length,
        duplicatesDropped: rawEvents.length - invalid - ordered.length,
        duplicates,
        invalidDropped: invalid,
        errors,
        people: n,
        pairs: countPairs(W),
        options: opts,
      },
    };
  }

  function matrixFromMatters(n, matters, transform) {
    const raw = zeros(n, n);
    for (const matter of matters) {
      for (const [a, b, share] of matter.pairs) {
        raw[a][b] += share;
        raw[b][a] += share;
      }
    }
    const W = zeros(n, n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = transformShare(raw[i][j], transform);
        W[i][j] = v;
        W[j][i] = v;
      }
    }
    return W;
  }

  function countPairs(W) {
    let count = 0;
    for (let i = 0; i < W.length; i++) {
      for (let j = i + 1; j < W.length; j++) if (W[i][j] > EPS) count++;
    }
    return count;
  }

  /**
   * Remove matters (e.g. one oversized event) and rebuild W with the same
   * people order and the same transform. Because the transform is applied
   * to the *summed* share, this is exact: it equals buildGraph(events
   * minus those matters). Nothing is subtracted from an already-sqrt'd W.
   */
  function excludeMatters(graph, matterIds, options) {
    const opts = Object.assign({}, graph.stats.options, options || {});
    const drop = new Set(matterIds || []);
    const matters = graph.matters.filter((m) => !drop.has(m.id));
    const W = matrixFromMatters(graph.people.length, matters, opts.pairTransform);
    return {
      people: graph.people,
      index: graph.index,
      W,
      matters,
      stats: Object.assign({}, graph.stats, {
        matters: matters.length,
        pairs: countPairs(W),
        excluded: Array.from(drop),
        options: opts,
      }),
    };
  }

  /* ------------------------------------------------------------------ *
   * 2. Connected components
   * ------------------------------------------------------------------ */

  /**
   * Connected components of the subgraph induced by `nodes`.
   *
   * Zero-degree nodes are never placed in a component: they are returned
   * separately as `isolated`, which also keeps them out of every division
   * by degree downstream.
   */
  function componentsOf(W, nodes) {
    const nodesArr = nodes ? nodes.slice() : W.map((_, i) => i);
    const nodeSet = new Set(nodesArr);
    const n = W.length;
    const degree = new Array(n).fill(0);
    for (const i of nodesArr) {
      let d = 0;
      for (const j of nodesArr) if (i !== j) d += W[i][j];
      degree[i] = d;
    }
    const seen = new Set();
    const components = [];
    const isolated = [];
    for (const start of nodesArr) {
      if (seen.has(start)) continue;
      if (degree[start] <= EPS) {
        seen.add(start);
        isolated.push(start);
        continue;
      }
      const stack = [start];
      seen.add(start);
      const members = [];
      while (stack.length) {
        const u = stack.pop();
        members.push(u);
        for (let v = 0; v < n; v++) {
          if (!nodeSet.has(v) || seen.has(v) || W[u][v] <= EPS) continue;
          seen.add(v);
          stack.push(v);
        }
      }
      members.sort((a, b) => a - b);
      components.push(members);
    }
    const weightOf = (members) => {
      let s = 0;
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) s += W[members[a]][members[b]];
      }
      return s;
    };
    components.sort((a, b) => weightOf(b) - weightOf(a) || b.length - a.length || a[0] - b[0]);
    return { components, isolated, degree };
  }

  /* ------------------------------------------------------------------ *
   * 3. Spectrum
   * ------------------------------------------------------------------ */

  function jacobiEigen(A) {
    const n = A.length;
    if (!n) return { values: [], vectors: [] };
    const a = A.map((r) => r.slice());
    const v = identity(n);
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = a[p][q];
          if (Math.abs(apq) < 1e-15) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * apq);
          const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p];
            const akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k];
            const aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k][p];
            const vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const values = a.map((r, i) => r[i]);
    const order = values.map((x, i) => i).sort((x, y) => values[x] - values[y]);
    const sorted = order.map((i) => values[i]);
    const vectors = zeros(n, n);
    for (let k = 0; k < n; k++) {
      const col = order[k];
      for (let i = 0; i < n; i++) vectors[i][k] = v[i][col];
    }
    return { values: sorted, vectors };
  }

  /**
   * Spectrum of the symmetric normalized Laplacian
   * L = I - D^{-1/2} W D^{-1/2}, restricted to one connected component.
   *
   * Since every node passed in has positive degree (isolated people were
   * separated earlier), D is invertible; the guard below only protects
   * against a caller passing a zero-degree node by mistake.
   */
  function laplacianSpectrum(W, nodes) {
    const ids = nodes.slice();
    const k = ids.length;
    if (k === 0) return { values: [], vectors: [], nodes: ids, degree: [] };
    const degree = new Array(k).fill(0);
    for (let i = 0; i < k; i++) {
      let d = 0;
      for (let j = 0; j < k; j++) if (i !== j) d += W[ids[i]][ids[j]] || 0;
      degree[i] = d;
    }
    const invSqrt = degree.map((d) => (d > EPS ? 1 / Math.sqrt(d) : 0));
    const L = zeros(k, k);
    for (let i = 0; i < k; i++) {
      L[i][i] = degree[i] > EPS ? 1 : 0;
      for (let j = i + 1; j < k; j++) {
        const w = (W[ids[i]][ids[j]] || 0) * invSqrt[i] * invSqrt[j];
        L[i][j] = -w;
        L[j][i] = -w;
      }
    }
    const eig = jacobiEigen(L);
    const values = eig.values.map((x) => (Math.abs(x) < 1e-9 ? 0 : x));
    return { values, vectors: eig.vectors, nodes: ids, degree };
  }

  /**
   * Eigengap support for a k-way split.
   *
   * Eigenvalues are ascending, v[0] = 0 for a connected component. k
   * groups need k small eigenvalues; the boundary is the gap between
   * v[k-1] (last one kept) and v[k] (first one dropped). The score is the
   * gap as a fraction of the whole spectral range (λ[last] − λ[0], at most
   * 2 for a normalized Laplacian), so every boundary is directly
   * comparable. Dividing by (1 − λ[k-1]) instead would collapse near λ≈1
   * and let a 0.01 step in the tail score as strongly as a genuine 0.25
   * jump — i.e. it would "support" splitting off singleton groups. The
   * label is deliberately blunt: a clear gap supports the split, a flat
   * region does not, and the UI shows the raw adjacent values either way.
   *
   * If k is at or beyond the end of the spectrum there is no boundary left
   * to test, so the evidence is `null` rather than a fabricated "not
   * supported" — the component simply cannot be divided further.
   */
  function eigengapEvidence(values, k) {
    if (!values.length || k < 1 || k >= values.length) {
      return { k, lamK: null, lamNext: null, gap: null, score: null, supported: null, label: '无法划分' };
    }
    const lamK = values[k - 1];
    const lamNext = values[k];
    const gap = Math.max(0, lamNext - lamK);
    const range = Math.max(EPS, values[values.length - 1] - values[0]);
    const score = gap / range;
    const label = score >= SUPPORT_THRESHOLD * 3 ? '支持' : score >= SUPPORT_THRESHOLD ? '弱支持' : '不支持';
    return { k, lamK, lamNext, gap, score, range, supported: score >= SUPPORT_THRESHOLD, label };
  }

  function adjacentGaps(values) {
    const gaps = [];
    for (let k = 1; k < values.length; k++) {
      gaps.push({
        k,
        gap: values[k] - values[k - 1],
        evidence: eigengapEvidence(values, k),
      });
    }
    return gaps;
  }

  /* ------------------------------------------------------------------ *
   * 4. Grouping inside a component
   * ------------------------------------------------------------------ */

  /**
   * Spectral grouping (Ng-Jordan-Weiss): take the k smallest eigenvectors
   * of L, row-normalize, k-means. Row normalization keeps high-degree
   * people from dominating the embedding.
   */
  function groupComponent(W, members, k, options) {
    const opts = Object.assign({ seed: 42, restarts: 18 }, options || {});
    const m = members.length;
    // A connected component of m people has m-1 non-trivial eigenvectors,
    // so at most m-1 groups are meaningful; more would just isolate people.
    const kk = Math.max(1, Math.min(k, m - 1));
    const spectrum = laplacianSpectrum(W, members);
    const evidence = eigengapEvidence(spectrum.values, kk);
    if (kk <= 1 || m <= 2) {
      return {
        groups: [members.slice()],
        labels: new Array(m).fill(0),
        spectrum,
        evidence,
        embedding: members.map(() => [0]),
        requestedK: k,
        actualK: 1,
      };
    }
    // NJW embedding: the k smallest eigenvectors. The first is constant
    // inside a connected component, so it contributes no separation; the
    // remaining k-1 coordinates carry the cuts.
    const d = Math.min(kk, m);
    const embedding = spectrum.vectors.map((row) => {
      const coords = row.slice(0, d);
      const norm = Math.sqrt(sum(coords.map((x) => x * x)));
      return norm > EPS ? coords.map((x) => x / norm) : coords;
    });
    const rng = mulberry32(opts.seed);
    const km = kmeans(embedding, kk, rng, opts.restarts);
    const raw = new Map();
    km.labels.forEach((lab, i) => {
      if (!raw.has(lab)) raw.set(lab, []);
      raw.get(lab).push(i);
    });
    const groups = Array.from(raw.values())
      .sort((a, b) => b.length - a.length || a[0] - b[0])
      .map((idxs) => idxs.map((i) => members[i]));
    const labels = new Array(m).fill(0);
    const pos = new Map(members.map((node, i) => [node, i]));
    groups.forEach((g, gi) => g.forEach((node) => (labels[pos.get(node)] = gi)));
    return { groups, labels, spectrum, evidence, embedding, requestedK: k, actualK: groups.length };
  }

  /**
   * Group the whole graph. Each connected component is split separately,
   * so a bridge between blocks (if the bridge matters are excluded) can
   * dissolve a component into several, and those are never grouped
   * together. Isolated people remain singletons and are not divided.
   *
   * `order` is the shared people set used by conversion, matrix and
   * comparison; every returned index points into the same `people` array.
   */
  function groupGraph(W, options) {
    const opts = Object.assign(
      { k: 2, seed: 42, kByComponent: null, excludeNodes: [], order: null },
      options || {}
    );
    const n = W.length;
    const order = opts.order || W.map((_, i) => i);
    if (order.length !== n) throw new Error('order 必须恰好列出全部人员');
    const excluded = new Set(opts.excludeNodes);
    const nodes = order.filter((i) => !excluded.has(i));
    const compInfo = componentsOf(W, nodes);
    const groups = [];
    const groupMeta = [];
    const componentReports = [];
    const clusterOf = new Map();
    const groupOf = new Map();
    for (const comp of compInfo.components) {
      const requested = opts.kByComponent && opts.kByComponent[comp[0]] != null ? opts.kByComponent[comp[0]] : opts.k;
      const maxK = Math.max(1, comp.length - 1);
      const kk = Math.max(1, Math.min(requested, maxK));
      const res = groupComponent(W, comp, kk, opts);
      const start = groups.length;
      res.groups.forEach((g, gi) => {
        groups.push(g);
        groupMeta.push({
          componentSeed: comp[0],
          localIndex: gi,
          componentSize: comp.length,
          requestedK: requested,
          effectiveK: kk,
          evidence: res.evidence,
        });
        g.forEach((node) => {
          clusterOf.set(node, start + gi);
          groupOf.set(node, start + gi);
        });
      });
      componentReports.push({
        members: comp,
        spectrum: res.spectrum,
        evidence: res.evidence,
        groups: res.groups,
        groupIds: res.groups.map((_, i) => start + i),
        seed: comp[0],
        requestedK: requested,
        effectiveK: kk,
        maxK,
        actualK: res.groups.length,
      });
    }
    for (const node of compInfo.isolated) {
      clusterOf.set(node, -1);
      groupOf.set(node, -1);
    }
    return {
      groups,
      groupMeta,
      components: compInfo.components,
      isolated: compInfo.isolated,
      componentReports,
      nodes,
      clusterOf,
      groupOf,
      order,
    };
  }

  /* ------------------------------------------------------------------ *
   * 5. Matching runs by membership overlap
   * ------------------------------------------------------------------ */

  /**
   * Match clusters across two runs by membership, never by cluster number.
   *
   * Overlap table: for each (previous group p, next group q) the number of
   * shared people. From it:
   *  - each next group's parent is its plurality previous group;
   *  - each previous group's dominant child is its plurality next group;
   *  - a previous group is **split** when no single next group inherited
   *    at least 80% of it (maxChildShare < 0.8);
   *  - a next group is **merged** when no single previous group supplied
   *    at least 80% of it (maxParentShare < 0.8).
   * Both can be true at once. A 1-person spill out of a 5-person group is
   * therefore "same (4/5)", not a split; 6/4 and 2/1/1/1 are splits.
   *
   * A person counts as `stable` only when the two plurality relations
   * agree: their old group's dominant child is their new group and that
   * group's parent is their old group. This is membership matching, so a
   * renumbered run that kept the same people reports 100% stable.
   *
   * `prevMembership` maps node -> previous cluster (isolation is -1 or
   * absent and is ignored here; compareRuns handles presence).
   */
  function matchGroups(prevGroups, nextGroups, prevMembership) {
    const prevSets = prevGroups.map((g) => new Set(g));
    const nextSets = nextGroups.map((g) => new Set(g));
    const pairs = [];
    for (let q = 0; q < nextGroups.length; q++) {
      for (let p = 0; p < prevGroups.length; p++) {
        let overlap = 0;
        for (const m of nextSets[q]) if (prevSets[p].has(m)) overlap++;
        if (!overlap) continue;
        pairs.push({
          p,
          q,
          overlap,
          shareOfNext: overlap / nextGroups[q].length,
          shareOfPrev: overlap / prevGroups[p].length,
        });
      }
    }

    const parentOf = nextGroups.map(() => -1);
    const parentOverlap = nextGroups.map(() => 0);
    for (const pair of pairs) {
      if (pair.overlap > parentOverlap[pair.q]) {
        parentOverlap[pair.q] = pair.overlap;
        parentOf[pair.q] = pair.p;
      }
    }
    const dominantChild = prevGroups.map(() => -1);
    const dominantShare = prevGroups.map(() => 0);
    for (const pair of pairs) {
      if (pair.shareOfPrev > dominantShare[pair.p]) {
        dominantShare[pair.p] = pair.shareOfPrev;
        dominantChild[pair.p] = pair.q;
      }
    }
    const INHERIT = 0.8;
    const split = prevGroups.map((_, p) => dominantShare[p] < INHERIT);
    const merged = nextGroups.map((_, q) => {
      if (parentOf[q] < 0) return false;
      return parentOverlap[q] / nextGroups[q].length < INHERIT;
    });

    const records = nextGroups.map((members, q) => {
      const parent = parentOf[q];
      const parentSplit = parent >= 0 && split[parent];
      const oldParents = pairs
        .filter((x) => x.q === q && x.shareOfNext >= 0.1)
        .sort((a, b) => b.overlap - a.overlap);
      let relation = 'same';
      if (parent < 0) relation = 'new';
      else if (parentSplit && merged[q]) relation = 'split+merge';
      else if (parentSplit) relation = 'split';
      else if (merged[q]) relation = 'merge';
      return {
        q,
        parent,
        overlapWithParent: parentOverlap[q],
        shareOfParent: parent >= 0 ? parentOverlap[q] / prevGroups[parent].length : 0,
        shareOfGroup: parent >= 0 ? parentOverlap[q] / members.length : 0,
        prevOverlaps: pairs.filter((x) => x.q === q).sort((a, b) => b.overlap - a.overlap),
        otherParents: oldParents.filter((x) => x.p !== parent),
        relation,
        parentSplit,
        siblingChildren:
          parent >= 0
            ? pairs
                .filter((x) => x.p === parent && x.q !== q)
                .sort((a, b) => b.overlap - a.overlap)
                .map((x) => x.q)
            : [],
        mergedFrom: oldParents.filter((x) => x.p !== parent).map((x) => x.p),
        members: members.slice(),
        size: members.length,
      };
    });

    const personStatus = new Map();
    const personDetail = new Map();
    if (prevMembership) {
      for (let q = 0; q < nextGroups.length; q++) {
        for (const m of nextGroups[q]) {
          const prev = prevMembership.get(m);
          let status;
          if (prev == null || prev < 0) status = 'new';
          else if (parentOf[q] < 0) status = 'moved';
          else if (parentOf[q] === prev && dominantChild[prev] === q) status = 'stable';
          else status = 'moved';
          personStatus.set(m, status);
          personDetail.set(m, {
            prev,
            next: q,
            stable: status === 'stable',
            status,
          });
        }
      }
    }

    return {
      records,
      pairs,
      parentOf,
      dominantChild,
      split,
      merged,
      personStatus,
      personDetail,
    };
  }

  /**
   * Compare two runs of the same people set (typically before vs after
   * excluding a large matter). Matching happens first; then we can ask
   * which *pairs* stayed together and which people were stable, instead of
   * comparing cluster numbers, which are arbitrary per run.
   */
  function compareRuns(prev, next, options) {
    const opts = Object.assign({ nodeCount: null }, options || {});
    const matched = matchGroups(prev.groups, next.groups, prev.clusterOf);
    const n = opts.nodeCount || prev.order.length;
    const nodeSet = [];
    for (let i = 0; i < n; i++) nodeSet.push(i);
    const prevOf = prev.clusterOf;
    const nextOf = next.clusterOf;

    const togetherPairs = [];
    const nodeRecords = [];
    for (const m of nodeSet) {
      const oldGroup = prevOf.has(m) ? prevOf.get(m) : -1;
      const newGroup = nextOf.has(m) ? nextOf.get(m) : -1;
      const detail = matched.personDetail.get(m);
      let status;
      if (oldGroup < 0 && newGroup < 0) status = 'isolated';
      else if (oldGroup < 0) status = 'entered';
      else if (newGroup < 0) status = 'left';
      else if (detail && detail.stable) status = 'stable';
      else status = 'moved';
      nodeRecords.push({
        node: m,
        prevGroup: oldGroup < 0 ? null : oldGroup,
        nextGroup: newGroup < 0 ? null : newGroup,
        status,
      });
    }

    // Pair persistence: "stayed together" is a question about people who
    // were grouped before and are grouped after, and it is answered by
    // membership, not by group numbers.
    const prevPair = new Map();
    for (let a = 0; a < n; a++) {
      const ga = prevOf.get(a);
      if (ga == null || ga < 0) continue;
      for (let b = a + 1; b < n; b++) {
        const gb = prevOf.get(b);
        if (gb == null || gb < 0 || gb !== ga) continue;
        prevPair.set(pairKey(a, b), { a, b });
      }
    }
    for (const [key, { a, b }] of prevPair) {
      const ga = nextOf.get(a);
      const gb = nextOf.get(b);
      const kept = ga != null && ga >= 0 && ga === gb;
      togetherPairs.push({ a, b, key, kept });
    }
    const kept = togetherPairs.filter((p) => p.kept).length;
    return {
      matched,
      nodeRecords,
      nodeStatus: new Map(nodeRecords.map((r) => [r.node, r.status])),
      togetherPairs,
      togetherCount: { total: togetherPairs.length, kept, lost: togetherPairs.length - kept },
      summary: {
        stable: nodeRecords.filter((r) => r.status === 'stable').length,
        moved: nodeRecords.filter((r) => r.status === 'moved').length,
        entered: nodeRecords.filter((r) => r.status === 'entered').length,
        left: nodeRecords.filter((r) => r.status === 'left').length,
        isolated: nodeRecords.filter((r) => r.status === 'isolated').length,
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. Weight perturbation
   * ------------------------------------------------------------------ */

  /**
   * Multiply every existing pair weight by an independent random factor in
   * [1-σ, 1+σ] and regroup. Only positive weights are perturbed, so the
   * component structure and the zero-degree people are untouched.
   *
   * A person is reported unstable when their membership does not survive
   * the same plurality matching used between runs; the result carries the
   * rate, so the UI can say "unstable" instead of printing a department
   * name for them.
   */
  function perturbWeights(W, options) {
    const opts = Object.assign(
      {
        sigma: 0.08,
        trials: 40,
        seed: 2024,
        k: 2,
        kByComponent: null,
        base: null,
        order: null,
        unstableThreshold: 0.2,
      },
      options || {}
    );
    const n = W.length;
    const order = opts.order || W.map((_, i) => i);
    if (!n) {
      return { trials: [], history: [], stability: [], unstable: [], stable: [], base: null, threshold: opts.unstableThreshold };
    }
    const base =
      opts.base ||
      groupGraph(W, { k: opts.k, seed: opts.seed, kByComponent: opts.kByComponent, order });
    const rng = mulberry32(opts.seed);
    const changeCount = new Array(n).fill(0);
    const history = [];

    for (let t = 0; t < opts.trials; t++) {
      const Wp = zeros(n, n);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const w = W[i][j];
          if (w <= EPS) continue;
          const factor = 1 + (rng() * 2 - 1) * opts.sigma;
          const v = Math.max(0, w * factor);
          Wp[i][j] = v;
          Wp[j][i] = v;
        }
      }
      const res = groupGraph(Wp, {
        k: opts.k,
        seed: opts.seed,
        kByComponent: opts.kByComponent,
        order,
      });
      // Only people who were grouped in the baseline are in question;
      // isolated people have no label to lose. The matching is the same
      // membership test used between runs.
      const matched = matchGroups(
        base.groups,
        res.groups,
        base.clusterOf
      );
      let changed = 0;
      for (const [node, detail] of matched.personDetail) {
        const baseGroup = base.clusterOf.get(node);
        if (baseGroup == null || baseGroup < 0) continue;
        if (!detail.stable) {
          changeCount[node]++;
          changed++;
        }
      }
      history.push({ index: t, groupCount: res.groups.length, changed });
    }

    const stability = [];
    for (let i = 0; i < n; i++) {
      const baseGroup = base.clusterOf.get(i);
      const rate = opts.trials ? changeCount[i] / opts.trials : 0;
      stability.push({
        node: i,
        changes: changeCount[i],
        rate,
        grouped: baseGroup != null && baseGroup >= 0,
        stable: rate < opts.unstableThreshold,
      });
    }
    return {
      trials: opts.trials,
      history,
      stability,
      unstable: stability.filter((s) => !s.stable),
      stable: stability.filter((s) => s.stable),
      base,
      threshold: opts.unstableThreshold,
    };
  }

  return {
    EPS,
    SUPPORT_THRESHOLD,
    mulberry32,
    buildGraph,
    matrixFromMatters,
    pairShare,
    transformShare,
    excludeMatters,
    componentsOf,
    laplacianSpectrum,
    eigengapEvidence,
    adjacentGaps,
    groupComponent,
    groupGraph,
    matchGroups,
    compareRuns,
    perturbWeights,
    jacobiEigen,
    median,
    uniqStrings,
    pairKey,
  };
});
