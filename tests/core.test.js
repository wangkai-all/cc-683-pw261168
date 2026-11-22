/* Node tests for the CoFocus core. Run with: node --test tests/core.test.js */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Core = require('../core.js');
const SAMPLE = require('../data/sample.js');

function build(overrides) {
  return Core.buildGraph(SAMPLE.matters, Object.assign({ roster: SAMPLE.people }, overrides || {}));
}

function orderOf(graph) {
  return graph.W.map((_, i) => i);
}

function groupNames(graph, result) {
  return result.groups.map((g) => g.map((i) => graph.people[i]).sort().join('|')).sort();
}

test('duplicate imports never add weight', () => {
  const withDup = build();
  const unique = Core.buildGraph(
    SAMPLE.matters.filter((m, i) => !(m.id === 'X-02' && i === 29)),
    { roster: SAMPLE.people }
  );
  assert.equal(withDup.stats.duplicatesDropped, 1);
  let maxDiff = 0;
  for (let i = 0; i < withDup.W.length; i++) {
    for (let j = 0; j < withDup.W.length; j++) {
      maxDiff = Math.max(maxDiff, Math.abs(withDup.W[i][j] - unique.W[i][j]));
    }
  }
  assert.equal(maxDiff, 0, 'a repeated matter must not change any pair weight');
});

test('a repeated import with conflicting content is reported, not stacked', () => {
  const g = Core.buildGraph(
    [
      { id: 'Z-1', people: ['甲', '乙'] },
      { id: 'Z-1', people: ['甲', '乙', '丙'] },
    ],
    { roster: ['甲', '乙', '丙'] }
  );
  assert.equal(g.stats.matters, 1);
  assert.equal(g.stats.duplicatesDropped, 1);
  assert.equal(g.W[g.index.get('甲')][g.index.get('丙')], 0);
});

test('large matters are normalized so headcount alone cannot dominate', () => {
  const g = build();
  const big = g.matters.find((m) => m.id === 'X-01');
  const small = g.matters.find((m) => m.id === 'P-01');
  assert.ok(big.share < small.share / 3, 'per-pair share of a 10-person matter must be far below a 3-person one');
  // Under the default per-matter rule every matter hands out the same total
  // mass, regardless of headcount.
  for (const m of g.matters) {
    assert.ok(Math.abs(m.total - m.budget) < 1e-9, `${m.id} total budget drifted`);
  }
  const perPerson = build({ pairRule: 'per-person' });
  const bigPP = perPerson.matters.find((m) => m.id === 'X-01');
  assert.ok(bigPP.total > big.total, 'per-person rule lets total mass grow with headcount');
  assert.ok(bigPP.share < big.share * 10, 'but the individual pair share still shrinks');
});

test('pair transform is applied after summation, so exclusion is exact', () => {
  const g = build();
  const subset = g.matters.filter((m) => m.id !== 'X-01');
  // Rebuild from raw events minus X-01 through the normal path.
  const replay = Core.buildGraph(
    SAMPLE.matters.filter((m) => m.id !== 'X-01'),
    { roster: SAMPLE.people }
  );
  const excluded = Core.excludeMatters(g, ['X-01']);
  for (let i = 0; i < g.W.length; i++) {
    for (let j = 0; j < g.W.length; j++) {
      assert.ok(Math.abs(excluded.W[i][j] - replay.W[i][j]) < 1e-12, `W[${i}][${j}] mismatch after exclusion`);
    }
  }
  assert.equal(excluded.people.join(','), g.people.join(','), 'people order must be shared');
});

test('connected components keep isolated people out of every component', () => {
  const g = build();
  const comps = Core.componentsOf(g.W, orderOf(g));
  const isolated = comps.isolated.map((i) => g.people[i]).sort();
  assert.deepEqual(isolated, ['叶青', '王珂']);
  for (const comp of comps.components) {
    assert.ok(comp.length >= 2);
    for (const node of comp) {
      assert.ok(comps.degree[node] > 0, 'a component member must have positive degree');
    }
  }
  const total = comps.components.reduce((s, c) => s + c.length, 0) + comps.isolated.length;
  assert.equal(total, g.people.length);
});

test('spectrum: one zero eigenvalue per connected component; no division by zero for isolated people', () => {
  const g = build();
  const comps = Core.componentsOf(g.W, orderOf(g));
  for (const comp of comps.components) {
    const spec = Core.laplacianSpectrum(g.W, comp);
    assert.equal(spec.values.length, comp.length);
    assert.ok(Math.abs(spec.values[0]) < 1e-8, 'connected component must have a zero eigenvalue');
    assert.ok(spec.values[1] > 1e-6, 'second eigenvalue must be positive in a connected component');
    for (const v of spec.values) assert.ok(Number.isFinite(v), 'spectrum must be finite');
  }
  // Passing an isolated node explicitly must not produce NaN.
  const iso = comps.isolated[0];
  const spec = Core.laplacianSpectrum(g.W, [iso]);
  assert.deepEqual(spec.values, [0]);
});

test('eigengap evidence flags a flat region as unsupported', () => {
  const values = [0, 0.4, 0.401, 0.9, 1.2];
  assert.equal(Core.eigengapEvidence(values, 2).label, '不支持');
  assert.equal(Core.eigengapEvidence([0, 0.4, 0.9], 1).label, '支持');
  assert.equal(Core.eigengapEvidence([0, 0.4], 1).label, '支持');
  assert.equal(Core.eigengapEvidence([0, 0.4], 2).supported, null, 'past the spectrum there is nothing to test');
});

test('grouping never divides an isolated person and respects k caps', () => {
  const g = build();
  const res = Core.groupGraph(g.W, { k: 9, order: orderOf(g) });
  const grouped = new Set(res.groups.flat());
  for (const node of res.isolated) assert.ok(!grouped.has(node), 'isolated person must not be grouped');
  for (const rep of res.componentReports) {
    assert.ok(rep.effectiveK <= rep.members.length - 1);
    assert.equal(rep.groups.length, Math.max(1, rep.effectiveK));
  }
});

test('exact k is delivered for the main component at k = 2..6', () => {
  const g = build();
  for (const k of [2, 3, 4, 5, 6]) {
    const res = Core.groupGraph(g.W, { k, order: orderOf(g) });
    const main = res.componentReports.find((r) => r.members.length > 5);
    assert.equal(main.groups.length, k, `k=${k} should produce exactly ${k} main groups`);
  }
});

test('group numbers are not compared across runs: renumbering yields 100% stable', () => {
  const g = build();
  const base = Core.groupGraph(g.W, { k: 5, order: orderOf(g) });
  const renumbered = {
    groups: base.groups.slice().reverse(),
    clusterOf: new Map(),
    order: base.order,
  };
  renumbered.groups.forEach((grp, gi) => grp.forEach((m) => renumbered.clusterOf.set(m, gi)));
  const cmp = Core.compareRuns(base, renumbered, { nodeCount: g.people.length });
  assert.equal(cmp.summary.moved, 0);
  assert.equal(cmp.summary.isolated, 2);
  assert.equal(cmp.summary.stable, g.people.length - 2);
  assert.equal(cmp.togetherCount.lost, 0);
});

test('matching reports splits and merges by membership overlap', () => {
  const m = Core.matchGroups(
    [
      ['a', 'b', 'c', 'd'],
      ['e', 'f'],
    ],
    [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
      ['g'],
    ],
    new Map([
      ['a', 0], ['b', 0], ['c', 0], ['d', 0], ['e', 1], ['f', 1],
    ])
  );
  const first = m.records.find((r) => r.members.includes('a'));
  assert.ok(['split', 'split+merge'].includes(first.relation), 'old group 1 was split');
  const third = m.records.find((r) => r.members.includes('g'));
  assert.equal(third.relation, 'new');
  assert.equal(m.personDetail.get('d').stable, false);
  assert.equal(m.personDetail.get('b').stable, true);
});

test('a person spilled from a big group is moved, while its core stays stable', () => {
  const prev = [['a', 'b', 'c', 'd', 'e'], ['f', 'g']];
  const next = [['a', 'b', 'c', 'd'], ['e', 'f', 'g']];
  const membership = new Map([
    ['a', 0], ['b', 0], ['c', 0], ['d', 0], ['e', 0], ['f', 1], ['g', 1],
  ]);
  const m = Core.matchGroups(prev, next, membership);
  for (const p of ['a', 'b', 'c', 'd']) assert.equal(m.personDetail.get(p).stable, true, p);
  assert.equal(m.personDetail.get('e').stable, false);
  assert.equal(m.personDetail.get('f').stable, true);
});

test('excluding one large matter can split a component and is compared by membership', () => {
  const g = build();
  const order = orderOf(g);
  const base = Core.groupGraph(g.W, { k: 5, order });
  const after = Core.excludeMatters(g, ['X-01']);
  const split = Core.componentsOf(after.W, order);
  assert.equal(split.components.length, 3, 'supply group should detach into its own component');
  const next = Core.groupGraph(after.W, { k: 5, order });
  const cmp = Core.compareRuns(base, next, { nodeCount: g.people.length });
  assert.equal(cmp.summary.isolated, 2);
  assert.ok(cmp.summary.stable > 0);
  // At least part of the detached supply group is reported as moved; its
  // rump may survive if the regrouped remainder still matches by overlap.
  const supply = ['赵岑', '钱野', '孙铠', '李沐', '吴霜'];
  const movedSupply = supply.filter((name) => {
    const rec = cmp.nodeRecords.find((r) => g.people[r.node] === name);
    return rec.status === 'moved';
  });
  assert.ok(movedSupply.length >= 3, 'the detached group should mostly count as moved');
  // And the pairs they had with the rest are recorded as lost, by membership.
  const lostCross = cmp.togetherPairs.filter((p) => !p.kept);
  assert.ok(lostCross.length > 0);
});

test('perturbation only touches positive weights, so components and isolated people are fixed', () => {
  const g = build();
  const res = Core.perturbWeights(g.W, { k: 5, order: orderOf(g), trials: 24, sigma: 0.12 });
  assert.equal(res.history.length, 24);
  for (const h of res.history) assert.ok(Number.isFinite(h.changed));
  const byNode = new Map(res.stability.map((s) => [s.node, s]));
  for (const iso of Core.componentsOf(g.W, orderOf(g)).isolated) {
    assert.equal(byNode.get(iso).grouped, false);
  }
});

test('perturbation flags boundary people instead of giving them a label', () => {
  const g = build();
  const res = Core.perturbWeights(g.W, { k: 5, order: orderOf(g), trials: 120, sigma: 0.1 });
  assert.ok(res.unstable.length > 0, 'the bridge person should be flagged as unstable');
  for (const u of res.unstable) {
    assert.ok(u.rate >= res.threshold);
    assert.ok(g.people[u.node]);
  }
});

test('invalid rows are reported and do not abort the import', () => {
  const g = Core.buildGraph(
    [
      { id: 'ok', people: ['甲', '乙'] },
      { id: '', people: ['甲', '乙'] },
      { id: 'solo', people: ['甲'] },
      { id: 'bad-year', year: 'soon', people: ['甲', '乙'] },
      { id: 'bad-weight', weight: -1, people: ['甲', '乙'] },
    ],
    { roster: ['甲', '乙'] }
  );
  assert.equal(g.stats.matters, 1);
  assert.equal(g.stats.invalidDropped, 4);
  assert.equal(g.stats.errors.length, 4);
});

test('the empty graph is handled without NaN', () => {
  const g = Core.buildGraph([], { roster: [] });
  const res = Core.groupGraph(g.W, { k: 3 });
  assert.deepEqual(res.groups, []);
  const p = Core.perturbWeights(g.W, { k: 3, trials: 3 });
  assert.deepEqual(p.unstable, []);
});
