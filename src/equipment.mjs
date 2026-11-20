import { text } from './validation.mjs';

// 解释一台具体设备的装配记录。modifications 中没有出现的改装保持未知，
// 调用方据此区分“明确未安装”与“尚无记录”。
export function interpretEquipmentState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设备装配记录不是对象');
  const unit = text(raw.unit, 'unit');
  const equipment = text(raw.equipment, 'equipment');
  if (!Array.isArray(raw.modifications)) throw new Error('设备改装记录无效');
  const modifications = {};
  for (const entry of raw.modifications) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('改装记录条目无效');
    const modification = text(entry.modification, 'modification');
    if (entry.status !== 'installed' && entry.status !== 'absent') throw new Error('改装状态无效：' + modification);
    if (modifications[modification]) throw new Error('同一改装存在重复装配记录：' + modification);
    modifications[modification] = entry.status;
  }
  return { unit, equipment, modifications };
}

export function diffStates(previous, next) {
  const changes = [];
  const keys = new Set([...Object.keys(previous.modifications), ...Object.keys(next.modifications)]);
  for (const modification of [...keys].sort()) {
    const before = previous.modifications[modification] ?? null;
    const after = next.modifications[modification] ?? null;
    if (before !== after) changes.push({ modification, from: before, to: after });
  }
  return changes;
}
