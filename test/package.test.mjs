import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { assemblePackage, reassessPackage } from '../src/package.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const scope = 'EQ-A';

async function harness() {
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'package-'));
  const archive = await new Archive(directory).start();
  const client = new SourceClient(source.url);
  return {
    source, archive, client,
    async close() { archive.close(); await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

const stateUnit100 = { unit: 'unit-100', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'installed' }] };
const stateUnit200 = { unit: 'unit-200', equipment: 'EQ-A', modifications: [
  { modification: 'M', status: 'absent' }, { modification: 'N', status: 'absent' },
] };

test('已改装设备的资料包沿引用纳入前置检查、二级警示与通用警示', async () => {
  const h = await harness();
  try {
    const pkg = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit100, seedModule: 'DM100' });
    const keys = pkg.items.map(item => item.key);
    assert.ok(keys.includes('DM100:2'));
    assert.ok(keys.includes('DM200:2'));
    assert.ok(keys.includes('DM250:1'));
    assert.ok(keys.includes('DM300:1'));
    const generic = pkg.items.find(item => item.key === 'DM400:1');
    assert.equal(generic.node.status, 'included');
    // DM600 issue 1 被引用但来源从未发布该版次原文：真实缺口，不套用最新版
    const gap = pkg.items.find(item => item.key === 'DM600:1');
    assert.equal(gap.node.status, 'record-missing');
    assert.equal(pkg.plan.complete, false);
    // 原文按摘要保管且可复查
    const bytes = await h.archive.original(gap.node.digest ?? pkg.items[0].digest);
    assert.ok(bytes.length > 0);
  } finally { await h.close(); }
});

test('未改装设备：改装专属分支被排除且不计缺件，替代分支作为待批准建议', async () => {
  const h = await harness();
  try {
    const pkg = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit200, seedModule: 'DM100' });
    const byKey = new Map(pkg.items.map(item => [item.key, item.node]));
    assert.equal(byKey.get('DM200:2').status, 'excluded');
    // 父引用被排除后其下游分支不再展开，避免把不可达分支当成缺件
    assert.equal(byKey.has('DM250:1'), false);
    assert.equal(byKey.get('DM600:1').status, 'excluded');
    assert.equal(byKey.get('DM500:1').status, 'excluded');
    assert.equal(byKey.get('DM500:2').status, 'substitute-proposed');
    assert.equal(pkg.plan.complete, false);
    assert.ok(pkg.plan.observations.some(o => o.code === 'substitute-awaiting-approval'));
  } finally { await h.close(); }
});

test('改装记录补正后复核旧包：新增必需分支并解释原包为何不再充分', async () => {
  const h = await harness();
  try {
    const original = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit200, seedModule: 'DM100' });
    const corrected = { unit: 'unit-200', equipment: 'EQ-A', modifications: [
      { modification: 'M', status: 'installed' }, { modification: 'N', status: 'absent' },
    ] };
    const review = await reassessPackage({ client: h.client, archive: h.archive, packageId: original.packageId, stateRaw: corrected });
    assert.equal(review.review.sufficient, false);
    assert.match(review.review.explanation, /不再足以/);
    const gained = review.review.findings.find(f => f.key === 'DM200:2');
    assert.equal(gained.change, 'gained');
    assert.deepEqual(review.changes, [{ modification: 'M', from: 'absent', to: 'installed' }]);
    // 旧包快照不可变：仍记录当时的排除结论
    const stored = h.archive.getPackage(original.packageId);
    assert.equal(stored.items.find(i => i.key === 'DM200:2').node.status, 'excluded');
    // 复核只追加
    assert.equal(h.archive.listReviews(original.packageId).length, 1);
  } finally { await h.close(); }
});

test('条件未知不能当成不适用：缺装配记录的改装以挂起缺口呈现', async () => {
  const h = await harness();
  try {
    const unknownState = { unit: 'unit-300', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'installed' }] };
    const pkg = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: unknownState, seedModule: 'DM100' });
    const node = pkg.items.find(item => item.key === 'DM500:1').node;
    assert.equal(node.status, 'unresolved-condition');
    assert.match(node.reason, /不能判定不适用/);
    assert.equal(pkg.plan.complete, false);
  } finally { await h.close(); }
});

test('门户撤下曾发布的旧版且无合法替代时保留真实缺口', async () => {
  const h = await harness();
  try {
    // 先在 DM600 issue 1 可用时建包
    h.source.replace('/library/equipment/records/DM600', { body: {
      module: 'DM600', issue: '1', equipment: 'EQ-A', title: '旧版警示', approved: true, body: '旧版原文',
    } });
    const before = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit100, seedModule: 'DM100' });
    assert.equal(before.items.find(i => i.key === 'DM600:1').node.status, 'included');
    // 门户撤下该版次，也没有给出替代声明
    h.source.replace('/library/equipment/records/DM600', { status: 404, body: { error: '已撤下' } });
    const review = await reassessPackage({ client: h.client, archive: h.archive, packageId: before.packageId, stateRaw: stateUnit100 });
    assert.equal(review.review.sufficient, false);
    const lost = review.review.findings.find(f => f.key === 'DM600:1');
    assert.equal(lost.change, 'lost');
    assert.match(lost.reason, /真实缺口/);
    // 已保管的旧原文不被删除或覆盖
    const stored = h.archive.getPackage(before.packageId);
    const digest = stored.items.find(i => i.key === 'DM600:1').digest;
    const original = await h.archive.original(digest);
    assert.match(original.toString(), /旧版原文/);
  } finally { await h.close(); }
});

test('通用警示供多个设备使用，一个设备的适用性变化不影响另一个设备的包', async () => {
  const h = await harness();
  try {
    const pkg100 = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit100, seedModule: 'DM100' });
    const pkg200 = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit200, seedModule: 'DM100' });
    const digest100 = pkg100.items.find(i => i.key === 'DM400:1').digest;
    const digest200 = pkg200.items.find(i => i.key === 'DM400:1').digest;
    // 同一份通用警示原文按内容寻址，只存一份，两个包各自引用
    assert.equal(digest100, digest200);
    assert.equal(pkg200.items.find(i => i.key === 'DM400:1').node.status, 'included');
    // unit-100 补正记录触发复核，不改变 unit-200 包内通用警示的纳入状态
    const corrected = { unit: 'unit-100', equipment: 'EQ-A', modifications: [
      { modification: 'M', status: 'installed' }, { modification: 'N', status: 'installed' },
    ] };
    await reassessPackage({ client: h.client, archive: h.archive, packageId: pkg100.packageId, stateRaw: corrected });
    const untouched = h.archive.getPackage(pkg200.packageId);
    assert.equal(untouched.items.find(i => i.key === 'DM400:1').node.status, 'included');
  } finally { await h.close(); }
});

test('关联声明取不回时阻断而不是假设没有前置引用', async () => {
  const h = await harness();
  try {
    h.source.replace('/library/equipment/relations/DM100', { status: 403, body: { error: '无权查看' } });
    const pkg = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit100, seedModule: 'DM100' });
    assert.equal(pkg.items[0].node.status, 'relation-unavailable');
    assert.equal(pkg.plan.complete, false);
  } finally { await h.close(); }
});

test('资料包与复核记录持久化，重开归档后仍可复查', async () => {
  const h = await harness();
  let directory;
  let packageId;
  try {
    const pkg = await assemblePackage({ client: h.client, archive: h.archive, scope, stateRaw: stateUnit100, seedModule: 'DM100' });
    packageId = pkg.packageId;
    directory = h.archive.directory;
    await reassessPackage({ client: h.client, archive: h.archive, packageId, stateRaw: stateUnit100 });
    h.archive.close();
    const reopened = await new Archive(directory).start();
    const stored = reopened.getPackage(packageId);
    assert.equal(stored.unit, 'unit-100');
    assert.ok(stored.items.length >= 6);
    assert.equal(reopened.listReviews(packageId).length, 1);
    assert.ok(reopened.listPackages(scope).some(row => row.package_id === packageId));
    reopened.close();
  } finally { await h.close(); }
});
