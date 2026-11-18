import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"module": "DM100", "issue": "2", "equipment": "EQ-A", "title": "安全检查", "approved": true, "body": "断电后进行外观检查"};
const scope = "EQ-A";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.issue, raw.issue);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"module": "DM100", "issue": "2", "equipment": "EQ-A", "title": "安全检查", "approved": true, "body": "不同操作"});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});
test('缺少领域核准或接纳依据时保留待处理', () => {
  assert.notEqual(assess(interpret({"module": "DM100", "issue": "2", "equipment": "EQ-A", "title": "安全检查", "approved": false, "body": "断电后进行外观检查"}), [], scope).status, 'accepted');
});
