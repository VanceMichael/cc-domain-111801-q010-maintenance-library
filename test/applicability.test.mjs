import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCondition, evaluateCondition, combineResults } from '../src/conditions.mjs';
import { interpretEquipmentState, diffStates } from '../src/equipment.mjs';
import { interpretRelations } from '../src/relations.mjs';

const stateOf = modifications => ({ unit: 'u', equipment: 'EQ-A', modifications: Object.fromEntries(modifications.map(m => [m.modification, m.status])) });

test('条件解析拒绝无法解释的声明', () => {
  assert.deepEqual(parseCondition('M-installed'), { modification: 'M', expectation: 'installed' });
  assert.throws(() => parseCondition('M'), /无法解释/);
  assert.throws(() => parseCondition(42), /无效/);
});

test('未登记的改装状态是未知而不是未安装', () => {
  const state = stateOf([{ modification: 'M', status: 'installed' }]);
  assert.equal(evaluateCondition('M-installed', state), 'met');
  assert.equal(evaluateCondition('M-absent', state), 'not-met');
  assert.equal(evaluateCondition('N-installed', state), 'unknown');
  assert.equal(evaluateCondition('N-absent', state), 'unknown');
});

test('显式无条件声明对任何设备状态都满足', () => {
  assert.equal(evaluateCondition('unconditional', stateOf([])), 'met');
  assert.equal(evaluateCondition('unconditional', stateOf([{ modification: 'M', status: 'absent' }])), 'met');
});

test('三态合取遵循不满足优先、未知次之', () => {
  assert.equal(combineResults([{ result: 'met' }, { result: 'not-met' }]), 'not-met');
  assert.equal(combineResults([{ result: 'met' }, { result: 'unknown' }]), 'unknown');
  assert.equal(combineResults([{ result: 'met' }]), 'met');
});

test('设备装配记录保留未知改装并拒绝重复与非法状态', () => {
  const state = interpretEquipmentState({ unit: 'u1', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'absent' }] });
  assert.equal(state.modifications.M, 'absent');
  assert.equal(state.modifications.N, undefined);
  assert.throws(() => interpretEquipmentState({ unit: 'u1', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'gone' }] }), /改装状态/);
  assert.throws(() => interpretEquipmentState({ unit: 'u1', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'absent' }, { modification: 'M', status: 'installed' }] }), /重复/);
  assert.throws(() => interpretEquipmentState({ unit: '', equipment: 'EQ-A', modifications: [] }));
});

test('状态补正的差异能够区分未知、未安装与已安装', () => {
  const before = interpretEquipmentState({ unit: 'u1', equipment: 'EQ-A', modifications: [] });
  const after = interpretEquipmentState({ unit: 'u1', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'installed' }] });
  assert.deepEqual(diffStates(before, after), [{ modification: 'M', from: null, to: 'installed' }]);
});

test('文档级适用性只约束没有自带条件的引用，自带条件的引用以自身为准', () => {
  const parsed = interpretRelations({
    applicability: { modification: 'M' },
    references: [
      { module: 'DM300', issue: '1', kind: 'fixed' },
      { module: 'DM200', issue: '2', condition: 'N-absent', kind: 'fixed' },
      { module: 'DM400', issue: '1', condition: 'unconditional', kind: 'fixed' },
    ],
  });
  assert.deepEqual(parsed.references[0].conditions, ['M-installed']);
  assert.deepEqual(parsed.references[1].conditions, ['N-absent']);
  assert.deepEqual(parsed.references[2].conditions, ['unconditional']);
});

test('替代引用必须声明组，重复引用与非法类型被拒绝', () => {
  assert.throws(() => interpretRelations({ references: [{ module: 'A', issue: '1', kind: 'alternative' }] }), /group/);
  assert.throws(() => interpretRelations({ references: [{ module: 'A', issue: '1', kind: 'weird' }] }), /类型/);
  assert.throws(() => interpretRelations({ references: [
    { module: 'A', issue: '1', kind: 'fixed' },
    { module: 'A', issue: '1', kind: 'fixed' },
  ] }), /重复/);
  assert.equal(interpretRelations({ references: [] }).references.length, 0);
});
