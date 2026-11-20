import { evaluateCondition, combineResults } from './conditions.mjs';
import { fetchRelations, recordPath } from './relations.mjs';
import { interpret } from './interpret.mjs';

const BLOCKING_STATUSES = new Set([
  'record-missing', 'record-error', 'not-approved', 'scope-mismatch',
  'conflict', 'unresolved-condition', 'relation-unavailable',
  'group-gap', 'group-unresolved', 'substitute-proposed', 'substitute-alternate',
]);

function issueKey(module, issue) {
  return module + ':' + issue;
}

function describeGates(results) {
  return results.gates
    .map(gate => gate.condition + '=' + gate.result)
    .join(', ');
}

// 设备类别归属：明确匹配设备，或来源声明为通用资料（equipment: "generic"）
function fitsScope(record, equipment) {
  return record.equipment === equipment || record.equipment === 'generic';
}

/*
 * 依据设备装配状态与门户适用声明规划一个作业资料包。
 *
 * loader 负责来源 I/O，便于单元测试：
 *   loader.fetchRecord(module, issue) -> { available, document?, status?, reason? }
 *   loader.fetchRelations(module)     -> { path, available, document?, references?, status?, reason? }
 * assessRecord(record, prior) -> 领域收件结论（accepted/review/conflict 等）
 *
 * 节点状态语义：
 *   included             条件满足且原文可纳入
 *   excluded             条件不满足，明确排除，不是缺件
 *   unresolved-condition 条件依赖的改装状态尚无记录，不能当成不适用
 *   record-missing       条件要求该版次，但来源取不回原文（真实缺口，不套用最新版）
 *   record-error         原文取回但无法解释或身份不符
 *   not-approved/scope-mismatch/conflict 领域检查未通过
 *   relation-unavailable 关联声明取不回，引用链完整性未知
 */
export async function planPackage({ seed, state, loader, assessRecord, priorRecords = [] }) {
  const nodes = new Map();
  const observations = [];
  const enqueue = [];

  const note = (level, code, message) => observations.push({ level, code, message });

  const seedNode = {
    module: seed.module,
    issue: seed.issue,
    key: issueKey(seed.module, seed.issue),
    title: null,
    kind: 'seed',
    group: null,
    condition: { result: 'met', gates: [] },
    status: null,
    reason: null,
    record: null,
    recordPath: recordPath(seed.module),
    relationPath: null,
    digest: null,
  };
  nodes.set(seedNode.key, seedNode);

  const seenDeclarations = new Set();
  const fetchedRecords = new Set();
  const fetchedRelations = new Set();
  const enqueued = new Set([seedNode.key]);
  enqueue.push({ module: seed.module, issue: seed.issue, kind: 'seed', group: null, conditions: [] });

  while (enqueue.length) {
    const declaration = enqueue.shift();
    const key = issueKey(declaration.module, declaration.issue);
    const node = nodes.get(key);
    const gates = declaration.conditions.map(condition => ({ condition, result: evaluateCondition(condition, state) }));
    const gateOutcome = combineResults(gates);

    if (!node) {
      nodes.set(key, {
        module: declaration.module,
        issue: declaration.issue,
        key,
        title: null,
        kind: declaration.kind,
        group: declaration.group,
        condition: { result: gateOutcome, gates },
        status: null,
        reason: null,
        record: null,
        recordPath: recordPath(declaration.module),
        relationPath: null,
        digest: null,
      });
    }
    const current = nodes.get(key);
    current.condition = { result: gateOutcome, gates };
    // 同一版次被多条路径引用：种子与固定引用的身份优先于替代分支
    if (declaration.kind === 'fixed' && current.kind === 'alternative') current.kind = 'fixed';
    if (declaration.kind === 'seed') current.kind = 'seed';
    if (declaration.group && !current.group) current.group = declaration.group;
    const declarationId = key + '|' + describeGates({ gates });
    if (seenDeclarations.has(declarationId)) {
      note('info', 'duplicate-reference', '资料 ' + key + ' 经相同条件的多条路径引用，合并为一个节点');
    }
    seenDeclarations.add(declarationId);

    if (gateOutcome === 'not-met') {
      current.status = 'excluded';
      current.reason = '适用条件不满足，排除且不计缺件：' + describeGates(current.condition);
      continue;
    }
    if (gateOutcome === 'unknown') {
      current.status = 'unresolved-condition';
      current.reason = '适用条件依赖的改装状态尚无记录，不能判定不适用：' + describeGates(current.condition);
      continue;
    }

    // 条件满足：按明确的 module+issue 精确取件，绝不自动替换为最新版。
    // 同一版次被多条路径引用时复用已取得的原文与已验证的关联声明。
    let fetched;
    if (fetchedRecords.has(key)) {
      fetched = current.cachedFetch;
    } else {
      fetched = await loader.fetchRecord(declaration.module, declaration.issue);
      fetchedRecords.add(key);
      current.cachedFetch = fetched;
    }
    if (!fetched.available) {
      current.status = 'record-missing';
      current.reason = '该版次原文无法从来源取得（HTTP ' + (fetched.status ?? 0) + '），保留真实缺口：' + (fetched.reason ?? '');
      note('error', 'record-missing', key + ' 来源未提供该版次原文，不能套用其他版次');
      continue;
    }

    let record;
    try {
      record = interpret(fetched.document.raw);
    } catch (error) {
      current.status = 'record-error';
      current.reason = error.message;
      continue;
    }
    // 引用要求的是明确版次；来源给回的资料号/版次不符，等同该版次未提供，
    // 保留真实缺口而不是用来源当前版本顶替
    if (record.module !== declaration.module || record.issue !== declaration.issue) {
      current.status = 'record-missing';
      current.reason = '来源未提供引用版次 ' + declaration.module + ':' + declaration.issue +
        '（实际返回 ' + record.module + ':' + record.issue + '），不套用其他版次';
      note('error', 'record-missing', current.key + ' 的引用版次来源未提供，不能套用其他版次');
      current.record = record;
      current.title = record.title;
      current.digest = fetched.document.digest ?? null;
      continue;
    }
    current.record = record;
    current.title = record.title;
    current.digest = fetched.document.digest ?? null;

    if (!fitsScope(record, state.equipment)) {
      current.status = 'scope-mismatch';
      current.reason = '原文声明设备类别为 ' + record.equipment + '，与当前设备 ' + state.equipment + ' 不符';
      continue;
    }

    const decision = assessRecord(record, priorRecords, state.equipment);
    if (decision.status !== 'accepted') {
      current.status = decision.status === 'review' ? 'not-approved' : decision.status;
      current.reason = decision.reason;
      continue;
    }

    current.status = 'included';
    current.reason = '适用条件满足且领域检查通过' + (gates.length ? '（' + describeGates(current.condition) + '）' : '');

    // 继续沿该版次的关联声明收集前置检查、警示与替代分支
    let relations;
    if (fetchedRelations.has(declaration.module)) {
      relations = current.cachedRelations;
    } else {
      relations = await loader.fetchRelations(declaration.module);
      fetchedRelations.add(declaration.module);
      current.cachedRelations = relations;
    }
    current.relationPath = relations.path;
    if (!relations.available) {
      // 曾经可用而现在 404/403/503，不能被解释为“该页没有引用”
      current.status = 'relation-unavailable';
      current.reason = '关联资料取不回（HTTP ' + (relations.status ?? 0) + '），引用链完整性未知：' + relations.reason;
      note('error', 'relation-unavailable', declaration.module + ' 的关联资料不可用：' + relations.reason);
      continue;
    }
    for (const reference of relations.references) {
      const childKey = issueKey(reference.module, reference.issue);
      if (!nodes.has(childKey)) {
        nodes.set(childKey, {
          module: reference.module,
          issue: reference.issue,
          key: childKey,
          title: null,
          kind: reference.kind,
          group: reference.group,
          condition: { result: 'none', gates: [] },
          status: null,
          reason: null,
          record: null,
          recordPath: recordPath(reference.module),
          relationPath: null,
          digest: null,
        });
      }
      // 同一版次只处理一次（已取回的原文与关联声明在节点上缓存），环引用安全终止
      if (enqueued.has(childKey)) continue;
      enqueued.add(childKey);
      enqueue.push({
        module: reference.module,
        issue: reference.issue,
        kind: reference.kind,
        group: reference.group,
        conditions: reference.conditions,
      });
    }
  }

  resolveAlternativeGroups(nodes, note);

  const list = [...nodes.values()].map(node => {
    const { cachedFetch, cachedRelations, ...clean } = node;
    return clean;
  }).sort((a, b) => a.key.localeCompare(b.key));
  const blocking = list.filter(node => BLOCKING_STATUSES.has(node.status));
  return {
    seed: { module: seed.module, issue: seed.issue },
    equipment: state.equipment,
    unit: state.unit,
    complete: blocking.length === 0,
    blocking: blocking.map(node => ({ key: node.key, status: node.status, reason: node.reason })),
    nodes: list,
    observations,
  };
}

// 替代组：门户声明允许在适用范围内以 alternative 成员替代 fixed 成员。
// 系统只提出替代建议并保持待批准，绝不替技术负责人批准替代。
function resolveAlternativeGroups(nodes, note) {
  const groups = new Map();
  for (const node of nodes.values()) {
    if (!node.group) continue;
    if (!groups.has(node.group)) groups.set(node.group, []);
    groups.get(node.group).push(node);
  }
  const hardGapStatuses = ['record-missing', 'record-error', 'not-approved', 'scope-mismatch', 'conflict', 'relation-unavailable'];

  for (const [group, members] of groups) {
    const fixedMembers = members.filter(node => node.kind === 'fixed');
    const alternativeMembers = members.filter(node => node.kind === 'alternative');
    const fixedIncluded = fixedMembers.filter(node => node.status === 'included');
    const fixedExcluded = fixedMembers.filter(node => node.status === 'excluded');
    const fixedUnresolved = fixedMembers.filter(node => node.status === 'unresolved-condition');
    const fixedGap = fixedMembers.filter(node => hardGapStatuses.includes(node.status));
    const alternativesIncluded = alternativeMembers.filter(node => node.status === 'included');
    const alternativesUnresolved = alternativeMembers.filter(node => node.status === 'unresolved-condition');
    const alternativesExcluded = alternativeMembers.filter(node => node.status === 'excluded');

    // 1. 全部分支条件都不满足：整组排除，不计缺件
    if (members.every(node => node.status === 'excluded')) {
      for (const node of members) node.reason = '替代组 ' + group + ' 全部分支条件不满足，排除且不计缺件';
      note('info', 'group-excluded', '替代组 ' + group + ' 对当前设备不适用');
      continue;
    }

    // 2. 任一成员条件未知：不能判定适用替代，保持挂起
    if (fixedUnresolved.length || alternativesUnresolved.length) {
      for (const node of [...fixedUnresolved, ...alternativesUnresolved]) {
        node.status = 'group-unresolved';
        node.reason = '替代组 ' + group + ' 存在条件未知的分支，尚不能判定适用替代';
      }
      note('error', 'group-unresolved', '替代组 ' + group + ' 的适用条件尚未全部可知');
      continue;
    }

    // 3. 固定资料条件满足且可用：固定资料为必需；同组条件满足的替代仅作待批准建议
    if (fixedIncluded.length) {
      for (const alternative of alternativesIncluded) {
        alternative.status = 'substitute-proposed';
        alternative.reason = '可在适用范围内替代组 ' + group + ' 的固定资料，需技术负责人批准后才能替代；当前固定资料仍为必需';
        note('warning', 'substitute-awaiting-approval', alternative.key + ' 的替代建议待批准');
      }
      continue;
    }

    // 4. 固定分支条件不满足，而替代分支条件满足：提出待批准替代，绝不自动采用
    if (!fixedIncluded.length && !fixedGap.length && alternativesIncluded.length) {
      const chosen = alternativesIncluded[0];
      chosen.status = 'substitute-proposed';
      chosen.reason = '固定资料对当前设备不适用，来源声明 ' + chosen.key + ' 可在适用范围内替代；该替代尚未经技术负责人批准，资料包不得视为完成';
      for (const other of alternativesIncluded.slice(1)) {
        other.status = 'substitute-alternate';
        other.reason = '同组其他可适用替代，留待技术负责人选择';
      }
      note('warning', 'substitute-awaiting-approval', chosen.key + ' 作为替代建议待批准');
      continue;
    }

    // 5. 固定资料是硬性缺口（撤下/未核准/类别不符等），即使存在可适用替代也只提议、不自动顶替
    if (fixedGap.length && alternativesIncluded.length) {
      const chosen = alternativesIncluded[0];
      chosen.status = 'substitute-proposed';
      chosen.reason = '固定资料不可用（' + fixedGap[0].reason + '），来源声明 ' + chosen.key + ' 可替代；替代尚未经技术负责人批准，资料包不得视为完成';
      for (const other of alternativesIncluded.slice(1)) {
        other.status = 'substitute-alternate';
        other.reason = '同组其他可适用替代，留待技术负责人选择';
      }
      note('warning', 'substitute-awaiting-approval', chosen.key + ' 作为替代建议待批准');
      continue;
    }

    // 6. 没有任何条件满足且可取得的成员：真实缺口，不套用最新版
    for (const node of members) {
      if (node.status === 'excluded') continue;
      node.status = 'group-gap';
      node.reason = '替代组 ' + group + ' 没有条件满足且可取得的资料，构成真实缺口';
    }
    note('error', 'group-gap', '替代组 ' + group + ' 无可用成员');
  }
}
