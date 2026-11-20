import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS packages (
      package_id TEXT PRIMARY KEY, scope TEXT NOT NULL, unit TEXT NOT NULL,
      seed TEXT NOT NULL, state TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS package_items (
      package_id TEXT NOT NULL, item_key TEXT NOT NULL, digest TEXT, record TEXT,
      node TEXT NOT NULL, PRIMARY KEY(package_id,item_key));
      CREATE TABLE IF NOT EXISTS package_reviews (
      review_id TEXT PRIMARY KEY, package_id TEXT NOT NULL, state TEXT NOT NULL,
      changes TEXT NOT NULL, review TEXT NOT NULL, created_at TEXT NOT NULL);`);
    return this;
  }
  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + crypto.randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)').run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision));
  }
  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY business_key,digest').all(scope).map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  savePackage(snapshot) {
    const createdAt = new Date().toISOString();
    this.database.prepare('INSERT INTO packages (package_id, scope, unit, seed, state, plan, created_at) VALUES(?,?,?,?,?,?,?)').run(
      snapshot.packageId, snapshot.scope, snapshot.unit, snapshot.seed,
      JSON.stringify(snapshot.state), JSON.stringify(snapshot.plan), createdAt,
    );
    const putItem = this.database.prepare('INSERT OR IGNORE INTO package_items VALUES(?,?,?,?,?)');
    for (const item of snapshot.items) {
      putItem.run(snapshot.packageId, item.key, item.digest, item.record ? JSON.stringify(item.record) : null, JSON.stringify(item.node));
    }
    return { ...snapshot, createdAt };
  }
  getPackage(packageId) {
    const row = this.database.prepare('SELECT * FROM packages WHERE package_id=?').get(packageId);
    if (!row) return null;
    const items = this.database.prepare('SELECT * FROM package_items WHERE package_id=? ORDER BY item_key').all(packageId)
      .map(entry => ({ key: entry.item_key, digest: entry.digest, record: entry.record ? JSON.parse(entry.record) : null, node: JSON.parse(entry.node) }));
    return {
      packageId: row.package_id, scope: row.scope, unit: row.unit, seed: row.seed,
      state: JSON.parse(row.state), plan: JSON.parse(row.plan), createdAt: row.created_at, items,
    };
  }
  listPackages(scope) {
    return this.database.prepare('SELECT package_id, unit, seed, created_at FROM packages WHERE scope=? ORDER BY created_at').all(scope);
  }
  saveReview(entry) {
    const createdAt = new Date().toISOString();
    this.database.prepare('INSERT INTO package_reviews VALUES(?,?,?,?,?,?)').run(
      entry.reviewId, entry.packageId, JSON.stringify(entry.state),
      JSON.stringify(entry.changes), JSON.stringify(entry.review), createdAt,
    );
    return { ...entry, createdAt };
  }
  listReviews(packageId) {
    return this.database.prepare('SELECT * FROM package_reviews WHERE package_id=? ORDER BY created_at').all(packageId)
      .map(row => ({ reviewId: row.review_id, packageId: row.package_id, state: JSON.parse(row.state), changes: JSON.parse(row.changes), review: JSON.parse(row.review), createdAt: row.created_at }));
  }
  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }
  close() {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }
}
