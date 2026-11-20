import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { assemblePackage, reassessPackage } from '../src/package.mjs';
import { explainPackage, explainReview } from '../src/report.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));

test('资料包报告解释设备状态、纳入与排除的引用及尚缺条件/原文', async () => {
  const source = await fixtureSource(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'report-'));
  const archive = await new Archive(directory).start();
  try {
    const client = new SourceClient(source.url);
    const pkg = await assemblePackage({
      client, archive, scope: 'EQ-A',
      stateRaw: { unit: 'unit-100', equipment: 'EQ-A', modifications: [{ modification: 'M', status: 'installed' }] },
      seedModule: 'DM100',
    });
    const report = explainPackage(pkg);
    assert.deepEqual(report.equipmentState.knownModifications, [{ modification: 'M', status: 'installed' }]);
    assert.ok(report.included.some(e => e.key === 'DM200:2'));
    assert.ok(report.gaps.some(e => e.key === 'DM500:1' && e.reason.includes('不能判定不适用')));
    assert.ok(report.gaps.some(e => e.key === 'DM600:1' && e.reason.includes('真实缺口')));
    assert.equal(report.complete, false);
    // 每个纳入项都保留原文位置与摘要，可复查
    for (const entry of report.included) {
      assert.ok(entry.digest);
      assert.ok(entry.recordPath);
    }

    const review = await reassessPackage({
      client, archive, packageId: pkg.packageId,
      stateRaw: { unit: 'unit-100', equipment: 'EQ-A', modifications: [
        { modification: 'M', status: 'installed' }, { modification: 'N', status: 'installed' },
      ] },
    });
    const reviewReport = explainReview(review);
    assert.equal(reviewReport.sufficient, false);
    assert.ok(reviewReport.findings.some(f => f.key === 'DM500:1'));
    assert.deepEqual(reviewReport.stateChanges, [{ modification: 'N', from: null, to: 'installed' }]);
  } finally { archive.close(); await source.close(); await rm(directory, { recursive: true, force: true }); }
});
