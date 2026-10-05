'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpush = require('./webpush');

test('sends an empty VAPID-signed push that verifies against the public key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-'));
  const keys = webpush.loadKeys(dir);
  assert.deepEqual(webpush.loadKeys(dir), keys, 'keys are reused');

  let seen;
  const srv = http.createServer((req, res) => { seen = req.headers; req.resume(); req.on('end', () => { res.statusCode = 201; res.end(); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}/push/abc`;
  const status = await webpush.sendEmpty(endpoint, keys, 'mailto:test@example.com');
  srv.close();

  assert.equal(status, 201);
  assert.equal(seen.ttl, '600');
  assert.equal(seen['content-length'], '0');
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(seen.authorization);
  assert.ok(m);
  assert.equal(m[2], keys.publicKey);
  const [h, p, s] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.equal(claims.sub, 'mailto:test@example.com');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});
