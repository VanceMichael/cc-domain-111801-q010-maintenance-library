// 把资料包快照整理成可向维修点与技术负责人解释的领取报告。
// 报告只复述已落库的事实与决策，不产生新的领取或批准动作。
export function explainPackage(snapshot) {
  const included = [];
  const excluded = [];
  const gaps = [];
  const substitutions = [];

  for (const item of snapshot.items) {
    const node = item.node;
    const entry = {
      key: node.key,
      title: node.title,
      kind: node.kind,
      group: node.group,
      condition: node.condition,
      reason: node.reason,
      recordPath: node.recordPath,
      relationPath: node.relationPath,
      digest: item.digest,
    };
    if (node.status === 'included') included.push(entry);
    else if (node.status === 'excluded') excluded.push(entry);
    else if (node.status === 'substitute-proposed' || node.status === 'substitute-alternate') substitutions.push(entry);
    else gaps.push(entry);
  }

  return {
    packageId: snapshot.packageId,
    scope: snapshot.scope,
    unit: snapshot.unit,
    seed: snapshot.seed,
    createdAt: snapshot.createdAt,
    equipmentState: {
      // 只陈述登记过的改装事实；未列出的改装即“尚无记录”，不臆断为未安装
      knownModifications: Object.entries(snapshot.state.modifications)
        .map(([modification, status]) => ({ modification, status }))
        .sort((a, b) => a.modification.localeCompare(b.modification)),
      unmentioned: '未出现在装配记录中的改装按未知处理，不判定为不适用',
    },
    included,
    excluded,
    substitutions,
    gaps,
    complete: snapshot.plan.complete,
    blocking: snapshot.plan.blocking,
    observations: snapshot.plan.observations,
  };
}

export function explainReview(review) {
  return {
    reviewId: review.reviewId,
    packageId: review.packageId,
    createdAt: review.createdAt,
    stateChanges: review.changes,
    sufficient: review.review.sufficient,
    explanation: review.review.explanation,
    findings: review.review.findings,
    currentBlocking: review.review.currentBlocking,
    observations: review.review.observations,
  };
}
