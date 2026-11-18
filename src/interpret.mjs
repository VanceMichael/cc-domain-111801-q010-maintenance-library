import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (typeof raw.approved !== 'boolean') throw new Error('资料核准状态无效');
           return { module: text(raw.module, 'module'), issue: text(raw.issue, 'issue'), equipment: text(raw.equipment, 'equipment'), title: text(raw.title, 'title'), body: text(raw.body, 'body'), approved: raw.approved };
}
