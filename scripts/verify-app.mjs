// Verify a GitHub App client-ID + private-key pair and report app config.
// Reads the .pem at runtime; never prints key material or the JWT.
import crypto from 'node:crypto';
import fs from 'node:fs';

const [clientId, pemPath] = process.argv.slice(2);
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iat: now - 60, exp: now + 540, iss: clientId })}`;
const sig = crypto.sign('sha256', Buffer.from(unsigned), fs.readFileSync(pemPath)).toString('base64url');
const jwt = `${unsigned}.${sig}`;

const get = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  return { status: res.status, body: await res.json() };
};

const app = await get('/app');
if (app.status !== 200) {
  console.log(`AUTH FAILED (${app.status}):`, app.body.message);
  process.exit(1);
}
console.log('AUTH OK — app:', JSON.stringify({
  name: app.body.name,
  slug: app.body.slug,
  client_id: app.body.client_id,
  permissions: app.body.permissions,
  events: app.body.events,
}, null, 2));

const inst = await get('/app/installations');
console.log('INSTALLATIONS:', JSON.stringify(
  (inst.body || []).map((i) => ({
    account: i.account?.login,
    repository_selection: i.repository_selection,
    suspended: !!i.suspended_at,
  })), null, 2));

// List repos per installation (needs an installation token)
for (const i of inst.body || []) {
  const res = await fetch(`https://api.github.com/app/installations/${i.id}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  const tok = (await res.json()).token;
  const repos = await fetch('https://api.github.com/installation/repositories', {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' },
  }).then((r) => r.json());
  console.log(`REPOS for ${i.account?.login}:`, (repos.repositories || []).map((r) => r.full_name).join(', ') || '(none)');
}
