// Управление сотрудниками:
//   node server/cli.js add-user <логин> [пароль]   — добавить (пароль сгенерируется, если не указан)
//   node server/cli.js set-password <логин> [пароль]
//   node server/cli.js remove-user <логин>
//   node server/cli.js list-users
'use strict';
const crypto = require('node:crypto');
const { db, hashPassword } = require('./server');

const [cmd, loginArg, passArg] = process.argv.slice(2);
const login = String(loginArg || '').trim().toLowerCase();
const password = passArg || crypto.randomBytes(9).toString('base64url');

function exit(msg, code = 0) { console.log(msg); process.exit(code); }

switch (cmd) {
  case 'add-user':
    if (!login) exit('Укажите логин', 1);
    if (db.prepare('select 1 from staff where login = ?').get(login)) exit(`Сотрудник ${login} уже есть`, 1);
    db.prepare('insert into staff (login, pass_hash, created_at) values (?, ?, ?)').run(login, hashPassword(password), new Date().toISOString());
    exit(`Добавлен сотрудник\n  логин:  ${login}\n  пароль: ${password}`);
    break;
  case 'set-password': {
    const r = db.prepare('update staff set pass_hash = ? where login = ?').run(hashPassword(password), login);
    if (!r.changes) exit(`Сотрудник ${login} не найден`, 1);
    db.prepare('delete from sessions where staff_id = (select id from staff where login = ?)').run(login);
    exit(`Новый пароль для ${login}: ${password}`);
    break;
  }
  case 'remove-user': {
    const r = db.prepare('delete from staff where login = ?').run(login);
    exit(r.changes ? `Сотрудник ${login} удалён` : `Сотрудник ${login} не найден`, r.changes ? 0 : 1);
    break;
  }
  case 'list-users':
    exit(db.prepare('select login, created_at from staff order by id').all().map((s) => `${s.login}  (с ${s.created_at.slice(0, 10)})`).join('\n') || 'Сотрудников пока нет');
    break;
  default:
    exit('Команды: add-user, set-password, remove-user, list-users', 1);
}
