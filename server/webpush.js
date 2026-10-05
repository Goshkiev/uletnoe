// Web Push без внешних библиотек. Уведомления отправляются пустыми (без данных заказа):
// через серверы Google/Apple идёт только «сигнал», а сам заказ приложение забирает с нашего сервера.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function loadKeys(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const keys = {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    // Публичный ключ в «сыром» виде: 0x04 || X || Y, как ждёт PushManager.subscribe().
    publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])),
  };
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

function vapidJwt(audience, subject, privatePem) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privatePem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

// Возвращает HTTP-статус push-сервиса. 404/410 значит, что подписка больше не действует.
async function sendEmpty(endpoint, keys, subject) {
  const url = new URL(endpoint);
  const jwt = vapidJwt(url.origin, subject, keys.privatePem);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { TTL: '600', Urgency: 'high', 'Content-Length': '0', Authorization: `vapid t=${jwt}, k=${keys.publicKey}` },
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

module.exports = { loadKeys, sendEmpty, vapidJwt };
