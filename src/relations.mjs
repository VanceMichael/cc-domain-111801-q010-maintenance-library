import { text } from './validation.mjs';
import { parseCondition } from './conditions.mjs';

// 关联资料的位置约定：/library/equipment/relations/{module}
export function relationPath(module) {
  return '/library/equipment/relations/' + module;
}

export function recordPath(module) {
  return '/library/equipment/records/' + module;
}

// 解释来源发布的关联资料。文档级 applicability 是门户对整份关联声明的适用声明：
// 它只约束没有自带条件的引用；引用一旦声明了自己的 condition，就以引用条件为准，
// 避免把整份文档的改装门控错误地强加到通用警示等无条件引用上。
export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('关联资料不是对象');
  const documentGate = [];
  if (raw.applicability !== undefined) {
    if (!raw.applicability || typeof raw.applicability !== 'object' || Array.isArray(raw.applicability)) {
      throw new Error('关联资料适用声明无效');
    }
    if (typeof raw.applicability.modification === 'string') {
      documentGate.push(parseCondition(raw.applicability.modification + '-installed'));
    }
  }
  if (!Array.isArray(raw.references)) throw new Error('关联资料引用列表无效');
  const references = [];
  for (const entry of raw.references) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('关联引用条目无效');
    const kind = text(entry.kind, 'kind');
    if (kind !== 'fixed' && kind !== 'alternative') throw new Error('关联引用类型无效：' + kind);
    // 引用自带 condition 时以自身为准（含显式 unconditional）；否则继承文档级适用声明
    const conditions = typeof entry.condition === 'string'
      ? [entry.condition]
      : documentGate.map(gate => gate.modification + '-' + gate.expectation);
    const reference = {
      module: text(entry.module, 'module'),
      issue: text(entry.issue, 'issue'),
      kind,
      conditions,
      group: null,
    };
    if (kind === 'alternative') reference.group = text(entry.group, 'group');
    references.push(reference);
  }
  const identities = new Set();
  for (const reference of references) {
    const identity = reference.module + ':' + reference.issue;
    if (identities.has(identity)) throw new Error('关联资料包含重复引用：' + identity);
    identities.add(identity);
  }
  return { references };
}

// 取关联资料。HTTP 404/403/503 不能自行解释为业务删除或“无引用”，
// 交给计划器作为声明缺口记录，而不是凭空假定该页没有前置引用。
export async function fetchRelations(client, module) {
  const path = relationPath(module);
  try {
    const document = await client.get(path);
    const parsed = interpretRelations(document.raw);
    return { path, available: true, document, references: parsed.references };
  } catch (error) {
    const status = error?.status ?? 0;
    return { path, available: false, status, reason: error.message };
  }
}
