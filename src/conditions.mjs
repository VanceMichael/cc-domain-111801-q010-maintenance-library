// 适用条件的声明语法与三态评估。
// 设备装配记录只陈述已知事实：已安装、未安装；未提及的改装属于未知，
// 不能把空白或缺失值转换成“未安装”。
const CONDITION_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*)-(installed|absent)$/;
export const UNCONDITIONAL = 'unconditional';

export function parseCondition(condition) {
  if (typeof condition !== 'string') throw new Error('适用条件声明无效：' + String(condition));
  if (condition === UNCONDITIONAL) return { unconditional: true };
  const match = CONDITION_PATTERN.exec(condition);
  if (!match) throw new Error('适用条件声明无法解释：' + condition);
  return { modification: match[1], expectation: match[2] };
}

// 返回 'met' | 'not-met' | 'unknown'
export function evaluateCondition(condition, state) {
  const parsed = parseCondition(condition);
  if (parsed.unconditional) return 'met';
  const actual = state.modifications[parsed.modification];
  if (actual !== 'installed' && actual !== 'absent') return 'unknown';
  return actual === parsed.expectation ? 'met' : 'not-met';
}

// 三态合取：任一不满足即不满足；否则任一未知即未知；全部满足（或无条件）才满足。
export function combineResults(results) {
  if (results.some(result => result.result === 'not-met')) return 'not-met';
  if (results.some(result => result.result === 'unknown')) return 'unknown';
  return 'met';
}
