/**
 * WhatsApp-бот для записи клиентов в баню.
 * Библиотека: @whiskeysockets/baileys (вход по QR-коду).
 * Хранение: Firebase Realtime Database (состояния клиентов и резервная копия сессии WhatsApp).
 * Для Render: HTTP-сервер с health check и страницей /qr.
 *
 * Машина состояний (по номеру клиента):
 *   [нет состояния] --первое сообщение--> WAITING_FOR_DATA
 *   WAITING_FOR_DATA --данные заявки--> COMPLETED
 *   Состояние сбрасывается через SESSION_TIMEOUT после последней активности.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');


// ============================================================================
// НАСТРОЙКИ
// ============================================================================

// Порт, который выдаёт Render (локально 10000)
const PORT = Number(process.env.PORT) || 10000;

// Номер администратора: только цифры, с кодом страны, без «+»
const ADMIN_PHONE = process.env.ADMIN_PHONE || '77787003325';

// Firebase Realtime Database
const FIREBASE_URL = process.env.FIREBASE_URL
  || 'https://jcord-f0102-default-rtdb.europe-west1.firebasedatabase.app';
// Раздел в базе. Должен совпадать с ключом в правилах Firebase.
const FIREBASE_PATH = process.env.FIREBASE_PATH || 'bath_bot';

// Локальная папка с файлами сессии WhatsApp (восстанавливается из Firebase)
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info';

// Таймаут неактивности клиента (мс)
const SESSION_TIMEOUT = 30 * 60 * 1000;
// Как часто сохранять резервную копию сессии в Firebase (мс)
const BACKUP_INTERVAL = 10 * 60 * 1000;
// Задержка перед переподключением после обрыва (мс)
const RECONNECT_DELAY = 5000;

const WELCOME_TEXT = [
  'Здравствуйте! Добро пожаловать в наш банный комплекс 🧖‍♀️🧖‍♂️',
  '',
  'Мы работаем без выходных:',
  '',
  '🕑 Понедельник — с 14:00 до 01:00',
  '🕛 Вторник–пятница — с 13:00 до 01:00',
  '🕚 Суббота–воскресенье — с 12:00 до 01:00',
  '',
  '✨ Женский и мужской залы',
  '✨ Время посещения — безлимит',
  '✨ Бесплатно выдаются тапочки',
  '✨ Массаж, пилинг и вкусная кухня ждут вас!',
  '',
  '👙 Для посещения бассейна и женского зала обязательно: купальник и шапочка',
  '',
  'Стоимость входа:',
  '▪️ Взрослый — 3 000 ₸',
  '▪️ Детский — 2 000 ₸',
  '▪️ Пенсионера — 2 500 ₸',
].join('\n');

const BOOKING_REQUEST_TEXT = [
  'Чтобы забронировать время, отправьте одним сообщением:',
  '1️⃣ Имя',
  '2️⃣ Желаемую дату и время',
  '3️⃣ Количество человек',
].join('\n');

const REQUEST_ACCEPTED_TEXT =
  'Спасибо, заявка принята! Администратор скоро свяжется с вами для подтверждения брони.';

const NEED_TEXT_TEXT =
  'Пожалуйста, отправьте данные для брони текстом: имя, дату и время, количество человек.';

const ADMIN_NOTIFICATION_TEMPLATE = (phone, text) =>
  `🛎 Новая заявка на баню\n\nКлиент: https://wa.me/${phone}\n\nТекст заявки:\n${text}`;


// ============================================================================
// ЛОГИРОВАНИЕ
// ============================================================================

const logger = pino({ level: 'warn' }); // логи самой библиотеки
const log = {
  info: (...a) => console.log(new Date().toISOString(), '[INFO]', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), '[WARN]', ...a),
  error: (...a) => console.error(new Date().toISOString(), '[ERROR]', ...a),
};


// ============================================================================
// FIREBASE REALTIME DATABASE (REST API)
// ============================================================================

async function fb(method, subpath, body) {
  const url = `${FIREBASE_URL}/${FIREBASE_PATH}/${subpath}.json`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Firebase ${method} ${subpath}: HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}


// ============================================================================
// РЕЗЕРВНАЯ КОПИЯ СЕССИИ WHATSAPP
// ============================================================================

// Файлы сессии сохраняются как массив {name, content}, а не как объект:
// имена файлов содержат точки и «@», а такие символы недопустимы в ключах Firebase.
async function backupSession() {
  if (!fs.existsSync(AUTH_DIR)) return;
  try {
    const files = fs.readdirSync(AUTH_DIR).map((name) => ({
      name,
      content: fs.readFileSync(path.join(AUTH_DIR, name), 'utf8'),
    }));
    await fb('PUT', 'wa_session', { files, saved_at: Date.now() });
    log.info('Сессия WhatsApp сохранена в Firebase');
  } catch (err) {
    log.error('Не удалось сохранить сессию в Firebase:', err.message);
  }
}

async function restoreSession() {
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    log.info('Локальная сессия найдена, восстановление не нужно');
    return;
  }
  try {
    const stored = await fb('GET', 'wa_session');
    if (!stored || !Array.isArray(stored.files) || stored.files.length === 0) {
      log.info('Сохранённой сессии в Firebase нет, потребуется сканирование QR-кода');
      return;
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const f of stored.files) {
      fs.writeFileSync(path.join(AUTH_DIR, f.name), f.content);
    }
    log.info('Сессия WhatsApp восстановлена из Firebase');
  } catch (err) {
    log.error('Не удалось восстановить сессию из Firebase:', err.message);
  }
}

async function deleteSessionBackup() {
  try {
    await fb('DELETE', 'wa_session');
  } catch (err) {
    log.error('Не удалось удалить сессию из Firebase:', err.message);
  }
}

// Не чаще одного раза в 5 секунд, потому что Baileys сохраняет ключи очень часто
let backupTimer = null;
function scheduleBackup() {
  if (backupTimer) return;
  backupTimer = setTimeout(async () => {
    backupTimer = null;
    await backupSession();
  }, 5000);
}


// ============================================================================
// МАШИНА СОСТОЯНИЙ (хранится в Firebase: sessions/<номер>)
// ============================================================================

const State = { WAITING_FOR_DATA: 'WAITING_FOR_DATA', COMPLETED: 'COMPLETED' };

async function getState(phone) {
  try {
    const data = await fb('GET', `sessions/${phone}`);
    if (!data) return null;
    if (Date.now() - Number(data.last_active || 0) > SESSION_TIMEOUT) {
      await fb('DELETE', `sessions/${phone}`);
      log.info(`Состояние ${phone} истекло по таймауту`);
      return null;
    }
    return data.state;
  } catch (err) {
    log.error(`Ошибка чтения состояния ${phone}:`, err.message);
    return null;
  }
}

async function setState(phone, state) {
  try {
    await fb('PUT', `sessions/${phone}`, { state, last_active: Date.now() });
  } catch (err) {
    log.error(`Ошибка записи состояния ${phone}:`, err.message);
  }
}


// ============================================================================
// WHATSAPP
// ============================================================================

let sock = null;
let latestQr = null;
let connected = false;

async function send(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    log.error(`Ошибка отправки сообщения в ${jid}:`, err.message);
    return false;
  }
}

async function forwardToAdmin(phone, text) {
  const adminJid = `${ADMIN_PHONE}@s.whatsapp.net`;
  return send(adminJid, ADMIN_NOTIFICATION_TEMPLATE(phone, text));
}

function extractText(m) {
  const msg = m.message || {};
  return (msg.conversation || msg.extendedTextMessage?.text || '').trim();
}

function shouldIgnore(m) {
  if (!m.message || m.key.fromMe) return true;           // пустые и свои сообщения
  const jid = m.key.remoteJid || '';
  if (jid.endsWith('@g.us')) return true;                 // группы
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return true; // статусы
  return false;
}

async function handleMessage(m) {
  if (shouldIgnore(m)) return;

  const replyJid = m.key.remoteJid;
  // В новых версиях WhatsApp отправитель может приходить как @lid.
  // remoteJidAlt содержит настоящий номер, если он доступен.
  const alt = m.key.remoteJidAlt || '';
  const phone = (alt.endsWith('@s.whatsapp.net') ? alt : replyJid).split('@')[0];
  const text = extractText(m);

  const state = await getState(phone);

  // Первое сообщение клиента: автоответ и запрос данных
  if (state === null) {
    await send(replyJid, WELCOME_TEXT);
    await send(replyJid, BOOKING_REQUEST_TEXT);
    await setState(phone, State.WAITING_FOR_DATA);
    log.info(`Новый клиент ${phone}, ожидаем данные`);
    return;
  }

  // После заявки бот молчит, чтобы не мешать администратору
  if (state === State.COMPLETED) {
    await setState(phone, State.COMPLETED); // продлеваем время активности
    return;
  }

  if (state === State.WAITING_FOR_DATA) {
    if (!text) {
      await send(replyJid, NEED_TEXT_TEXT);
      await setState(phone, State.WAITING_FOR_DATA);
      return;
    }

    await send(replyJid, REQUEST_ACCEPTED_TEXT);
    const forwarded = await forwardToAdmin(phone, text);
    if (forwarded) {
      log.info(`Заявка от ${phone} переслана администратору`);
    } else {
      log.warn(`Заявка от ${phone} НЕ переслана, требуется проверка`);
    }
    await setState(phone, State.COMPLETED);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const config = {
    auth: state,
    logger,
    browser: ['Bath Bot', 'Chrome', '1.0.0'],
  };
  try {
    const { version } = await fetchLatestBaileysVersion();
    config.version = version;
  } catch {
    log.warn('Не удалось получить актуальную версию WhatsApp, используется встроенная');
  }

  sock = makeWASocket(config);

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleBackup();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      log.info('Получен новый QR-код, откройте /qr в браузере');
    }

    if (connection === 'open') {
      connected = true;
      latestQr = null;
      log.info('Бот подключён к WhatsApp');
      scheduleBackup();
    }

    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        log.warn('Устройство отвязано в WhatsApp. Нужен новый вход по QR-коду');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        await deleteSessionBackup();
        setTimeout(startBot, RECONNECT_DELAY);
      } else {
        log.warn(`Соединение закрыто (код ${code}), переподключение...`);
        setTimeout(startBot, RECONNECT_DELAY);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // только новые входящие, без истории
    for (const m of messages) {
      try {
        await handleMessage(m);
      } catch (err) {
        log.error('Ошибка обработки сообщения:', err);
      }
    }
  });
}


// ============================================================================
// HTTP-СЕРВЕР (health check и QR-код)
// ============================================================================

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/qr')) {
    if (connected || !latestQr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('QR not available: bot is connected or code not generated yet');
    }
    try {
      const png = await QRCode.toBuffer(latestQr, { type: 'png', margin: 2, width: 400 });
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Failed to render QR');
    }
  }

  const status = connected
    ? 'Bot is running and connected to WhatsApp'
    : latestQr
      ? 'Bot is running. Not connected yet: open /qr to scan the code'
      : 'Bot is running. Waiting for QR code or reconnect (check Render logs)';
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(status);
});


// ============================================================================
// ЗАПУСК
// ============================================================================

async function main() {
  server.listen(PORT, '0.0.0.0', () => {
    log.info(`Веб-сервер запущен на порту ${PORT}`);
  });

  await restoreSession();
  await startBot();

  // Периодическая резервная копия, пока бот подключён
  setInterval(() => {
    if (connected) backupSession();
  }, BACKUP_INTERVAL);

  log.info('Запуск бота. Для входа откройте /qr на адресе сервиса.');
}

main().catch((err) => {
  log.error('Фатальная ошибка при запуске:', err);
  process.exit(1);
});
