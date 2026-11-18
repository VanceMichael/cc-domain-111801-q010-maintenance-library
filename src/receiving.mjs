export function assess(record, previous, scope) {
  if (record.equipment !== scope) return { status: 'outside', reason: '设备类别不匹配' };
           if (!record.approved) return { status: 'review', reason: '资料尚未核准' };
           const prior = previous.find(item => item.module === record.module && item.issue === record.issue && item.body !== record.body);
           if (prior) return { status: 'conflict', reason: '同版维修资料内容不同' };
           return { status: 'accepted', key: record.module + ':' + record.issue, facts: { module: record.module, issue: record.issue, equipment: record.equipment, title: record.title } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
