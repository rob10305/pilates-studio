#!/usr/bin/env node
// Fail-fast check for required environment variables.
// Run via `node scripts/check-env.js` before promoting a deploy, or wire into
// a CI/deploy step. Exits non-zero on missing/weak config so bad deploys don't
// reach production.

const REQUIRED = [
  { name: 'DATABASE_URL',   minLen: 10 },
  { name: 'SESSION_SECRET', minLen: 32 },
  { name: 'CRON_SECRET',    minLen: 16 },
  { name: 'APP_URL',        minLen: 8  }
];

const PRODUCTION_ONLY = [
  // Resend is required for the booking flow to actually send confirmation mail
  { name: 'RESEND_API_KEY', minLen: 8 }
];

const isProd = process.env.NODE_ENV === 'production';
const checks = isProd ? [...REQUIRED, ...PRODUCTION_ONLY] : REQUIRED;

const failures = [];
for (const { name, minLen } of checks) {
  const v = process.env[name];
  if (!v) {
    failures.push(`${name} is not set`);
  } else if (v.length < minLen) {
    failures.push(`${name} is set but shorter than ${minLen} chars (got ${v.length})`);
  }
}

// Guard against the old hardcoded dev secret ever leaking into real env.
const banned = ['dev-secret', 'redmaple-dev-secret-change-in-production', 'pilates2024'];
if (process.env.SESSION_SECRET && banned.includes(process.env.SESSION_SECRET)) {
  failures.push('SESSION_SECRET is a known placeholder value — generate a fresh random secret');
}

if (failures.length) {
  console.error('\n[check-env] Environment check FAILED:');
  for (const f of failures) console.error('  - ' + f);
  console.error('\nGenerate a strong SESSION_SECRET / CRON_SECRET with:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

console.log('[check-env] OK — all required vars present (NODE_ENV=' + (process.env.NODE_ENV || 'unset') + ').');
