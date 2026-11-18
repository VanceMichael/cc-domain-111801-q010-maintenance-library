import { text } from './validation.mjs';

export const collectionPath = "/library/equipment";
export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.issue, "issue");
  if (!Array.isArray(raw.modules)) throw new Error('来源目录结构无效');
  const references = raw.modules.map(entry => ({
    identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  return { context, references };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.module !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.issue !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}
