/* ------------------------------------------------------------------ *
 * CoFocus app — renders the analysis produced by core.js.
 *
 * Nothing here re-implements the maths: grouping, matching and
 * perturbation all come from CoFocus.*, so the page and the tests agree.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const C = window.CoFocus;
  const SAMPLE = window.COFOCUS_SAMPLE;

  const GROUP_COLOR_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'];
  const GROUP_NAMES = ['蓝组', '黄组', '粉组', '绿组'];

  const state = {
    events: [],
    options: {
      pairRule: 'per-matter',
      pairTransform: 'sqrt',
      duplicatePolicy: 'first',
    },
    k: 5,
    componentIndex: 0,
    selection: null, // {kind:'edge'|'person', a, b}
    excluded: new Set(),
    compareEnabled: true,
    sigma: 0.1,
    trials: 80,
    perturbSeed: 2024,
    theme: 'light',
    overviewMode: 'map',
    useSampleRoster: true,
    excludedInit: false,
  };

  let graph = null;
  let grouping = null;
  let afterGraph = null;
  let afterGrouping = null;
  let comparison = null;
  let afterLabelById = new Map();
  let stability = null;
  let layout = null;
  let bridgeOf = new Map();
  let unstableOf = new Map();

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ------------------------------------------------------------------ *
   * Formatting helpers
   * ------------------------------------------------------------------ */

  function fmt(x, digits) {
    if (x == null || !Number.isFinite(x)) return '—';
    return x.toFixed(digits == null ? 2 : digits);
  }
  function pct(x) {
    if (x == null || !Number.isFinite(x)) return '—';
    return (x * 100).toFixed(0) + '%';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /* The palette has exactly four validated categorical hues. A fifth
   * group inside one component therefore gets a *composite* encoding —
   * neutral fill + diagonal hatch + direct label — rather than a recycled
   * hue that would collide with group 1. This is the documented "no cycled
   * categorical colour" rule, made visible. */
  const HATCH_LIMIT = 4;

  function colorOf(localIndex) {
    return localIndex < HATCH_LIMIT ? `var(${GROUP_COLOR_VARS[localIndex]})` : 'var(--ink-2)';
  }
  function isHatched(localIndex) {
    return localIndex >= HATCH_LIMIT;
  }
  function groupName(localIndex) {
    return localIndex < HATCH_LIMIT ? GROUP_NAMES[localIndex] : `第 ${localIndex + 1} 组`;
  }
  function groupLabel(localIndex, ordinal) {
    return ordinal == null ? groupName(localIndex) : `块 ${ordinal} · ${groupName(localIndex)}`;
  }
  function componentOrdinalOf(groupId, which) {
    const rep = which.componentReports.findIndex((r) => r.groupIds.includes(groupId));
    return rep < 0 ? null : rep + 1;
  }
  function labelForGroupId(groupId, which) {
    const meta = which.groupMeta[groupId];
    if (!meta) return '—';
    return groupLabel(meta.localIndex, componentOrdinalOf(groupId, which));
  }
  function swatchStyle(localIndex) {
    if (!isHatched(localIndex)) return `background:${colorOf(localIndex)}`;
    return 'background:repeating-linear-gradient(45deg, var(--ink-2) 0 1.5px, var(--surface-1) 1.5px 4.5px);border:1px solid var(--ink-2)';
  }
  function peopleNames(idxs) {
    return idxs.map((i) => graph.people[i]);
  }
  function namesInline(idxs, max) {
    const names = peopleNames(idxs);
    if (max && names.length > max) return names.slice(0, max).join('、') + ` 等 ${names.length} 人`;
    return names.join('、');
  }

  /* ------------------------------------------------------------------ *
   * Data import
   * ------------------------------------------------------------------ */

  function sampleToPaste() {
    return SAMPLE.matters
      .map((m) => [m.id, m.title || '', m.year == null ? '' : m.year, m.weight == null ? '' : m.weight, m.people.join(', ')].join(' | '))
      .join('\n');
  }

  function parsePaste(text) {
    const lines = text.split(/\r?\n/);
    const events = [];
    const errors = [];
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      let id;
      let title;
      let year;
      let weight;
      let peoplePart;
      if (line.includes('|')) {
        const segs = line.split('|').map((s) => s.trim());
        id = segs[0];
        if (segs.length === 2) {
          peoplePart = segs[1];
        } else if (segs.length === 3) {
          title = segs[1];
          peoplePart = segs[2];
        } else if (segs.length === 4) {
          title = segs[1];
          year = segs[2];
          peoplePart = segs[3];
        } else {
          id = segs[0];
          title = segs[1];
          year = segs[2];
          weight = segs[3];
          peoplePart = segs.slice(4).join(' | ');
        }
      } else {
        const segs = line.split(/[,，、;\t]/).map((s) => s.trim()).filter(Boolean);
        id = segs[0];
        peoplePart = segs.slice(1).join(',');
      }
      const people = String(peoplePart || '')
        .split(/[,，、;\t]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!id) {
        errors.push(`第 ${i + 1} 行缺少事项编号`);
        return;
      }
      events.push({ id, title, year, weight, people });
    });
    return { events, errors };
  }

  function importPaste() {
    const { events, errors } = parsePaste($('#paste-input').value);
    const resultEl = $('#import-result');
    if (!events.length) {
      resultEl.textContent = errors[0] || '没有读到任何事项';
      resultEl.className = 'row-note is-error';
      return;
    }
    state.events = events;
    state.excluded = new Set();
    state.excludedInit = false;
    state.selection = null;
    state.useSampleRoster = false;
    rebuild();
    // core.js rejects rows it cannot normalize (fewer than two distinct
    // people, bad year/weight, empty id). Report those rather than claiming
    // a clean import — they are counted in stats.invalidDropped and shown
    // in the stats strip.
    const rejected = graph.stats.invalidDropped;
    resultEl.className = rejected ? 'row-note is-error' : 'row-note';
    const parts = [`导入 ${events.length} 行`];
    if (errors.length) parts.push(`${errors.length} 行在解析阶段被跳过`);
    if (rejected) parts.push(`${rejected} 行因人员不足或字段无效被忽略`);
    resultEl.textContent = parts.join('，');
  }

  function loadSample() {
    state.events = SAMPLE.matters.slice();
    state.excluded = new Set();
    state.excludedInit = false;
    state.selection = null;
    state.useSampleRoster = true;
    $('#paste-input').value = sampleToPaste();
    $('#import-result').textContent = '';
    $('#import-result').className = 'row-note';
    rebuild();
  }

  /* ------------------------------------------------------------------ *
   * Build + derived views
   * ------------------------------------------------------------------ */

  function rebuild() {
    graph = C.buildGraph(state.events, {
      roster: state.useSampleRoster ? SAMPLE.people : [],
      pairRule: state.options.pairRule,
      pairTransform: state.options.pairTransform,
      duplicatePolicy: state.options.duplicatePolicy,
    });
    const order = graph.W.map((_, i) => i);
    const kBy = allocateK(graph.W, order, state.k);

    grouping = C.groupGraph(graph.W, { k: state.k, kByComponent: kBy, order });

    // Default exclusion: among the large matters, the one whose removal
    // changes the connected structure the most (X-01 in the sample — the
    // 10-person cross-team event that is the supply group's only bridge).
    // Naming the largest matter by headcount alone would pick the 13-person
    // all-hands, which is duplicated and changes nothing. The picker shows
    // the choice; toggling it off is allowed.
    if (!state.excludedInit) {
      const pick = pickDefaultExclusion();
      if (pick) state.excluded.add(pick);
      state.excludedInit = true;
    }
    state.excluded.forEach((id) => {
      if (!graph.matters.some((m) => m.id === id)) state.excluded.delete(id);
    });

    afterGraph = C.excludeMatters(graph, Array.from(state.excluded));
    afterGrouping = C.groupGraph(afterGraph.W, {
      k: state.k,
      kByComponent: allocateK(afterGraph.W, order, state.k),
      order,
    });
    comparison = C.compareRuns(grouping, afterGrouping, { nodeCount: graph.people.length });

    bridgeOf = computeBridges();
    runPerturbation();

    layout = computeLayout();

    renderAll();
  }

  /**
   * How the single slider maps onto several connected components.
   *
   * The slider sets the target group count for the **largest** component.
   * Every other component gets a proportional share of the same density:
   * k_i = round(k · m_i / m_max), floored at 1 and capped at m_i − 1.
   * Without this, a detached 5-person team would be sliced into 5
   * singletons — which changes group *numbers* without saying anything
   * about collaboration. With it, the slider means "how finely do we cut
   * the data", and small blocks simply cannot be cut as finely.
   */
  function allocateK(W, order, k) {
    const comps = C.componentsOf(W, order);
    const maxSize = Math.max(1, ...comps.components.map((c) => c.length));
    const map = {};
    for (const comp of comps.components) {
      const share = Math.round((k * comp.length) / maxSize);
      map[comp[0]] = Math.max(1, Math.min(share, comp.length - 1, k));
    }
    return map;
  }

  /**
   * Which large matter should the comparison exclude by default? Not the
   * biggest by headcount — a duplicated all-hands may change nothing. The
   * useful one is the matter whose removal most changes the *structure*:
   * we count component-count change plus people who become isolated or
   * change component. Ties go to the larger matter.
   */
  function pickDefaultExclusion() {
    const order = graph.W.map((_, i) => i);
    const baseComps = C.componentsOf(graph.W, order);
    const baseOf = new Map();
    baseComps.components.forEach((comp, ci) => comp.forEach((n) => baseOf.set(n, ci)));
    let best = null;
    let bestScore = 0;
    for (const m of graph.matters) {
      if (m.m < 4) continue;
      const after = C.componentsOf(C.excludeMatters(graph, [m.id]).W, order);
      let score = Math.max(0, after.components.length - baseComps.components.length) * 6;
      const afterOf = new Map();
      after.components.forEach((comp, ci) => comp.forEach((n) => afterOf.set(n, ci)));
      for (const node of m.memberIdx) {
        const a = baseOf.get(node);
        const b = afterOf.get(node);
        if (a !== b) score += b == null ? 2 : 1;
      }
      if (score > bestScore || (score === bestScore && best && m.m > best.m)) {
        bestScore = score;
        best = m;
      }
    }
    if (best) return best.id;
    const largest = graph.matters.slice().sort((a, b) => b.m - a.m || a.id.localeCompare(b.id))[0];
    return largest ? largest.id : null;
  }

  function recomputeGroupsOnly() {
    const order = graph.W.map((_, i) => i);
    const kBy = allocateK(graph.W, order, state.k);
    grouping = C.groupGraph(graph.W, { k: state.k, kByComponent: kBy, order });
    afterGrouping = C.groupGraph(afterGraph.W, {
      k: state.k,
      kByComponent: allocateK(afterGraph.W, order, state.k),
      order,
    });
    comparison = C.compareRuns(grouping, afterGrouping, { nodeCount: graph.people.length });
    bridgeOf = computeBridges();
    runPerturbation();
    layout = computeLayout();
    renderGroups();
    renderCompare();
    renderStability();
    renderOverview();
  }

  function recomputeComparison() {
    const order = graph.W.map((_, i) => i);
    afterGraph = C.excludeMatters(graph, Array.from(state.excluded));
    afterGrouping = C.groupGraph(afterGraph.W, {
      k: state.k,
      kByComponent: allocateK(afterGraph.W, order, state.k),
      order,
    });
    comparison = C.compareRuns(grouping, afterGrouping, { nodeCount: graph.people.length });
    layout = computeLayout();
    renderCompare();
    renderOverview();
  }

  function runPerturbation() {
    const order = graph.W.map((_, i) => i);
    stability = C.perturbWeights(graph.W, {
      k: state.k,
      kByComponent: allocateK(graph.W, order, state.k),
      order,
      base: grouping,
      sigma: state.sigma,
      trials: state.trials,
      seed: state.perturbSeed,
      unstableThreshold: 0.2,
    });
    unstableOf = new Map();
    stability.stability.forEach((s) => {
      if (!s.stable && s.grouped) unstableOf.set(s.node, s);
    });
  }

  /**
   * A bridge person is one whose weight is not dominated by a single
   * group: their *second* strongest group carries at least 60% of the
   * weight of their own group. Using "any weight outside the own group"
   * instead would flag almost everyone in a graph with a big cross-team
   * matter — the weight naturally touches three or four groups — and a
   * label on 15 of 27 people is not a hint, it is noise. The second/own
   * ratio picks out the people who genuinely live between blocks. It is a
   * display hint only: it never changes the grouping.
   */
  function computeBridges() {
    const out = new Map();
    const groupOfNode = grouping.clusterOf;
    graph.people.forEach((_, i) => {
      const own = groupOfNode.get(i);
      if (own == null || own < 0) return;
      const byGroup = new Map();
      let total = 0;
      for (let j = 0; j < graph.people.length; j++) {
        if (i === j) continue;
        const w = graph.W[i][j];
        if (w <= 0) continue;
        total += w;
        const gj = groupOfNode.get(j);
        if (gj == null || gj < 0) continue;
        byGroup.set(gj, (byGroup.get(gj) || 0) + w);
      }
      if (total <= 0) return;
      let ownW = byGroup.get(own) || 0;
      let second = 0;
      for (const [gj, w] of byGroup) if (gj !== own && w > second) second = w;
      // Compare the second group to the strongest one, not to the total:
      // "weight is split between two groups" is the bridge signature. A
      // second group that is small next to the first is just a normal
      // cross-team link.
      if (ownW > 0 && second >= 0.6 * ownW) out.set(i, second / ownW);
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Layout: per-component force-directed, then packed
   * ------------------------------------------------------------------ */

  function frLayout(members, W, seed, box) {
    const m = members.length;
    const rng = C.mulberry32(seed);
    const pos = new Map();
    const local = members.map((node) => ({ node, x: 0, y: 0, vx: 0, vy: 0 }));
    const radius = box * 0.34;
    local.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / m + rng() * 0.25;
      p.x = Math.cos(angle) * radius * (0.7 + rng() * 0.3);
      p.y = Math.sin(angle) * radius * (0.7 + rng() * 0.3);
    });
    const k = box / Math.max(3, Math.sqrt(m));
    const posOf = new Map(local.map((p) => [p.node, p]));
    const iterations = m > 18 ? 420 : 300;
    for (let it = 0; it < iterations; it++) {
      const temp = box * 0.09 * (1 - it / iterations) + box * 0.004;
      for (const a of local) {
        a.vx = 0;
        a.vy = 0;
      }
      for (let i = 0; i < m; i++) {
        for (let j = i + 1; j < m; j++) {
          const a = local[i];
          const b = local[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d = Math.hypot(dx, dy);
          if (d < 0.01) {
            dx = (rng() - 0.5) * 0.1;
            dy = (rng() - 0.5) * 0.1;
            d = 0.1;
          }
          const force = (k * k) / d;
          a.vx += (dx / d) * force;
          a.vy += (dy / d) * force;
          b.vx -= (dx / d) * force;
          b.vy -= (dy / d) * force;
        }
      }
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
          if (i === j) continue;
          const a = local[i];
          const b = local[j];
          const w = W[a.node][b.node];
          if (w <= 0) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.max(0.1, Math.hypot(dx, dy));
          // Log compression keeps one very heavy edge from folding the map.
          const force = (Math.log1p(w * 4) * d * d) / k;
          a.vx -= (dx / d) * force;
          a.vy -= (dy / d) * force;
        }
      }
      for (const a of local) {
        const mag = Math.hypot(a.vx, a.vy);
        if (mag > 0) {
          a.x += (a.vx / mag) * Math.min(mag, temp);
          a.y += (a.vy / mag) * Math.min(mag, temp);
        }
        // Soft circular boundary.
        const r = Math.hypot(a.x, a.y);
        const limit = box * 0.46;
        if (r > limit) {
          a.x = (a.x / r) * limit;
          a.y = (a.y / r) * limit;
        }
      }
    }
    local.forEach((p) => pos.set(p.node, { x: p.x, y: p.y }));
    return { pos, posOf };
  }

  function computeLayout() {
    const totalWidth = 900;
    const pad = 30;
    const nodes = new Map();
    const compBoxes = [];
    let cursorX = pad;
    let cursorY = pad;
    let rowHeight = 0;

    const comps = grouping.componentReports.map((rep) => ({ rep })).sort((a, b) => b.rep.members.length - a.rep.members.length);
    comps.forEach(({ rep }, ci) => {
      const m = rep.members.length;
      // One-person-per-screen-space sizing, with a smooth curve so 2- and
      // 25-person blocks stay legible side by side without the big one
      // swallowing the row.
      const box = Math.max(170, Math.min(540, 42 * Math.sqrt(m) * 2.6 + 60));
      const { pos } = frLayout(rep.members, graph.W, 101 + ci * 17, box);
      if (cursorX + box > totalWidth - pad) {
        cursorX = pad;
        cursorY += rowHeight + 26;
        rowHeight = 0;
      }
      const cx = cursorX + box / 2;
      const cy = cursorY + box / 2;
      rep.members.forEach((node) => {
        const p = pos.get(node);
        const local = grouping.clusterOf.get(node) - rep.groupIds[0];
        nodes.set(node, {
          node,
          x: cx + p.x,
          y: cy + p.y,
          componentSeed: rep.seed,
          local,
        });
      });
      compBoxes.push({
        seed: rep.seed,
        x: cursorX,
        y: cursorY,
        w: box,
        h: box,
        members: rep.members,
        index: grouping.componentReports.indexOf(rep),
      });
      cursorX += box + 26;
      rowHeight = Math.max(rowHeight, box);
    });

    let isoY = cursorY + rowHeight + 30;
    const isolatedNodes = [];
    grouping.isolated.forEach((node, i) => {
      const x = pad + 30 + (i % 12) * 46;
      const y = isoY + Math.floor(i / 12) * 46;
      isolatedNodes.push({ node, x, y });
    });
    const height = isoY + Math.ceil(grouping.isolated.length / 12) * 46 + 34;

    // Degree for sizing.
    const degree = graph.W.map((row) => row.reduce((s, w) => s + (w > 0 ? w : 0), 0));
    const maxDegree = Math.max(1e-9, ...degree);

    const edges = [];
    for (let i = 0; i < graph.people.length; i++) {
      for (let j = i + 1; j < graph.people.length; j++) {
        const w = graph.W[i][j];
        if (w <= C.EPS) continue;
        if (!nodes.has(i) || !nodes.has(j)) continue;
        edges.push({ a: i, b: j, w });
      }
    }
    edges.sort((a, b) => a.w - b.w);
    const maxW = Math.max(1e-9, ...edges.map((e) => e.w));

    return {
      width: totalWidth,
      height,
      nodes,
      isolatedNodes,
      edges,
      maxW,
      degree,
      maxDegree,
      compBoxes,
    };
  }

  /* ------------------------------------------------------------------ *
   * Render: stats + overview
   * ------------------------------------------------------------------ */

  function renderStats() {
    const s = graph.stats;
    const items = [
      ['事项', s.matters],
      ['人员', s.people],
      ['关系', s.pairs],
      ['连通块', grouping.components.length],
      ['孤立人员', grouping.isolated.length],
      ['重复导入（已忽略）', s.duplicatesDropped],
    ];
    if (s.invalidDropped) items.push(['无效行（已忽略）', s.invalidDropped]);
    $('#stats-strip').innerHTML = items
      .map(
        ([label, value]) =>
          `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${esc(label)}</span></div>`
      )
      .join('');
  }

  function renderOverview() {
    renderStats();
    renderComponentsTile();
    renderIsolatedTile();
    renderGraph();
    renderTrace();
  }

  function renderComponentsTile() {
    const host = $('#tile-components');
    if (!grouping.components.length) {
      host.innerHTML = '<h3>连通块</h3><p class="empty-hint">没有形成任何关系。</p>';
      return;
    }
    const rows = grouping.componentReports
      .map((rep) => {
        const internal = rep.members.reduce((s, i) => {
          let d = 0;
          for (const j of rep.members) if (i !== j) d += graph.W[i][j];
          return s + d / 2;
        }, 0);
        const names = rep.members.slice(0, 3).map((i) => graph.people[i]).join('、');
        const more = rep.members.length > 3 ? ' …' : '';
        return `<div class="comp-row"><span class="nm">${rep.members.length} 人 · ${esc(names + more)}</span><span class="mt">${fmt(internal, 1)} 关系权重</span></div>`;
      })
      .join('');
    host.innerHTML = `<h3>连通块（${grouping.components.length}）</h3>${rows}`;
  }

  function renderIsolatedTile() {
    const host = $('#tile-isolated');
    if (!grouping.isolated.length) {
      host.innerHTML = '<h3>孤立人员</h3><p class="empty-hint">所有人员至少参与过一次共同事项。</p>';
      return;
    }
    host.innerHTML =
      '<h3>孤立人员（' +
      grouping.isolated.length +
      '）</h3><div class="chip-wrap">' +
      grouping.isolated
        .map((node) => `<span class="chip chip-static">${esc(graph.people[node])}</span>`)
        .join('') +
      '</div><p class="small-note">没有共同事项记录。保留在人员集合中，但不参与分组，也不参与任何按度数归一化的计算。</p>';
  }

  /**
   * Pick a spot for every name so the map stays readable. Nodes are drawn in a
   * force layout, so a fixed "below the dot" label inevitably collides in a
   * 25-person block. Try a handful of candidate positions per node, highest
   * degree first, and drop the label when nothing fits — the node keeps its
   * tooltip and its listing in the group cards, and the legend stays honest.
   */
  function placeLabels(nodeList) {
    const placed = new Map();
    const boxes = [];
    const circles = nodeList.map((n) => ({ x: n.x, y: n.y, r: n.r + 2.5 }));
    const overlapsBox = (b) =>
      boxes.some((o) => !(b.x2 <= o.x1 || b.x1 >= o.x2 || b.y2 <= o.y1 || b.y1 >= o.y2));
    const overlapsCircle = (b) =>
      circles.some((c) => {
        const nx = Math.max(b.x1, Math.min(c.x, b.x2));
        const ny = Math.max(b.y1, Math.min(c.y, b.y2));
        return Math.hypot(nx - c.x, ny - c.y) < c.r;
      });
    nodeList.forEach((n) => {
      const name = graph.people[n.node];
      const w = name.length * 10.6 + 4;
      const h = 12;
      const r = n.r;
      const candidates = [
        { cx: n.x, cy: n.y + r + 4 + h / 2, anchor: 'middle' },
        { cx: n.x, cy: n.y - r - 4 - h / 2, anchor: 'middle' },
        { cx: n.x + r + 4 + w / 2, cy: n.y + 3, anchor: 'middle' },
        { cx: n.x - r - 4 - w / 2, cy: n.y + 3, anchor: 'middle' },
        { cx: n.x + r * 0.7 + w / 2, cy: n.y - r * 0.7 - 2, anchor: 'middle' },
        { cx: n.x - r * 0.7 - w / 2, cy: n.y - r * 0.7 - 2, anchor: 'middle' },
        { cx: n.x + r * 0.7 + w / 2, cy: n.y + r * 0.7 + 12, anchor: 'middle' },
        { cx: n.x - r * 0.7 - w / 2, cy: n.y + r * 0.7 + 12, anchor: 'middle' },
      ];
      for (const c of candidates) {
        const b = { x1: c.cx - w / 2, x2: c.cx + w / 2, y1: c.cy - h / 2, y2: c.cy + h / 2 };
        if (overlapsBox(b) || overlapsCircle(b)) continue;
        boxes.push(b);
        placed.set(n.node, { x: c.cx, y: c.cy + 3.6, anchor: c.anchor });
        return;
      }
    });
    return placed;
  }

  function renderGraph() {
    if (!layout) return;
    const svg = $('#graph-svg');
    const listView = state.overviewMode === 'components';
    // SVGElement has no `hidden` IDL attribute — setting the property would
    // only create an expando and leave the map on screen.
    svg.toggleAttribute('hidden', listView);
    $('#components-view').hidden = !listView;
    svg.closest('.graph-wrap').classList.toggle('is-list', listView);
    if (listView) {
      $('#graph-legend').hidden = true;
      $('#graph-tooltip').hidden = true;
      renderComponentsView();
      return;
    }
    $('#graph-legend').hidden = false;
    const { width, height, nodes, isolatedNodes, edges, maxW, degree, maxDegree } = layout;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const parts = [];
    parts.push(`<defs>
      <filter id="node-shadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="rgba(0,0,0,0.22)"/>
      </filter>
      <pattern id="hatch-fill" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill="var(--surface-1)"></rect>
        <rect width="2.4" height="6" fill="var(--ink-2)"></rect>
      </pattern>
    </defs>`);

    // Component hulls.
    layout.compBoxes.forEach((box) => {
      const rep = grouping.componentReports.find((r) => r.seed === box.seed);
      const actual = box.members.length;
      parts.push(
        `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="16" fill="var(--surface-2)" opacity="0.55" stroke="var(--hairline)" stroke-dasharray="2 5"></rect>`
      );
      parts.push(
        `<text x="${box.x + 12}" y="${box.y + 19}" class="hull-label">连通块 · ${actual} 人${rep && rep.effectiveK < rep.requestedK ? ` · 最多 ${rep.maxK} 组` : ''}</text>`
      );
    });

    // Isolated strip.
    if (isolatedNodes.length) {
      const minX = Math.min(...isolatedNodes.map((n) => n.x)) - 22;
      const maxX = Math.max(...isolatedNodes.map((n) => n.x)) + 26;
      const minY = Math.min(...isolatedNodes.map((n) => n.y)) - 24;
      parts.push(
        `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="48" rx="12" fill="none" stroke="var(--hairline)" stroke-dasharray="2 5"></rect>`
      );
      parts.push(`<text x="${minX + 8}" y="${minY + 15}" class="hull-label">孤立人员</text>`);
    }

    // Edges.
    edges.forEach((e) => {
      const a = nodes.get(e.a);
      const b = nodes.get(e.b);
      if (!a || !b) return;
      const sel = state.selection;
      const isSel =
        sel && sel.kind === 'edge' && ((sel.a === e.a && sel.b === e.b) || (sel.a === e.b && sel.b === e.a));
      const touchesSel =
        sel && sel.kind === 'person' && (sel.a === e.a || sel.a === e.b);
      const dim = sel && !isSel && !touchesSel;
      const widthPx = 0.55 + 3.1 * Math.sqrt(e.w / maxW);
      const opacity = isSel ? 0.95 : dim ? 0.1 : 0.32;
      const color = isSel ? 'var(--ink-1)' : 'var(--ink-3)';
      parts.push(
        `<line class="edge-hit" data-a="${e.a}" data-b="${e.b}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="transparent" stroke-width="${Math.max(10, widthPx + 8)}"></line>`,
        `<line class="edge-line" data-a="${e.a}" data-b="${e.b}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="${widthPx}" stroke-opacity="${opacity}" stroke-linecap="round"></line>`
      );
    });

    // Nodes.
    const order = Array.from(nodes.values()).sort((a, b) => b.node - a.node);
    const sized = order.map((n) => ({
      ...n,
      r: 6.2 + 7.2 * Math.sqrt((degree[n.node] || 0) / maxDegree),
    }));
    const rank = (n) => (bridgeOf.has(n.node) ? 2 : 0) + (unstableOf.has(n.node) ? 1 : 0);
    const labelSpots = placeLabels(
      sized
        .slice()
        .sort((a, b) => rank(b) - rank(a) || degree[b.node] - degree[a.node] || a.node - b.node)
    );
    sized.forEach((n) => {
      const meta = grouping.groupMeta[grouping.clusterOf.get(n.node)];
      const local = meta ? meta.localIndex : 0;
      const color = colorOf(local);
      const unstable = unstableOf.has(n.node);
      const bridge = bridgeOf.has(n.node);
      const r = n.r;
      const sel = state.selection;
      const isSel = sel && ((sel.kind === 'person' && sel.a === n.node) || (sel.kind === 'edge' && (sel.a === n.node || sel.b === n.node)));
      const dim = sel && !isSel;
      const extra = isHatched(local)
        ? `<circle cx="${n.x}" cy="${n.y}" r="${r + 3.4}" fill="none" stroke="var(--ink-2)" stroke-dasharray="2 3" stroke-width="1.3"></circle>`
        : '';
      const unstableRing = unstable
        ? `<circle cx="${n.x}" cy="${n.y}" r="${r + 2.4}" fill="none" stroke="var(--warning)" stroke-width="2"></circle>`
        : '';
      const spot = labelSpots.get(n.node);
      const label = spot
        ? `<text x="${fmt(spot.x, 1)}" y="${fmt(spot.y, 1)}" text-anchor="${spot.anchor}" class="node-label" ${
            dim ? 'opacity="0.35"' : ''
          }>${esc(graph.people[n.node])}${bridge ? '*' : ''}</text>`
        : '';
      parts.push(
        `<g class="node" data-node="${n.node}" tabindex="0" role="button" aria-label="${esc(graph.people[n.node])}，${esc(groupLabel(local, componentOrdinalOf(grouping.clusterOf.get(n.node), grouping)))}">
          ${extra}${unstableRing}
          <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${isHatched(local) ? 'url(#hatch-fill)' : color}" stroke="var(--surface-1)" stroke-width="2" filter="url(#node-shadow)" opacity="${dim ? 0.32 : 1}"></circle>
          ${label}
        </g>`
      );
    });

    // Isolated people.
    isolatedNodes.forEach((n) => {
      parts.push(
        `<g class="node" data-node="${n.node}" tabindex="0" role="button" aria-label="${esc(graph.people[n.node])}，孤立人员">
          <circle cx="${n.x}" cy="${n.y}" r="6" fill="var(--surface-1)" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="2 2"></circle>
          <text x="${n.x}" y="${n.y + 17}" class="node-label">${esc(graph.people[n.node])}</text>
        </g>`
      );
    });

    svg.innerHTML = parts.join('');

    renderLegend();
    attachGraphEvents();
  }

  function renderLegend() {
    const localIndices = Array.from(new Set(grouping.groupMeta.map((m) => m.localIndex))).sort((a, b) => a - b);
    const legendItems = localIndices.map(
      (li) =>
        `<span class="legend-item"><span class="legend-swatch" style="${swatchStyle(li)}"></span>${esc(groupName(li))}</span>`
    );
    if (bridgeOf.size) legendItems.push('<span class="legend-item"><span class="legend-swatch legend-outline"></span>* 桥接人员（第二强组 ≥ 本组的 60% 权重）</span>');
    if (unstableOf.size) {
      legendItems.push('<span class="legend-item"><span class="legend-swatch" style="background:transparent;border:2px solid var(--warning)"></span>归属不稳定</span>');
    }
    legendItems.push('<span class="legend-item"><span class="legend-line"></span>线宽 = 关系权重</span>');
    if (localIndices.some((i) => i >= 4)) {
      legendItems.push('<span class="legend-item">第 5 组起用斜线填充 + 虚线环（不循环配色）</span>');
    }
    $('#graph-legend').innerHTML = legendItems.join('');
  }

  function renderComponentsView() {
    const host = $('#components-view');
    const cards = grouping.componentReports
      .map((rep, i) => {
        const internal = rep.members.reduce((s, node) => {
          let d = 0;
          for (const j of rep.members) if (j !== node) d += graph.W[node][j];
          return s + d / 2;
        }, 0);
        const groups = rep.groups
          .map((members, gi) => {
            const color = colorOf(gi);
            return `<div class="mini-group"><span class="group-swatch" style="${swatchStyle(gi)};display:inline-block;margin-right:5px"></span><b>${esc(groupLabel(gi, i + 1))}</b> · ${members
              .map((n) => esc(graph.people[n]))
              .join('、')}</div>`;
          })
          .join('');
        return `<div class="comp-card">
          <h4>连通块 ${i + 1}</h4>
          <span class="meta">${rep.members.length} 人 · 内部权重 ${fmt(internal, 1)} · ${rep.groups.length} 组</span>
          <div class="members">${groups}</div>
        </div>`;
      })
      .join('');
    const isoCard = grouping.isolated.length
      ? `<div class="comp-card is-isolated"><h4>孤立人员</h4><span class="meta">${grouping.isolated.length} 人 · 0 度</span>
         <div class="members">${grouping.isolated.map((n) => esc(graph.people[n])).join('、')}</div></div>`
      : '';
    host.innerHTML = cards + isoCard;
  }

  function attachGraphEvents() {
    const svg = $('#graph-svg');
    const tooltip = $('#graph-tooltip');
    const wrap = svg.closest('.graph-wrap');

    function showTip(html, evt) {
      tooltip.innerHTML = html;
      tooltip.hidden = false;
      const rect = wrap.getBoundingClientRect();
      tooltip.style.left = evt.clientX - rect.left + 'px';
      tooltip.style.top = evt.clientY - rect.top + 'px';
    }
    function hideTip() {
      tooltip.hidden = true;
    }

    svg.querySelectorAll('.edge-hit').forEach((el) => {
      el.addEventListener('mousemove', (evt) => {
        const a = +el.dataset.a;
        const b = +el.dataset.b;
        const shared = mattersForPair(a, b);
        showTip(
          `<b>${esc(graph.people[a])} ↔ ${esc(graph.people[b])}</b><br>权重 ${fmt(graph.W[a][b], 3)} · ${shared.length} 个共同事项`,
          evt
        );
      });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', () => {
        state.selection = { kind: 'edge', a: +el.dataset.a, b: +el.dataset.b };
        renderGraph();
        renderTrace();
      });
    });

    svg.querySelectorAll('.node').forEach((el) => {
      el.addEventListener('mousemove', (evt) => {
        const node = +el.dataset.node;
        const grp = grouping.clusterOf.get(node);
        const name = graph.people[node];
        showTip(
          `<b>${esc(name)}</b><br>${
            grp == null || grp < 0 ? '孤立人员' : esc(labelForGroupId(grp, grouping)) + ' · ' + grouping.groups[grp].length + ' 人'
          }<br>${mattersOfPerson(node).length} 个事项`,
          evt
        );
      });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', () => {
        state.selection = { kind: 'person', a: +el.dataset.node };
        renderGraph();
        renderTrace();
      });
      el.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          state.selection = { kind: 'person', a: +el.dataset.node };
          renderGraph();
          renderTrace();
        }
      });
    });
  }

  function mattersForPair(a, b) {
    return graph.matters
      .filter((m) => m.memberIdx.includes(a) && m.memberIdx.includes(b))
      .map((m) => ({ matter: m, share: m.share }))
      .sort((x, y) => y.share - x.share);
  }

  function mattersOfPerson(node) {
    return graph.matters.filter((m) => m.memberIdx.includes(node));
  }

  function renderTrace() {
    const host = $('#tile-trace');
    const sel = state.selection;
    if (!sel) {
      host.className = 'tile tile-muted';
      host.innerHTML =
        '<h3>从关系回到事项</h3><p class="empty-hint">点选图中任意一条边，查看是哪些事项贡献了这条关系；点选人员则列出其全部事项。</p>';
      return;
    }
    host.className = 'tile';
    if (sel.kind === 'edge') {
      const rows = mattersForPair(sel.a, sel.b);
      const raw = rows.reduce((s, r) => s + r.share, 0);
      const transformed = C.transformShare(raw, state.options.pairTransform);
      const kindText = state.options.pairTransform === 'sqrt' ? '平方根压缩后' : '线性累加';
      const ruleText =
        state.options.pairRule === 'per-matter'
          ? '每个事项总权重固定，按 C(m,2) 均摊'
          : '每名参与者带来 1 单位，按 m-1 均摊';
      const sizes = Array.from(new Set(rows.map((r) => r.matter.m)));
      host.innerHTML = `
        <h3>这条关系的来源</h3>
        <div class="comp-row"><span class="nm"><b>${esc(graph.people[sel.a])} ↔ ${esc(graph.people[sel.b])}</b></span><span class="mt">${fmt(graph.W[sel.a][sel.b], 3)}</span></div>
        ${rows
          .map(
            (r) =>
              `<div class="comp-row"><span class="nm">${esc(r.matter.title)} <span class="mt">${r.matter.year || ''} · ${r.matter.m} 人</span></span><span class="mt">+${fmt(r.share, 3)}</span></div>`
          )
          .join('')}
        <p class="small-note">原始合计 ${fmt(raw, 3)}，${kindText}得 ${fmt(transformed, 3)}。${ruleText}${
          sizes.length === 1 ? `（这里 m = ${sizes[0]}）` : ''
        }；编号相同的事项只计一次，重复导入不会再加权。</p>
      `;
    } else {
      const node = sel.a;
      const ms = mattersOfPerson(node).slice().sort((a, b) => b.share - a.share);
      const partners = [];
      for (let j = 0; j < graph.people.length; j++) {
        if (j !== node && graph.W[node][j] > 0) partners.push({ j, w: graph.W[node][j] });
      }
      partners.sort((a, b) => b.w - a.w);
      const grp = grouping.clusterOf.get(node);
      host.innerHTML = `
        <h3>${esc(graph.people[node])}</h3>
        <p class="small-note">${grp == null || grp < 0 ? '孤立人员' : esc(labelForGroupId(grp, grouping)) + ' · ' + grouping.groups[grp].length + ' 人'}${bridgeOf.has(node) ? ' · 桥接人员' : ''}${unstableOf.has(node) ? ' · 归属不稳定' : ''}</p>
        <div class="comp-row"><span class="nm">参与事项</span><span class="mt">${ms.length}</span></div>
        ${ms
          .slice(0, 6)
          .map((m) => `<div class="comp-row"><span class="nm">${esc(m.title)}</span><span class="mt">${m.m} 人</span></div>`)
          .join('')}
        <h3 style="margin-top:14px">最强关系</h3>
        ${partners
          .slice(0, 5)
          .map((p) => `<div class="comp-row"><span class="nm">${esc(graph.people[p.j])}</span><span class="mt">${fmt(p.w, 3)}</span></div>`)
          .join('')}
      `;
    }
  }

  /* ------------------------------------------------------------------ *
   * Render: grouping + spectrum
   * ------------------------------------------------------------------ */

  function renderGroups() {
    renderComponentTabs();
    renderSpectrum();
    renderGroupCards();
    renderEvidence();
    renderSweep();
  }

  function renderComponentTabs() {
    const host = $('#component-tabs');
    if (!grouping.componentReports.length) {
      host.innerHTML = '<span class="small-note">没有可分组的连通块。</span>';
      return;
    }
    if (state.componentIndex >= grouping.componentReports.length) state.componentIndex = 0;
    host.innerHTML = grouping.componentReports
      .map(
        (rep, i) =>
          `<button class="comp-tab" role="tab" aria-selected="${i === state.componentIndex}" data-comp="${i}">连通块 ${i + 1} <span class="cnt">${rep.members.length} 人</span></button>`
      )
      .join('');
    host.querySelectorAll('.comp-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.componentIndex = +btn.dataset.comp;
        renderComponentTabs();
        renderSpectrum();
        renderGroupCards();
        renderEvidence();
        renderSweep();
      });
    });
  }

  function selectedComponent() {
    return grouping.componentReports[state.componentIndex] || null;
  }

  function renderSpectrum() {
    const host = $('#spectrum-host');
    const rep = selectedComponent();
    if (!rep || rep.members.length < 3) {
      host.innerHTML = '<div class="empty-state">这个连通块只有 2 人，无法继续划分；两名成员保持在同一组。</div>';
      return;
    }
    const values = rep.spectrum.values;
    const k = rep.effectiveK;
    const maxK = rep.maxK;
    const shown = Math.min(values.length, Math.max(8, k + 3));
    const W = 660;
    const H = 214;
    const padL = 38;
    const padR = 22;
    const padT = 16;
    const padB = 30;
    const yMax = Math.max(1.15, ...values.slice(0, shown)) * 1.04;
    const x = (i) => padL + (i / Math.max(1, shown - 1)) * (W - padL - padR);
    const y = (v) => H - padB - (v / yMax) * (H - padT - padB);

    const parts = [];
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="none"></rect>`);
    // Kept subspace band.
    if (k >= 1) {
      const x0 = x(0) - 12;
      const x1 = x(k - 1) + (x(k) - x(k - 1)) / 2;
      parts.push(`<rect x="${x0}" y="${padT - 4}" width="${Math.max(0, x1 - x0)}" height="${H - padT - padB + 4}" fill="var(--series-1-wash)"></rect>`);
      parts.push(`<text x="${x0 + 6}" y="${padT + 9}" class="spec-band-label">保留的 ${k} 个分量</text>`);
    }
    // Gridlines.
    [0.5, 1, 1.5].forEach((g) => {
      if (g > yMax) return;
      parts.push(`<line x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}" stroke="var(--hairline)" stroke-width="1"></line>`);
      parts.push(`<text x="${padL - 8}" y="${y(g) + 4}" class="spec-tick" text-anchor="end">${g.toFixed(1)}</text>`);
    });
    parts.push(`<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"></line>`);
    parts.push(`<text x="${padL - 8}" y="${y(0) + 4}" class="spec-tick" text-anchor="end">0</text>`);

    // Eigenvalue line + dots.
    const pts = values.slice(0, shown).map((v, i) => `${x(i)},${y(v)}`).join(' ');
    parts.push(`<polyline points="${pts}" fill="none" stroke="var(--ink-3)" stroke-width="1.4" stroke-opacity="0.55"></polyline>`);
    values.slice(0, shown).forEach((v, i) => {
      const inBand = i < k;
      parts.push(
        `<circle cx="${x(i)}" cy="${y(v)}" r="${inBand ? 4.4 : 3.4}" fill="${inBand ? 'var(--series-1)' : 'var(--surface-1)'}" stroke="${inBand ? 'var(--series-1)' : 'var(--ink-3)'}" stroke-width="1.5"></circle>`
      );
      parts.push(`<text x="${x(i)}" y="${H - 10}" class="spec-tick" text-anchor="middle">${i === 0 ? 'λ₀' : 'λ' + i}</text>`);
    });

    // Boundary gap annotation.
    if (k < values.length && k - 1 < shown && k < shown) {
      const ev = rep.evidence;
      const gx = (x(k - 1) + x(k)) / 2;
      const yTop = y(values[k]);
      const yBot = y(values[k - 1]);
      const color = ev.label === '支持' ? 'var(--good)' : ev.label === '弱支持' ? 'var(--warning)' : 'var(--critical)';
      parts.push(`<line x1="${gx}" y1="${yTop}" x2="${gx}" y2="${yBot}" stroke="${color}" stroke-width="2" stroke-dasharray="3 3"></line>`);
      parts.push(`<circle cx="${gx}" cy="${yTop}" r="2.5" fill="${color}"></circle>`);
      parts.push(`<circle cx="${gx}" cy="${yBot}" r="2.5" fill="${color}"></circle>`);
      const ly = Math.max(padT + 12, Math.min(yTop, yBot) - 8);
      parts.push(
        `<text x="${Math.min(gx + 8, W - padR - 4)}" y="${ly}" class="spec-gap-label" text-anchor="${gx > W - 180 ? 'end' : 'start'}">切在 λ${k - 1} / λ${k} 之间 · ${ev.label}</text>`
      );
    }

    host.innerHTML = `
      <div class="spectrum-card">
        <div class="spectrum-head">
          <span class="spectrum-title">归一化拉普拉斯特征值 · 连通块 ${state.componentIndex + 1}</span>
          <span class="spectrum-sub">${rep.members.length} 人 · 请求 ${k} 组${rep.requestedK !== rep.effectiveK ? `（上限 ${rep.maxK}）` : ''}</span>
        </div>
        <div class="spectrum-scroll">
          <svg class="spectrum-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="特征值谱与切分位置">${parts.join('')}</svg>
        </div>
        <p class="scroll-hint">左右滑动查看完整特征值谱</p>
      </div>`;
  }

  function renderGroupCards() {
    const host = $('#group-list');
    const rep = selectedComponent();
    if (!rep) {
      host.innerHTML = '<div class="empty-state">没有可显示的群组。</div>';
      return;
    }
    host.innerHTML = rep.groups
      .map((members, gi) => {
        const local = gi;
        const sorted = members.slice().sort((a, b) => {
          const da = layout.degree[a] || 0;
          const db = layout.degree[b] || 0;
          return db - da || a - b;
        });
        const pills = sorted
          .map((node) => {
            const cls = ['person-pill'];
            if (bridgeOf.has(node)) cls.push('is-bridge');
            if (unstableOf.has(node)) cls.push('is-unstable');
            return `<span class="${cls.join(' ')}">${esc(graph.people[node])}</span>`;
          })
          .join('');
        return `
          <div class="group-card" style="--group-color:${colorOf(local)}">
            <div class="group-head">
              <span class="group-swatch" style="${swatchStyle(local)}"></span>
              <span class="group-title">${esc(groupLabel(local, state.componentIndex + 1))}</span>
              <span class="group-count">${members.length} 人</span>
              ${bridgeOf.size && members.some((n) => bridgeOf.has(n)) ? `<span class="tag">${members.filter((n) => bridgeOf.has(n)).length} 名桥接</span>` : ''}
              ${members.some((n) => unstableOf.has(n)) ? `<span class="tag tag-warn">含不稳定归属</span>` : ''}
            </div>
            <div class="group-people">${pills}</div>
          </div>`;
      })
      .join('');
  }

  function renderEvidence() {
    const host = $('#tile-evidence');
    const rep = selectedComponent();
    if (!rep) {
      host.innerHTML = '<h3>划分依据</h3><p class="empty-hint">没有可分析的连通块。</p>';
      return;
    }
    const ev = rep.evidence;
    if (!ev || ev.supported == null) {
      const maxK = Math.max(1, rep.members.length - 1);
      host.innerHTML = `<h3>划分依据</h3><p class="empty-hint">该连通块最多只能分成 ${maxK} 组：再切下去每个组只剩一个人，没有可检验的谱间隔。</p>`;
      return;
    }
    const cls = ev.label === '支持' ? 'verdict-good' : ev.label === '弱支持' ? 'verdict-warn' : 'verdict-bad';
    host.innerHTML = `
      <h3>划分依据</h3>
      <div class="evidence-verdict"><span class="verdict-dot ${cls}"></span>${ev.label}</div>
      <p class="small-note">相邻特征值在 λ${ev.k - 1} 与 λ${ev.k} 之间${
        ev.label === '不支持' ? '几乎连成一片' : '出现可见间隔'
      }。间隔占整个谱宽度的 ${fmt(ev.score * 100, 0)}%（≥15% 记为支持，5%–15% 为弱支持）；这是数据给出的信号，不是确定的部门结论。</p>
      <table class="evidence-table">
        <tr><th>λ${ev.k - 1}</th><td>${fmt(ev.lamK, 3)}</td></tr>
        <tr><th>λ${ev.k}</th><td>${fmt(ev.lamNext, 3)}</td></tr>
        <tr><th>间隔</th><td>${fmt(ev.gap, 3)}</td></tr>
        <tr><th>归一化得分</th><td>${fmt(ev.score, 3)}</td></tr>
      </table>`;
  }

  function renderSweep() {
    const host = $('#tile-sweep');
    const rep = selectedComponent();
    if (!rep || rep.members.length < 3) {
      host.innerHTML = '<h3>各切法的谱支持</h3><p class="empty-hint">连通块过小，无需比较。</p>';
      return;
    }
    // The slider only offers 1–8; listing all m−1 rows would bury the tile in
    // singleton-sized splits nobody can choose.
    const kMax = Math.min(rep.maxK, 8);
    const rows = [];
    for (let k = 1; k <= kMax; k++) {
      const ev = C.eigengapEvidence(rep.spectrum.values, k);
      const isCur = k === rep.effectiveK;
      const label = ev.supported == null ? '—' : ev.label;
      rows.push(
        `<tr class="${isCur ? 'is-boundary' : ''}"><td>${k} 组${isCur ? ' · 当前' : ''}</td><td>${ev.gap == null ? '—' : fmt(ev.gap, 3)}</td><td>${label}</td></tr>`
      );
    }
    host.innerHTML = `<h3>各切法的谱支持</h3><table class="evidence-table"><tr><th>切法</th><th>间隔</th><th>判断</th></tr>${rows.join('')}</table><p class="small-note">${
      rep.maxK > kMax ? `滑杆只到 8 组；该连通块最多可切 ${rep.maxK} 组，再往下每组只剩个位数人。` : ''
    }谱支持只是证据之一；结合下方稳定性和实际业务含义判断。</p>`;
  }

  /* ------------------------------------------------------------------ *
   * Render: comparison
   * ------------------------------------------------------------------ */

  function renderMatterPicker() {
    const host = $('#matter-chips');
    const sorted = graph.matters.slice().sort((a, b) => b.m - a.m || a.id.localeCompare(b.id));
    host.innerHTML = sorted
      .map(
        (m) =>
          `<button class="chip" data-matter="${esc(m.id)}" aria-pressed="${state.excluded.has(m.id)}" title="${esc(m.title)} · ${m.m} 人 · 权重 ${fmt(m.total, 2)}">${esc(m.id)} · ${m.m} 人${m.m >= 8 ? ' · 大型' : ''}</button>`
      )
      .join('');
    host.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.matter;
        if (state.excluded.has(id)) state.excluded.delete(id);
        else state.excluded.add(id);
        btn.setAttribute('aria-pressed', state.excluded.has(id));
        recomputeComparison();
        renderMatterPicker();
      });
    });
  }

  function renderCompare() {
    const beforeHost = $('#compare-before');
    const afterHost = $('#compare-after');
    const enabled = state.compareEnabled;
    const excludedNames = graph.matters
      .filter((m) => state.excluded.has(m.id))
      .map((m) => m.title);
    $('#compare-excluded-label').textContent = excludedNames.length
      ? `（已排除：${excludedNames.join('、')}）`
      : '（未排除任何事项）';

    beforeHost.innerHTML = grouping.componentReports
      .map((rep, ci) =>
        rep.groups
          .map((members, gi) => {
            const unstable = members.filter((n) => unstableOf.has(n)).length;
            return `
              <div class="cmp-card">
                <div class="cmp-head">
                  <span class="group-swatch" style="${swatchStyle(gi)}"></span>
                  <span class="cmp-label">${esc(groupLabel(gi, ci + 1))}</span>
                  <span class="group-count">${members.length} 人</span>
                  ${unstable ? `<span class="tag tag-warn cmp-rel">${unstable} 人不稳</span>` : ''}
                </div>
                <div class="cmp-people">${members.map((n) => esc(graph.people[n])).join('<span class="sep">、</span>')}</div>
              </div>`;
          })
          .join('')
      )
      .join('');

    if (!enabled) {
      afterHost.innerHTML = '<div class="empty-state">对照未启用。勾选上方「启用对照」后，会显示排除事项后的分组。</div>';
      $('#tile-compare-summary').innerHTML =
        '<h3>对照摘要</h3><p class="empty-hint">未启用对照。</p>';
      $('#tile-still-together').innerHTML =
        '<h3>仍在一起的人</h3><p class="empty-hint">未启用对照。</p>';
      $('#person-outcomes').innerHTML = '';
      return;
    }

    const relText = {
      same: '延续',
      split: '拆分',
      merge: '合并',
      'split+merge': '拆分 + 合并',
      new: '新群组',
    };
    // Order the after-run groups by where their parent sat in the before-run,
    // not by the after-run's own numbering. Two runs number their groups
    // independently, so reading the right column in after-run order would
    // scramble the correspondence the cards are trying to show.
    const beforePos = new Map();
    grouping.componentReports.forEach((rep, bci) =>
      rep.groupIds.forEach((gid, bgi) => beforePos.set(gid, { bci, bgi }))
    );
    const afterOrdinal = new Map();
    afterGrouping.componentReports.forEach((rep, ai) => afterOrdinal.set(rep.seed, ai + 1));
    const afterCardLabel = new Map();
    afterLabelById = afterCardLabel;
    const buckets = [];
    afterGrouping.componentReports.forEach((rep, ai) => {
      rep.groupIds.forEach((gid, gi) => {
        const rec = comparison.matched.records[gid] || null;
        const parent = rec && rec.parent >= 0 ? rec.parent : null;
        const pp = parent == null ? null : beforePos.get(parent);
        const kidIdx = parent == null ? 0 : Math.max(0, childrenCountArray(parent).indexOf(gid));
        const kidsAll = parent == null ? [] : childrenCountArray(parent);
        const letter = kidsAll.length > 1 ? ' · ' + String.fromCharCode(97 + kidsAll.indexOf(gid)) : '';
        afterCardLabel.set(gid, {
          text: parent == null ? '新群组' : `${labelForGroupId(parent, grouping)}${letter}`,
          from: parent == null ? null : labelForGroupId(parent, grouping),
        });
        buckets.push({
          gid,
          members: rep.groups[gi],
          rec,
          parent,
          sortKey: parent == null ? [1, ai, gi] : [0, pp.bci, pp.bgi, ai, kidIdx],
        });
      });
    });
    const cmpNums = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    buckets.sort((x, y) => {
      for (let i = 0; i < x.sortKey.length; i++) {
        const d = cmpNums(x.sortKey[i], y.sortKey[i]);
        if (d) return d;
      }
      return 0;
    });

    const cards = [];
    let lastBlock = null;
    buckets.forEach((b) => {
      const { rec, members, parent } = b;
      const block = parent == null ? 'new' : parent;
      if (block !== lastBlock) {
        lastBlock = block;
        cards.push(
          `<div class="cmp-block-label">${
            parent == null
              ? '新群组 · 与上一轮没有成员重合'
              : esc(`承接 ${labelForGroupId(parent, grouping)}`)
          }</div>`
        );
      }
      const afterRep = afterGrouping.componentReports.find((rep) => rep.groupIds.includes(b.gid));
      const afterPos = `${afterOrdinal.get(afterRep.seed)} · ${afterRep.groupIds.indexOf(b.gid) + 1}`;
      const parentMeta = parent == null ? null : grouping.groupMeta[parent];
      const color = parentMeta ? colorOf(parentMeta.localIndex) : 'var(--ink-3)';
      const labelInfo = afterCardLabel.get(b.gid) || { text: '新群组', from: null };
      const label = labelInfo.text;
      const relation = rec ? relText[rec.relation] || rec.relation : '—';
      const movedHere = members.filter((n) => comparison.nodeStatus.get(n) === 'moved').length;
      // A card that keeps the old group's name must not pretend the after-run
      // numbering agrees with it: print the after-run position as a separate,
      // explicitly non-comparable reference.
      const note = [
        `排除后编号 块 ${afterPos}`,
        movedHere ? `${movedHere} 人改换了归属（划掉者）` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      cards.push(
        `<div class="cmp-card" style="border-left:3px solid ${color}">` +
          `<div class="cmp-head">` +
          `<span class="group-swatch" style="${swatchStyle(parentMeta ? parentMeta.localIndex : 99)}"></span>` +
          `<span class="cmp-label">${esc(label)}</span>` +
          `<span class="group-count">${members.length} 人</span>` +
          (rec && rec.parent >= 0
            ? `<span class="tag cmp-rel">${relation} · 原组重合 ${rec.overlapWithParent}/${grouping.groups[rec.parent].length}</span>`
            : '<span class="tag tag-warn cmp-rel">无对应</span>') +
          `</div>` +
          `<div class="cmp-people">${members
            .map((n) => {
              const st = comparison.nodeStatus.get(n);
              return st === 'moved'
                ? `<span class="leaver" title="与上一轮不在同一组">${esc(graph.people[n])}</span>`
                : esc(graph.people[n]);
            })
            .join('<span class="sep">、</span>')}</div>` +
          `<p class="small-note">${note}</p>` +
          `</div>`
      );
    });
    afterHost.innerHTML = `<div class="cmp-col-inner">${cards.join('')}</div>`;

    const cmp = comparison;
    const pctKept = cmp.togetherCount.total ? cmp.togetherCount.kept / cmp.togetherCount.total : 0;
    const unstableCount = unstableOf.size;
    $('#tile-compare-summary').innerHTML = `
      <h3>对照摘要</h3>
      <div class="comp-row"><span class="nm">两轮都在群组中</span><span class="mt">${cmp.summary.stable + cmp.summary.moved}</span></div>
      <div class="comp-row"><span class="nm">归属保持不变</span><span class="mt">${cmp.summary.stable}</span></div>
      <div class="comp-row"><span class="nm">归属改变</span><span class="mt">${cmp.summary.moved}</span></div>
      <div class="comp-row"><span class="nm">始终孤立</span><span class="mt">${cmp.summary.isolated}</span></div>
      <div class="comp-row"><span class="nm">原本同组、现在仍同组</span><span class="mt">${cmp.togetherCount.kept} / ${cmp.togetherCount.total} （${pct(pctKept)}）</span></div>
      <div class="comp-row"><span class="nm">当前不稳定人员</span><span class="mt">${unstableCount}</span></div>
      <p class="small-note">对照按成员重合匹配，再把人员归属逐人比较；两轮的组编号从未直接比较。</p>`;

    renderStillTogether();
    renderPersonOutcomes();
  }

  function childrenCountArray(parent) {
    const arr = [];
    comparison.matched.records.forEach((r, q) => {
      if (r.parent === parent) arr.push(q);
    });
    return arr.sort((a, b) => a - b);
  }

  function renderStillTogether() {
    const host = $('#tile-still-together');
    const beforeOf = grouping.clusterOf;
    const byGroup = new Map();
    comparison.togetherPairs.forEach((p) => {
      const g = beforeOf.get(p.a);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    });
    const blocks = Array.from(byGroup.entries())
      .map(([g, pairs]) => {
        const kept = pairs.filter((p) => p.kept).length;
        const lost = pairs.length - kept;
        const broken = pairs.filter((p) => !p.kept).slice(0, 3);
        const meta = grouping.groupMeta[g];
        if (!meta) return '';
        return {
          lost,
          html: `
          <div class="block">
            <div class="comp-row"><span class="nm"><span class="group-swatch" style="${swatchStyle(meta.localIndex)};display:inline-block;margin-right:6px"></span>${esc(groupLabel(meta.localIndex, grouping.componentReports.findIndex((r) => r.groupIds.includes(g)) + 1))}</span><span class="mt">${kept}/${pairs.length} 对</span></div>
            ${
              broken.length
                ? `<div class="still-together-list">${broken
                    .map((p) => `<div class="still-row"><span class="who">${esc(graph.people[p.a])} ↔ ${esc(graph.people[p.b])}</span><span class="gone">已分开</span></div>`)
                    .join('')}</div>${
                    lost > broken.length ? `<p class="small-note">另有 ${lost - broken.length} 对分开。</p>` : ''
                  }`
                : '<p class="small-note">组内所有关系都保留。</p>'
            }
          </div>`,
        };
      })
      .filter(Boolean)
      // Groups that lost pairs first: that is where the exclusion actually bit.
      .sort((a, b) => b.lost - a.lost)
      .map((x) => x.html)
      .join('');
    host.innerHTML = `<h3>仍在一起的人</h3>${blocks || '<p class="empty-hint">没有可比对的关系。</p>'}`;
  }

  function renderPersonOutcomes() {
    const host = $('#person-outcomes');
    const moved = comparison.nodeRecords.filter((r) => r.status === 'moved');
    if (!moved.length) {
      host.innerHTML = `<p class="small-note" style="margin:0">没有人员的归属发生变化：${
        comparison.summary.stable
      } 人留在原对应组，${comparison.summary.isolated} 人始终孤立。</p>`;
      return;
    }
    const rows = moved
      .map((r) => {
        const beforeName = r.prevGroup == null ? '孤立' : labelForGroupId(r.prevGroup, grouping);
        const afterName =
          r.nextGroup == null
            ? '孤立'
            : (afterLabelById.get(r.nextGroup) && afterLabelById.get(r.nextGroup).text) || '—';
        const unstable = unstableOf.get(r.node);
        const prevSize = r.prevGroup == null ? 0 : grouping.groups[r.prevGroup].length;
        const nextSize = r.nextGroup == null ? 0 : afterGrouping.groups[r.nextGroup].length;
        return `<div class="outcome-row">
          <span class="outcome-name">${esc(graph.people[r.node])}</span>
          <span class="outcome-flow">${esc(beforeName)}（${prevSize} 人）→ ${esc(afterName)}（${nextSize} 人）</span>
          <span class="outcome-tag">${unstable ? '扰动下也不稳定 · ' + pct(unstable.rate) + ' 的抽样中改变' : '在当前扰动下稳定'}</span>
        </div>`;
      })
      .join('');
    host.innerHTML = `<h3 style="margin:0 0 8px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)">人员归属变化（${moved.length}）</h3>${rows}`;
  }

  /* ------------------------------------------------------------------ *
   * Render: stability
   * ------------------------------------------------------------------ */

  function renderStability() {
    const host = $('#stability-list');
    const tile = $('#tile-stability-summary');
    if (!stability || !stability.stability.length) {
      host.innerHTML = '<div class="empty-state">没有可分析的人员。</div>';
      tile.innerHTML = '<h3>稳定性摘要</h3><p class="empty-hint">没有可分析的人员。</p>';
      return;
    }
    const grouped = stability.stability
      .filter((s) => s.grouped)
      .sort((a, b) => b.rate - a.rate || a.node - b.node);
    const threshold = stability.threshold;
    const isolatedCount = stability.stability.filter((s) => !s.grouped).length;
    host.innerHTML = grouped
      .map((s) => {
        const unstable = !s.stable;
        return `<div class="stab-row">
          <span class="stab-name ${unstable ? 'is-unstable' : ''}">${esc(graph.people[s.node])}</span>
          <div class="stab-track">
            <div class="stab-fill ${unstable ? 'is-unstable' : ''}" style="width:${Math.max(0.5, s.rate * 100)}%"></div>
            <div class="threshold" style="left:${threshold * 100}%"></div>
          </div>
          <span class="stab-pct">${pct(s.rate)}</span>
        </div>`;
      })
      .join('') +
      (isolatedCount
        ? `<p class="small-note">另有 ${isolatedCount} 名孤立人员不参与分组，也不参与扰动统计。</p>`
        : '');

    const unstable = stability.unstable.filter((s) => s.grouped);
    const stableCount = grouped.length - unstable.length;
    const trials = stability.trials;
    const changedMean = trials ? stability.history.reduce((s, h) => s + h.changed, 0) / trials : 0; // people per trial
    tile.innerHTML = `
      <h3>稳定性摘要</h3>
      <div class="comp-row"><span class="nm">抽样次数</span><span class="mt">${trials}</span></div>
      <div class="comp-row"><span class="nm">扰动幅度</span><span class="mt">±${pct(state.sigma)}</span></div>
      <div class="comp-row"><span class="nm">稳定人员</span><span class="mt">${stableCount} / ${grouped.length}</span></div>
      <div class="comp-row"><span class="nm">不稳定人员</span><span class="mt">${unstable.length}</span></div>
      <div class="comp-row"><span class="nm">平均每轮改变</span><span class="mt">${fmt(changedMean, 2)} 人</span></div>
      <div class="comp-row"><span class="nm">阈值</span><span class="mt">${pct(stability.threshold)} 的抽样</span></div>`;
    $('#tile-stability-note').innerHTML = unstable.length
      ? `<div class="unstable-card"><h4>不强行贴标签</h4><p>${unstable
          .map((u) => esc(graph.people[u.node]) + '（' + pct(u.rate) + '）')
          .join('、')} 的归属随权重轻微变化而改变。这类人更像跨组协作的人，图上只加虚线圈，不强行归入某个确定群组。</p></div>
        <p class="small-note">只扰动已存在的边，所以连通块结构与孤立人员保持不变。图中这类人员用虚线圈标注，而不是硬给一个组色。</p>`
      : `<p class="small-note">在这个扰动幅度下，所有人的归属都没有反复改变。</p>
        <p class="small-note">只扰动已存在的边，所以连通块结构与孤立人员保持不变。</p>`;
  }

  /* ------------------------------------------------------------------ *
   * Render all / events
   * ------------------------------------------------------------------ */

  function renderAll() {
    renderOverview();
    renderGroups();
    renderCompare();
    renderStability();
    renderMatterPicker();
    renderNormalizeNote();
  }

  function renderNormalizeNote() {
    const rule = state.options.pairRule;
    const transform = state.options.pairTransform;
    $('#normalize-note').innerHTML =
      rule === 'per-matter'
        ? `整件事项总权重固定为 1（乘事项权重），按 C(m,2) 均摊：<code>1 / (m(m-1)/2)</code>。参与人数越多，单对权重越小。${transform === 'sqrt' ? '多事项累积后再取平方根。' : '多事项累积线性相加。'}`
        : `每名参与者带来 1 的单位权重，按 m-1 位搭档均摊：<code>1 / (m-1)</code>。单对权重仍随人数下降，但事项总权重随人数线性增长。${transform === 'sqrt' ? '累积后再取平方根。' : '累积线性相加。'}`;
  }

  function bindEvents() {
    $('#btn-data').addEventListener('click', () => {
      const drawer = $('#data-drawer');
      const open = drawer.hidden;
      drawer.hidden = !open;
      $('#btn-data').setAttribute('aria-expanded', String(open));
      if (open && !$('#paste-input').value) $('#paste-input').value = sampleToPaste();
    });

    $('#rule-select').value = state.options.pairRule;
    $('#transform-select').value = state.options.pairTransform;
    $('#dup-select').value = state.options.duplicatePolicy;

    $('#rule-select').addEventListener('change', (e) => {
      state.options.pairRule = e.target.value;
      rebuild();
    });
    $('#transform-select').addEventListener('change', (e) => {
      state.options.pairTransform = e.target.value;
      rebuild();
    });
    $('#dup-select').addEventListener('change', (e) => {
      state.options.duplicatePolicy = e.target.value;
      rebuild();
    });
    $('#btn-import').addEventListener('click', importPaste);
    $('#btn-reset').addEventListener('click', loadSample);

    $('#k-range').addEventListener('input', (e) => {
      state.k = +e.target.value;
      $('#k-output').textContent = state.k;
      recomputeGroupsOnly();
    });

    $('#compare-enable').addEventListener('change', (e) => {
      state.compareEnabled = e.target.checked;
      renderCompare();
    });
    $('#btn-compare-expand').addEventListener('click', () => {
      const picker = $('#matter-picker');
      picker.hidden = !picker.hidden;
      $('#btn-compare-expand').setAttribute('aria-expanded', String(!picker.hidden));
    });

    $('#sigma-range').addEventListener('input', (e) => {
      state.sigma = +e.target.value / 100;
      $('#sigma-output').textContent = e.target.value + '%';
      runPerturbation();
      renderStability();
      renderGroups();
      renderOverview();
      renderCompare();
    });
    $('#btn-run-perturb').addEventListener('click', () => {
      // New draw each press; the sigma slider keeps the seed so dragging it
      // compares amplitudes on the same sample instead of on fresh noise.
      state.perturbSeed = (state.perturbSeed + 7919) >>> 0;
      runPerturbation();
      renderStability();
      renderGroups();
      renderOverview();
      renderCompare();
    });

    $$('.seg[data-overview]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.seg[data-overview]').forEach((b) => b.classList.toggle('is-active', b === btn));
        state.overviewMode = btn.dataset.overview;
        renderOverview();
      });
    });

    $('#theme-toggle').addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = state.theme;
      $('#theme-label').textContent = state.theme === 'light' ? '深色' : '浅色';
      renderGraph();
    });

    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      state.theme = 'dark';
      document.documentElement.dataset.theme = 'dark';
      $('#theme-label').textContent = '浅色';
    }
  }

  function boot() {
    bindEvents();
    $('#k-output').textContent = state.k;
    $('#sigma-output').textContent = Math.round(state.sigma * 100) + '%';
    $('#paste-input').value = sampleToPaste();
    loadSample();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
