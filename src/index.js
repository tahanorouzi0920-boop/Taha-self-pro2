// Taha Self Pro - Cloudflare Worker
// امتیازها مجازی و بدون ارزش پولی هستند. بازی‌ها فقط امتیاز رایگان می‌دهند.

const GAME_REWARD = 20;
const WELCOME_POINTS = 100;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const send = (env, chat_id, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

const isAdmin = (env, id) => String(id) === String(env.ADMIN_TELEGRAM_ID);

async function audit(env, actor, action, target, details) {
  await env.DB.prepare(
    'INSERT INTO audit_log (actor_id, action, target, details) VALUES (?,?,?,?)'
  ).bind(actor, action, String(target ?? ''), details ? JSON.stringify(details) : null).run();
}

async function getUser(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

async function ensureUser(env, from) {
  const existing = await getUser(env, from.id);
  if (!existing) {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (id, first_name, last_name, username, points) VALUES (?,?,?,?,?)'
      ).bind(from.id, from.first_name || '', from.last_name || '', from.username || null, WELCOME_POINTS),
      env.DB.prepare(
        'INSERT INTO transactions (to_id, amount, type, reason) VALUES (?,?,?,?)'
      ).bind(from.id, WELCOME_POINTS, 'welcome', 'امتیاز خوشامدگویی'),
    ]);
    return { user: await getUser(env, from.id), isNew: true };
  }
  await env.DB.prepare(
    "UPDATE users SET first_name=?, last_name=?, username=?, last_seen=datetime('now') WHERE id=?"
  ).bind(from.first_name || '', from.last_name || '', from.username || null, from.id).run();
  return { user: await getUser(env, from.id), isNew: false };
}

// انتقال امتیاز؛ جلوگیری از موجودی منفی با شرط داخل UPDATE
async function transferPoints(env, fromId, toId, amount, type, reason) {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'مقدار نامعتبر است.' };
  const debit = await env.DB.prepare(
    "UPDATE users SET points = points - ? WHERE id = ? AND points >= ? AND status = 'active'"
  ).bind(amount, fromId, amount).run();
  if (!debit.meta.changes) return { ok: false, error: 'موجودی کافی نیست یا حساب فعال نیست.' };

  const credit = await env.DB.prepare('UPDATE users SET points = points + ? WHERE id = ?')
    .bind(amount, toId).run();
  if (!credit.meta.changes) {
    await env.DB.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(amount, fromId).run();
    return { ok: false, error: 'گیرنده پیدا نشد.' };
  }
  await env.DB.prepare(
    'INSERT INTO transactions (from_id, to_id, amount, type, reason) VALUES (?,?,?,?,?)'
  ).bind(fromId, toId, amount, type, reason || null).run();
  return { ok: true };
}

// ---------- بازی دونفره با امتیاز مجازی ----------
function randomCode() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function createGame(env, chat_id, from, level) {
  const code = randomCode();
  const res = await env.DB.prepare(
    'INSERT INTO games (code, level, p1, chat_id) VALUES (?,?,?,?)'
  ).bind(code, level, from.id, chat_id).run();
  const msg = await send(env, chat_id,
    `🎮 اتاق بازی ساخته شد\nشناسه اتاق: <code>${code}</code>\nسطح: ${level}\nبازیکن اول: ${from.first_name}`,
    { reply_markup: { inline_keyboard: [[{ text: 'پیوستن', callback_data: `join:${code}` }]] } });
  await env.DB.prepare('UPDATE games SET message_id=? WHERE id=?')
    .bind(msg.result?.message_id ?? null, res.meta.last_row_id).run();
}

async function joinGame(env, cq, code) {
  const game = await env.DB.prepare('SELECT * FROM games WHERE code=?').bind(code).first();
  const from = cq.from;
  if (!game || game.status !== 'waiting') return 'این اتاق بسته است.';
  if (game.p1 === from.id) return 'نمی‌توانی به اتاق خودت بپیوندی.';

  // پیوستن فقط یک بار و فقط وقتی جای خالی هست
  const r = await env.DB.prepare(
    "UPDATE games SET p2=?, status='finished' WHERE id=? AND status='waiting' AND p2 IS NULL"
  ).bind(from.id, game.id).run();
  if (!r.meta.changes) return 'این اتاق بسته است.';

  // نتیجه تصادفی، فقط سمت سرور
  const p1Wins = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0;
  const winner = p1Wins ? game.p1 : from.id;
  const loser = p1Wins ? from.id : game.p1;

  // جلوگیری از ثبت دوباره نتیجه
  const done = await env.DB.prepare(
    "UPDATE games SET winner=?, finished_at=datetime('now') WHERE id=? AND winner IS NULL"
  ).bind(winner, game.id).run();
  if (!done.meta.changes) return 'نتیجه قبلاً ثبت شده است.';

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET games_played=games_played+1, wins=wins+1 WHERE id=?').bind(winner),
    env.DB.prepare('UPDATE users SET games_played=games_played+1, losses=losses+1 WHERE id=?').bind(loser),
    env.DB.prepare('UPDATE users SET points=points+? WHERE id=?').bind(GAME_REWARD, winner),
    env.DB.prepare('INSERT INTO transactions (to_id, amount, type, reason) VALUES (?,?,?,?)')
      .bind(winner, GAME_REWARD, 'game_reward', `اتاق ${code}`),
  ]);

  const w = await getUser(env, winner);
  const l = await getUser(env, loser);
  await send(env, game.chat_id,
    `🏆 <b>نتیجه بازی</b>\nبازی تکمیل شد\nشناسه اتاق: <code>${code}</code>\n` +
    `برنده: ${w.first_name}\nبازنده: ${l.first_name}\n` +
    `${GAME_REWARD} امتیاز مجازی رایگان برای برنده ثبت شد. هیچ امتیازی از بازنده کسر نشد.`);
  return 'پیوستی! نتیجه اعلام شد.';
}

// ---------- تنظیمات (روشن/خاموش) ----------
async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return r ? r.value === '1' : true;
}
async function setSetting(env, key, on) {
  await env.DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(key, on ? '1' : '0').run();
}

// ---------- دستورات ----------
async function handleCommand(env, msg) {
  const chat = msg.chat.id;
  const from = msg.from;
  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0];
  const { user } = await ensureUser(env, from);

  if (user.status === 'blocked') return send(env, chat, '⛔ دسترسی شما مسدود است.');

  switch (cmd) {
    case '/start':
      return send(env, chat,
        `سلام ${from.first_name}! به Taha Self Pro خوش آمدی 🌱\nموجودی فعلی: ${user.points} امتیاز مجازی\nبرای راهنما: /help`);

    case '/help':
      return send(env, chat,
        '<b>دستورات عمومی</b>\n/start شروع\n/profile پروفایل\n/balance موجودی\n/top رتبه‌بندی\n/games بازی‌ها\n' +
        '/transfer آیدی مقدار : انتقال امتیاز\n/بازی سطح : ساخت اتاق بازی');

    case '/profile':
      return send(env, chat,
        `👤 <b>${user.first_name}</b>\nبردها: ${user.wins}\nباخت‌ها: ${user.losses}\nبازی‌ها: ${user.games_played}\nامتیاز مجازی: ${user.points}`);

    case '/balance':
    case '/موجودی':
      return send(env, chat, `💰 موجودی شما: ${user.points} امتیاز مجازی`);

    case '/top': {
      const rows = await env.DB.prepare(
        'SELECT first_name, wins, games_played FROM users ORDER BY wins DESC, losses ASC LIMIT 10'
      ).all();
      const lines = rows.results.map((r, i) => `${i + 1}. ${r.first_name} - برد: ${r.wins} از ${r.games_played}`);
      return send(env, chat, '🏅 <b>رتبه‌بندی</b>\n' + (lines.join('\n') || 'هنوز بازی‌ای ثبت نشده'));
    }

    case '/games':
      return send(env, chat, '🎮 بازی فعال: دونفره با امتیاز مجازی\nدستور: /بازی سطح (مثلاً /بازی 100)');

    case '/بازی': {
      if (!(await getSetting(env, 'games_enabled'))) return send(env, chat, '⏸ بازی‌ها موقتاً خاموش است.');
      const level = parseInt(args[0], 10);
      if (!level || level < 1) return send(env, chat, 'مثال: /بازی 100');
      return createGame(env, chat, from, level);
    }

    case '/transfer': {
      if (!(await getSetting(env, 'points_enabled'))) return send(env, chat, '⏸ سیستم امتیاز خاموش است.');
      const [toId, amountStr] = args;
      const r = await transferPoints(env, from.id, Number(toId), parseInt(amountStr, 10), 'transfer', 'انتقال کاربر');
      return send(env, chat, r.ok ? '✅ انتقال انجام شد.' : `❌ ${r.error}`);
    }

    // ---------- مدیریت ----------
    case '/grant': {
      if (!isAdmin(env, from.id)) return send(env, chat, '⛔ فقط مدیر اصلی.');
      if (!(await getSetting(env, 'points_enabled'))) return send(env, chat, '⏸ سیستم امتیاز خاموش است.');
      const [toId, amountStr] = args;
      const amount = parseInt(amountStr, 10);
      const target = await getUser(env, Number(toId));
      if (!target || !Number.isInteger(amount) || amount <= 0) return send(env, chat, 'مثال: /grant 123456 500');
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET points=points+? WHERE id=?').bind(amount, target.id),
        env.DB.prepare('INSERT INTO transactions (to_id, amount, type, reason) VALUES (?,?,?,?)')
          .bind(target.id, amount, 'admin_grant', 'افزودن توسط مدیر'),
      ]);
      await audit(env, from.id, 'grant', target.id, { amount });
      return send(env, chat, `✅ ${amount} امتیاز به ${target.first_name} افزوده شد.`);
    }

    case '/block':
    case '/unblock': {
      if (!isAdmin(env, from.id)) return send(env, chat, '⛔ فقط مدیر اصلی.');
      const status = cmd === '/block' ? 'blocked' : 'active';
      const r = await env.DB.prepare('UPDATE users SET status=? WHERE id=?').bind(status, Number(args[0])).run();
      await audit(env, from.id, cmd.slice(1), args[0]);
      return send(env, chat, r.meta.changes ? 'انجام شد.' : 'کاربر پیدا نشد.');
    }

    case '/stats': {
      if (!isAdmin(env, from.id)) return send(env, chat, '⛔ فقط مدیر اصلی.');
      const s = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM users) users,
                (SELECT COUNT(*) FROM games WHERE status='finished') finished,
                (SELECT COUNT(*) FROM games WHERE status='waiting') open_rooms,
                (SELECT COALESCE(SUM(points),0) FROM users) total_points`
      ).first();
      return send(env, chat,
        `📊 کاربران: ${s.users}\nبازی‌های تکمیل‌شده: ${s.finished}\nاتاق‌های باز: ${s.open_rooms}\nکل امتیازها: ${s.total_points}`);
    }

    case '/logs': {
      if (!isAdmin(env, from.id)) return send(env, chat, '⛔ فقط مدیر اصلی.');
      const rows = await env.DB.prepare('SELECT action, target, created_at FROM audit_log ORDER BY id DESC LIMIT 10').all();
      return send(env, chat, rows.results.map((r) => `${r.created_at} | ${r.action} | ${r.target}`).join('\n') || 'خالی');
    }

    case '/پاسخ': {
      // /پاسخ کلمه | متن پاسخ
      if (!isAdmin(env, from.id)) return;
      const [pattern, ...rest] = msg.text.replace('/پاسخ', '').split('|');
      if (!pattern || !rest.length) return send(env, chat, 'مثال: /پاسخ سلام | سلام! خوش آمدی');
      await env.DB.prepare('INSERT INTO auto_replies (pattern, reply) VALUES (?,?)')
        .bind(pattern.trim(), rest.join('|').trim()).run();
      return send(env, chat, 'پاسخ خودکار ثبت شد.');
    }

    case '/deduct': {
      if (!isAdmin(env, from.id)) return send(env, chat, '⛔ فقط مدیر اصلی.');
      if (!(await getSetting(env, 'points_enabled'))) return send(env, chat, '⏸ سیستم امتیاز خاموش است.');
      const [toId, amountStr] = args;
      const amount = parseInt(amountStr, 10);
      const target = await getUser(env, Number(toId));
      if (!target || !Number.isInteger(amount) || amount <= 0) return send(env, chat, 'مثال: /deduct 123456 50');
      const r = await env.DB.prepare('UPDATE users SET points=points-? WHERE id=? AND points>=?')
        .bind(amount, target.id, amount).run();
      if (!r.meta.changes) return send(env, chat, '❌ موجودی کاربر کافی نیست.');
      await env.DB.prepare('INSERT INTO transactions (from_id, amount, type, reason) VALUES (?,?,?,?)')
        .bind(target.id, amount, 'admin_deduct', 'کسر توسط مدیر').run();
      await audit(env, from.id, 'deduct', target.id, { amount });
      return send(env, chat, `✅ ${amount} امتیاز از ${target.first_name} کسر شد.`);
    }

    case '/settings': {
      if (!isAdmin(env, from.id)) return send(env, chat, '⛔ فقط مدیر اصلی.');
      const [key, val] = args;
      const map = { امتیاز: 'points_enabled', points: 'points_enabled', بازی: 'games_enabled', games: 'games_enabled' };
      if (key && map[key] && (val === 'on' || val === 'off')) {
        await setSetting(env, map[key], val === 'on');
        await audit(env, from.id, 'setting', map[key], { value: val });
        return send(env, chat, `✅ ${key} ${val === 'on' ? 'روشن' : 'خاموش'} شد.`);
      }
      const p = await getSetting(env, 'points_enabled');
      const g = await getSetting(env, 'games_enabled');
      return send(env, chat,
        `⚙️ <b>تنظیمات</b>\nامتیاز مجازی: ${p ? 'روشن' : 'خاموش'}\nبازی: ${g ? 'روشن' : 'خاموش'}\n\n` +
        'تغییر: /settings امتیاز on|off\nیا: /settings بازی on|off');
    }

    default:
      return send(env, chat, 'دستور ناشناخته است. /help را بزن.');
  }
}

async function handleAutoReply(env, msg) {
  if (msg.chat.type !== 'private' || !msg.text) return false;
  const rules = await env.DB.prepare('SELECT * FROM auto_replies WHERE enabled=1').all();
  const rule = rules.results.find((r) => msg.text.includes(r.pattern));
  if (!rule) return false;
  await env.DB.prepare('UPDATE auto_replies SET hits=hits+1 WHERE id=?').bind(rule.id).run();
  await send(env, msg.chat.id, rule.reply);
  return true;
}

async function handleUpdate(env, update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const [action, code] = (cq.data || '').split(':');
    let text = 'نامعتبر';
    if (action === 'join') text = (await getSetting(env, 'games_enabled')) ? await joinGame(env, cq, code) : 'بازی‌ها خاموش است.';
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  }
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (msg.text.startsWith('/')) return handleCommand(env, msg);
  await handleAutoReply(env, msg);
}

// ---------- API پنل مدیریت ----------
function authPanel(request, env) {
  return env.PANEL_TOKEN && (request.headers.get('authorization') || '') === `Bearer ${env.PANEL_TOKEN}`;
}

async function panelApi(request, env, path) {
  if (!authPanel(request, env)) return json({ error: 'unauthorized' }, 401);
  if (path === '/api/stats') {
    const s = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users) users,
              (SELECT COUNT(*) FROM users WHERE status='blocked') blocked,
              (SELECT COUNT(*) FROM games WHERE status='finished') finished_games,
              (SELECT COALESCE(SUM(points),0) FROM users) total_points`
    ).first();
    return json(s);
  }
  if (path === '/api/users') {
    const rows = await env.DB.prepare(
      'SELECT id, first_name, username, points, wins, losses, status, role FROM users ORDER BY joined_at DESC LIMIT 100'
    ).all();
    return json(rows.results);
  }
  if (path === '/api/logs') {
    const rows = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
    return json(rows.results);
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      await handleUpdate(env, await request.json());
      return new Response('ok');
    }

    if (url.pathname.startsWith('/api/')) return panelApi(request, env, url.pathname);

    return new Response('Taha Self Pro is running');
  },
};
