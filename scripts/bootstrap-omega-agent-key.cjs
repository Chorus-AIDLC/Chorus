#!/usr/bin/env node
const { createHash, randomBytes, randomUUID } = require('crypto');
const PGliteMod = require('/Users/personal/.npm/_npx/f2546a4da5ebd8c4/node_modules/@electric-sql/pglite');
const PGlite = PGliteMod.PGlite || PGliteMod;

const DATA_DIR = process.env.CHORUS_DATA_DIR || '/Users/personal/.chorus-omega/pglite';
const KEY_PREFIX = 'cho_';

function generateApiKey() {
  const randomPart = randomBytes(32).toString('base64url');
  const key = `${KEY_PREFIX}${randomPart}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const prefix = `${KEY_PREFIX}${randomPart.slice(0,4)}...${randomPart.slice(-4)}`;
  return { key, hash, prefix };
}

async function main() {
  console.log('PGlite', DATA_DIR);
  const db = new PGlite({ dataDir: DATA_DIR });

  // Strong cleanup for test bootstrap (removes conflicting serial id rows)
  await db.query(`DELETE FROM "ApiKey" WHERE name ILIKE '%omega%' OR name ILIKE '%god%'`);
  await db.query(`DELETE FROM "Agent" WHERE name = 'omega-god-hermes'`);
  await db.query(`DELETE FROM "Company" WHERE id < 10 OR name ILIKE '%Omega%'`);

  let companyUuid;
  const sel = await db.query('SELECT uuid FROM "Company" LIMIT 1');
  companyUuid = sel.rows && sel.rows[0] ? sel.rows[0].uuid : null;

  if (!companyUuid) {
    companyUuid = randomUUID();
    await db.query(`INSERT INTO "Company" (uuid, name, "emailDomains", "createdAt", "updatedAt") VALUES ($1,$2,$3,NOW(),NOW())`, [companyUuid, 'Omega Sovereign Singularity', ['omega.local']]);
    console.log('Inserted company', companyUuid);
  } else {
    console.log('Reusing', companyUuid);
  }

  const agentUuid = randomUUID();
  await db.query(`INSERT INTO "Agent" (uuid,"companyUuid",name,roles,permissions,"createdAt") VALUES ($1,$2,$3,$4,$5,NOW())`, [agentUuid, companyUuid, 'omega-god-hermes', ['admin'], ['*:read','*:write','*:admin']]);

  const { key, hash, prefix } = generateApiKey();
  await db.query(`INSERT INTO "ApiKey" (uuid,"companyUuid","agentUuid","keyHash","keyPrefix",name,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())`, [randomUUID(), companyUuid, agentUuid, hash, prefix, 'omega-mesh-god']);

  console.log('SUCCESS RAW KEY:', key);
  await db.close();
}
main().catch(console.error);
