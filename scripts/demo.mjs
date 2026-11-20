import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { assemblePackage, reassessPackage } from '../src/package.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

const directory = await mkdtemp(join(tmpdir(), 'maintenance-library-'));
const archive = await new Archive(directory).start();
try {
  const client = new SourceClient(source.url);

  // 设备 A：改装 M 已安装；改装 N 尚无装配记录（未知，不臆断为未安装）
  const stateA = {
    unit: 'unit-100', equipment: fixture.scope,
    modifications: [{ modification: 'M', status: 'installed' }],
  };
  const pkgA = await assemblePackage({ client, archive, scope: fixture.scope, stateRaw: stateA, seedModule: 'DM100' });
  console.log('=== 资料包', pkgA.packageId, '（unit-100）===');
  for (const item of pkgA.items) {
    console.log(item.key.padEnd(10), item.node.status.padEnd(22), item.node.reason ?? '');
  }
  console.log('完成性：', pkgA.plan.complete, '阻断项：', pkgA.plan.blocking.map(b => b.key + ':' + b.status));

  // 设备 B：改装 M、N 均明确未安装，改装专属分支应排除且不计缺件
  const stateB = {
    unit: 'unit-200', equipment: fixture.scope,
    modifications: [
      { modification: 'M', status: 'absent' },
      { modification: 'N', status: 'absent' },
    ],
  };
  const pkgB = await assemblePackage({ client, archive, scope: fixture.scope, stateRaw: stateB, seedModule: 'DM100' });
  console.log('\n=== 资料包', pkgB.packageId, '（unit-200）===');
  for (const item of pkgB.items) {
    console.log(item.key.padEnd(10), item.node.status.padEnd(22), item.node.reason ?? '');
  }

  // 设备 A 补正记录后复核旧包：原包为何不再足以支撑当前作业
  const corrected = {
    unit: 'unit-100', equipment: fixture.scope,
    modifications: [
      { modification: 'M', status: 'installed' },
      { modification: 'N', status: 'installed' },
    ],
  };
  const review = await reassessPackage({ client, archive, packageId: pkgA.packageId, stateRaw: corrected });
  console.log('\n=== 资料包复核（unit-100 记录补正后）===');
  console.log('记录变化：', JSON.stringify(review.changes));
  console.log('仍充分：', review.review.sufficient, '—', review.review.explanation);
  for (const finding of review.review.findings) {
    console.log(finding.key.padEnd(10), finding.change.padEnd(18), finding.from, '->', finding.to);
  }

  console.log('\n已保存资料包：', archive.listPackages(fixture.scope).length, '；复核记录：', archive.listReviews(pkgA.packageId).length);
  if (pkgA.plan.complete) process.exitCode = 0;
} finally {
  archive.close(); await source.close(); await rm(directory, { recursive: true, force: true });
}
