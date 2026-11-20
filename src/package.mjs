import { randomUUID } from 'node:crypto';
import { browse } from './source.mjs';
import { fetchRelations, recordPath } from './relations.mjs';
import { planPackage } from './planner.mjs';
import { interpretEquipmentState, diffStates } from './equipment.mjs';
import { assess } from './receiving.mjs';

// 从目录中确认种子资料的来源身份与原文位置
async function seedFromCatalog(client, module) {
  const manifest = await browse(client);
  const entry = manifest.references.find(item => item.identity === module);
  if (!entry) throw new Error('目录中没有资料号：' + module);
  return { module, issue: manifest.context, href: entry.href, context: manifest.context };
}

// 计划器与真实来源之间的 I/O 适配器：取回的原文统一先入 Archive 按摘要保管
function createLoader(client, archive, scope) {
  return {
    async fetchRecord(module, issue) {
      try {
        const document = await client.get(recordPath(module));
        const digest = await archive.preserve(document);
        // 同版次不同内容不覆盖原件，另存为领域收件冲突依据
        archive.put(scope, module + ':' + issue, digest, document.raw, { status: 'fetched', reason: '资料包采集原文' });
        return { available: true, document: { ...document, digest } };
      } catch (error) {
        return { available: false, status: error?.status ?? 0, reason: error.message };
      }
    },
    async fetchRelations(module) {
      return fetchRelations(client, module);
    },
  };
}

/*
 * 为一台具体设备组装作业资料包。
 * stateRaw 是该设备当前的装配记录；包内固化状态快照，之后记录补正不会改写旧包。
 */
export async function assemblePackage({ client, archive, scope, stateRaw, seedModule }) {
  const state = interpretEquipmentState(stateRaw);
  if (state.equipment !== scope) throw new Error('设备类别与收件范围不一致');
  const seed = await seedFromCatalog(client, seedModule);
  const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
  const plan = await planPackage({
    seed,
    state,
    loader: createLoader(client, archive, scope),
    assessRecord: (record, previous, equipment) => assess(record, previous, equipment, { allowGeneric: true }),
    priorRecords: prior,
  });

  const items = plan.nodes.map(node => ({
    key: node.key,
    digest: node.digest,
    record: node.record,
    node: {
      key: node.key, module: node.module, issue: node.issue, title: node.title,
      kind: node.kind, group: node.group, status: node.status, reason: node.reason,
      condition: node.condition, recordPath: node.recordPath, relationPath: node.relationPath,
    },
  }));

  const snapshot = {
    packageId: randomUUID(),
    scope,
    unit: state.unit,
    seed: seed.module + ':' + seed.issue,
    state,
    plan: {
      seed: plan.seed,
      complete: plan.complete,
      blocking: plan.blocking,
      observations: plan.observations,
    },
    items,
  };
  return archive.savePackage(snapshot);
}

/*
 * 用补正后的装配记录复核已发出的资料包。
 * 不重新发证、不改写旧包，只追加复核结论，说明原包为何仍充分或不再足以支撑当前作业。
 */
export async function reassessPackage({ client, archive, packageId, stateRaw }) {
  const previous = archive.getPackage(packageId);
  if (!previous) throw new Error('资料包不存在：' + packageId);
  const state = interpretEquipmentState(stateRaw);
  if (state.equipment !== previous.scope) throw new Error('设备类别与资料包范围不一致');
  const changes = diffStates(previous.state, state);

  const seedModule = previous.seed.split(':')[0];
  const seed = await seedFromCatalog(client, seedModule);
  const prior = archive.records(previous.scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
  const current = await planPackage({
    seed,
    state,
    loader: createLoader(client, archive, previous.scope),
    assessRecord: (record, records, equipment) => assess(record, records, equipment, { allowGeneric: true }),
    priorRecords: prior,
  });

  const oldByKey = new Map(previous.items.map(item => [item.key, item]));
  const blockingStatuses = ['record-missing', 'record-error', 'not-approved', 'scope-mismatch', 'conflict',
    'unresolved-condition', 'relation-unavailable', 'group-gap', 'group-unresolved', 'substitute-proposed', 'substitute-alternate'];
  const findings = [];
  for (const node of current.nodes) {
    const old = oldByKey.get(node.key);
    const wasIncluded = old && old.node.status === 'included';
    const nowIncluded = node.status === 'included';
    if (wasIncluded && !nowIncluded) {
      findings.push({ key: node.key, change: 'lost', from: old.node.status, to: node.status, reason: node.reason });
    } else if (!wasIncluded && nowIncluded) {
      findings.push({ key: node.key, change: 'gained', from: old?.node.status ?? 'absent', to: node.status, reason: node.reason });
    } else if (old && old.node.status !== node.status) {
      findings.push({ key: node.key, change: 'status', from: old.node.status, to: node.status, reason: node.reason });
    } else if (!old && blockingStatuses.includes(node.status)) {
      // 仅把阻断性的新节点视为缺口；条件不满足的排除分支不是缺件
      findings.push({ key: node.key, change: 'new-gap', from: 'absent', to: node.status, reason: node.reason });
    }
  }
  for (const item of previous.items) {
    if (!current.nodes.some(node => node.key === item.key)) {
      findings.push({ key: item.key, change: 'no-longer-declared', from: item.node.status, to: 'absent', reason: '来源当前的关联声明不再包含该引用' });
    }
  }
  const sufficient = current.complete &&
    !findings.some(finding => ['lost', 'new-gap', 'no-longer-declared'].includes(finding.change));
  const explanation = sufficient
    ? '原资料包仍可支撑当前作业；装配记录变化未引入新的必需分支缺口'
    : '原资料包不再足以支撑当前作业，需按复核结论补件或挂起待条件确认';

  const review = {
    reviewId: randomUUID(),
    packageId,
    state,
    changes,
    review: {
      sufficient,
      explanation,
      findings,
      currentComplete: current.complete,
      currentBlocking: current.blocking,
      observations: current.observations,
    },
  };
  return archive.saveReview(review);
}
