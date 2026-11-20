import test from 'node:test';
import assert from 'node:assert/strict';
import { planPackage } from '../src/planner.mjs';
import { assess } from '../src/receiving.mjs';

const record = (module, issue, extra = {}) => ({
  module, issue, equipment: 'EQ-A', title: module + ' 标题', approved: true, body: '正文 ' + module, ...extra,
});

// 内存来源：records[module:issue]、relations[module]，可通过 missing 模拟来源撤下
function memorySource({ records, relations, missingRecords = new Set(), missingRelations = new Set() }) {
  return {
    async fetchRecord(module, issue) {
      const key = module + ':' + issue;
      if (missingRecords.has(key)) return { available: false, status: 404, reason: '来源资料不存在' };
      if (!records.has(key)) return { available: false, status: 404, reason: '来源资料不存在' };
      return { available: true, document: { raw: records.get(key), digest: 'd-' + key } };
    },
    async fetchRelations(module) {
      if (missingRelations.has(module)) return { path: '/library/equipment/relations/' + module, available: false, status: 404, reason: '来源资料不存在' };
      const refs = relations.get(module) ?? [];
      return { path: '/library/equipment/relations/' + module, available: true, references: refs.map(ref => ({ ...ref, conditions: ref.conditions ?? [] })) };
    },
  };
}

const acceptAll = () => ({ status: 'accepted' });
const state = modifications => ({ unit: 'u1', equipment: 'EQ-A', modifications: Object.fromEntries(modifications) });
const fixed = (module, issue, conditions = []) => ({ module, issue, kind: 'fixed', conditions, group: null });
const alternative = (module, issue, group, conditions = []) => ({ module, issue, kind: 'alternative', group, conditions });

test('条件不满足的分支被排除且不计缺件，条件未知则挂起', async () => {
  const loader = memorySource({
    records: new Map([['DM100:1', record('DM100', '1')], ['DM200:1', record('DM200', '1')]]),
    relations: new Map([['DM100', [
      fixed('DM200', '1', ['M-installed']),
    ]]]),
  });
  const excluded = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([['M', 'absent']]), loader, assessRecord: acceptAll,
  });
  assert.equal(excluded.complete, true);
  assert.equal(excluded.nodes.find(n => n.key === 'DM200:1').status, 'excluded');
  assert.equal(excluded.blocking.length, 0);

  const unresolved = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([]), loader, assessRecord: acceptAll,
  });
  assert.equal(unresolved.complete, false);
  const node = unresolved.nodes.find(n => n.key === 'DM200:1');
  assert.equal(node.status, 'unresolved-condition');
  assert.match(node.reason, /不能判定不适用/);
});

test('固定前置满足时必须纳入，沿引用链继续收集', async () => {
  const loader = memorySource({
    records: new Map([
      ['DM100:1', record('DM100', '1')],
      ['DM200:1', record('DM200', '1')],
      ['DM250:1', record('DM250', '1')],
    ]),
    relations: new Map([
      ['DM100', [fixed('DM200', '1', ['M-installed'])]],
      ['DM200', [fixed('DM250', '1')]],
      ['DM250', []],
    ]),
  });
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([['M', 'installed']]), loader, assessRecord: acceptAll,
  });
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.nodes.map(n => n.key).sort(), ['DM100:1', 'DM200:1', 'DM250:1']);
  assert.ok(plan.nodes.every(n => n.status === 'included'));
});

test('替代组：固定资料可用时替代只作待批准建议，不阻断也不自动批准', async () => {
  const loader = memorySource({
    records: new Map([
      ['DM100:1', record('DM100', '1')],
      ['G500:1', record('G500', '1')],
      ['G500:2', record('G500', '2')],
    ]),
    relations: new Map([['DM100', [
      fixed('G500', '1', ['N-installed']),
      alternative('G500', '2', 'G', ['N-absent']),
    ]]]),
  });
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([['N', 'absent']]), loader, assessRecord: acceptAll,
  });
  const alt = plan.nodes.find(n => n.key === 'G500:2');
  assert.equal(alt.status, 'substitute-proposed');
  assert.match(alt.reason, /技术负责人批准/);
  assert.equal(plan.complete, false);
  assert.ok(plan.observations.some(o => o.code === 'substitute-awaiting-approval'));
});

test('固定版次被来源撤下且无可用替代时保留真实缺口，不套用最新版', async () => {
  const loader = memorySource({
    records: new Map([
      ['DM100:1', record('DM100', '1')],
      ['G500:2', record('G500', '2')],
    ]),
    relations: new Map([['DM100', [
      fixed('G500', '1', ['N-installed']),
      alternative('G500', '2', 'G', ['N-absent']),
    ]]]),
  });
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([['N', 'installed']]), loader, assessRecord: acceptAll,
  });
  const missing = plan.nodes.find(n => n.key === 'G500:1');
  assert.equal(missing.status, 'record-missing');
  assert.match(missing.reason, /真实缺口/);
  assert.equal(plan.complete, false);
});

test('替代组全部分支不满足时整体排除，不算缺件', async () => {
  const loader = memorySource({
    records: new Map([['DM100:1', record('DM100', '1')]]),
    relations: new Map([['DM100', [
      fixed('G500', '1', ['N-installed']),
      alternative('G500', '2', 'G', ['N-absent', 'X-installed']),
    ]]]),
  });
  // N 明确未安装（固定分支不满足），X 也明确未安装（替代分支同样不满足）
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([['N', 'absent'], ['X', 'absent']]), loader, assessRecord: acceptAll,
  });
  assert.equal(plan.complete, true);
  assert.ok(plan.nodes.filter(n => n.group === 'G').every(n => n.status === 'excluded'));
});

test('来源声明为 generic 的通用警示可纳入具体设备的包', async () => {
  const loader = memorySource({
    records: new Map([
      ['DM100:1', record('DM100', '1')],
      ['DM400:1', record('DM400', '1', { equipment: 'generic' })],
    ]),
    relations: new Map([['DM100', [fixed('DM400', '1')]]]),
  });
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([]), loader, assessRecord: acceptAll,
  });
  assert.equal(plan.nodes.find(n => n.key === 'DM400:1').status, 'included');
});

test('设备类别不匹配与未核准资料阻断资料包', async () => {
  const loader = memorySource({
    records: new Map([
      ['DM100:1', record('DM100', '1')],
      ['DM300:1', record('DM300', '1', { equipment: 'EQ-B' })],
      ['DM350:1', record('DM350', '1', { approved: false })],
    ]),
    relations: new Map([['DM100', [fixed('DM300', '1'), fixed('DM350', '1')]]]),
  });
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([]), loader,
    assessRecord: (r, prev, equipment) => assess(r, prev, equipment, { allowGeneric: true }),
  });
  assert.equal(plan.nodes.find(n => n.key === 'DM300:1').status, 'scope-mismatch');
  assert.equal(plan.nodes.find(n => n.key === 'DM350:1').status, 'not-approved');
  assert.equal(plan.complete, false);
});

test('关联声明取不回时阻断而不是假定没有前置引用', async () => {
  const loader = memorySource({
    records: new Map([['DM100:1', record('DM100', '1')]]),
    relations: new Map(),
    missingRelations: new Set(['DM100']),
  });
  const plan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([]), loader, assessRecord: acceptAll,
  });
  assert.equal(plan.nodes[0].status, 'relation-unavailable');
  assert.equal(plan.complete, false);
});

test('引用成环时遍历安全终止', async () => {
  const loader = memorySource({
    records: new Map([
      ['A:1', record('A', '1')],
      ['B:1', record('B', '1')],
    ]),
    relations: new Map([
      ['A', [fixed('B', '1')]],
      ['B', [fixed('A', '1')]],
    ]),
  });
  const plan = await planPackage({
    seed: { module: 'A', issue: '1' }, state: state([]), loader, assessRecord: acceptAll,
  });
  assert.deepEqual(plan.nodes.map(n => n.key).sort(), ['A:1', 'B:1']);
  assert.equal(plan.complete, true);
});

test('同版次内容冲突阻断，原文无法解释时记为 record-error', async () => {
  const conflictLoader = memorySource({
    records: new Map([['DM100:1', record('DM100', '1')], ['DM200:1', record('DM200', '1')]]),
    relations: new Map([['DM100', [fixed('DM200', '1')]]]),
  });
  const conflictPlan = await planPackage({
    seed: { module: 'DM100', issue: '1' }, state: state([]), loader: conflictLoader,
    assessRecord: (r, prev) => r.module === 'DM200' ? { status: 'conflict', reason: '同版维修资料内容不同' } : { status: 'accepted' },
  });
  assert.equal(conflictPlan.nodes.find(n => n.key === 'DM200:1').status, 'conflict');

  const brokenLoader = {
    async fetchRecord() {
      return { available: true, document: { raw: { module: 'DM200' }, digest: 'd-broken' } };
    },
    async fetchRelations() { return { path: '/x', available: true, references: [] }; },
  };
  const brokenPlan = await planPackage({
    seed: { module: 'DM200', issue: '1' }, state: state([]), loader: brokenLoader, assessRecord: acceptAll,
  });
  assert.equal(brokenPlan.nodes.find(n => n.key === 'DM200:1').status, 'record-error');
});
