const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const QRCode = require('qrcode');

const { MONGODB_URI, ADMIN_PASSWORD, PORT = 3000 } = process.env;
if (!MONGODB_URI || !ADMIN_PASSWORD) {
  console.error('Faltan las variables de entorno MONGODB_URI y/o ADMIN_PASSWORD');
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('sorteos:' + ADMIN_PASSWORD).digest('hex');

// ---------- utilidades ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const getCookie = (req, n) =>
  (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(n + '='))?.slice(n.length + 1);
const isAdmin = (req) => {
  const t = getCookie(req, 'adm');
  if (!t) return false;
  const [exp, sig] = t.split('.');
  return !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
};
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'No autorizado' }));

const hits = new Map();
const limited = (key, max, ms) => {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < ms);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
};
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

const clean = (s, n) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const clamp = (v, min, max, def) => Math.min(Math.max(parseInt(v) || def, min), max);
const ah = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Error del servidor' }); });
const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

// ---------- app ----------
let raffles, participants;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/health', (req, res) => res.send('ok'));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', page('admin.html'));
app.get('/s/:code', page('join.html'));

// ----- público -----
app.get('/api/public/:code', ah(async (req, res) => {
  const r = await raffles.findOne({ code: req.params.code });
  if (!r) return res.status(404).json({ error: 'Sorteo no encontrado' });
  res.json({ name: r.name, prize: r.prize, description: r.description, open: r.open });
}));

app.post('/api/public/:code/join', ah(async (req, res) => {
  if (limited('j' + req.ip, 15, 60000)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en un minuto.' });
  const r = await raffles.findOne({ code: req.params.code });
  if (!r) return res.status(404).json({ error: 'Sorteo no encontrado' });
  if (!r.open) return res.status(409).json({ error: 'Las inscripciones de este sorteo están cerradas.' });

  const name = clean(req.body.name, 80);
  const contact = clean(req.body.contact, 120);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  const isPhone = contact.replace(/\D/g, '').length >= 7 && /^[\d\s()+\-]+$/.test(contact);
  if (name.length < 2) return res.status(400).json({ error: 'Escribí tu nombre completo.' });
  if (!isEmail && !isPhone) return res.status(400).json({ error: 'Ingresá un email o teléfono válido.' });

  try {
    await participants.insertOne({
      raffleId: r._id, name, contact,
      contactKey: contact.toLowerCase().replace(/[\s()\-]/g, ''),
      createdAt: new Date(), winnerOrder: null,
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Ya estás inscripto con ese contacto.' });
    throw e;
  }
  res.json({ ok: true, name });
}));

// ----- admin: sesión -----
app.post('/api/admin/login', (req, res) => {
  if (limited('l' + req.ip, 8, 60000)) return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto.' });
  if (!safeEq(sign(String(req.body.password || '')), sign(ADMIN_PASSWORD))) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const exp = Date.now() + 7 * 864e5;
  res.setHeader('Set-Cookie', `adm=${exp}.${sign(String(exp))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

// ----- admin: sorteos -----
const getRaffle = async (req, res) => {
  const r = ObjectId.isValid(req.params.id) ? await raffles.findOne({ _id: new ObjectId(req.params.id) }) : null;
  if (!r) res.status(404).json({ error: 'Sorteo no encontrado' });
  return r;
};

app.get('/api/admin/raffles', requireAdmin, ah(async (req, res) => {
  const list = await raffles.find().sort({ createdAt: -1 }).toArray();
  const counts = await participants.aggregate([
    { $group: { _id: '$raffleId', n: { $sum: 1 }, w: { $sum: { $cond: [{ $ne: ['$winnerOrder', null] }, 1, 0] } } } },
  ]).toArray();
  const m = new Map(counts.map((c) => [String(c._id), c]));
  res.json(list.map((r) => ({ ...r, participants: m.get(String(r._id))?.n || 0, winners: m.get(String(r._id))?.w || 0 })));
}));

app.post('/api/admin/raffles', requireAdmin, ah(async (req, res) => {
  const name = clean(req.body.name, 100);
  if (!name) return res.status(400).json({ error: 'Poné un nombre para el sorteo.' });
  const { insertedId } = await raffles.insertOne({
    code: crypto.randomBytes(5).toString('hex'),
    name,
    prize: clean(req.body.prize, 100),
    description: clean(req.body.description, 300),
    winnersCount: clamp(req.body.winnersCount, 1, 100, 1),
    open: true,
    createdAt: new Date(),
    drawnAt: null,
  });
  res.json({ id: insertedId });
}));

app.get('/api/admin/raffles/:id', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  const list = await participants.find({ raffleId: r._id }).sort({ createdAt: 1 }).toArray();
  const joinUrl = `${baseUrl(req)}/s/${r.code}`;
  res.json({ raffle: r, participants: list, joinUrl, qr: await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }) });
}));

app.get('/api/admin/raffles/:id/qr.png', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  const buf = await QRCode.toBuffer(`${baseUrl(req)}/s/${r.code}`, { width: 1024, margin: 2 });
  res.type('png').send(buf);
}));

app.patch('/api/admin/raffles/:id', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  const set = {};
  if (typeof req.body.open === 'boolean') set.open = req.body.open;
  if (req.body.winnersCount) set.winnersCount = clamp(req.body.winnersCount, 1, 100, 1);
  await raffles.updateOne({ _id: r._id }, { $set: set });
  res.json({ ok: true });
}));

app.delete('/api/admin/raffles/:id', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  await participants.deleteMany({ raffleId: r._id });
  await raffles.deleteOne({ _id: r._id });
  res.json({ ok: true });
}));

app.delete('/api/admin/raffles/:id/participants/:pid', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  if (!ObjectId.isValid(req.params.pid)) return res.status(404).json({ error: 'No encontrado' });
  await participants.deleteOne({ _id: new ObjectId(req.params.pid), raffleId: r._id });
  res.json({ ok: true });
}));

// Sortea entre quienes aún no ganaron (se puede repetir para sumar ganadores/suplentes)
app.post('/api/admin/raffles/:id/draw', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  const pool = await participants.find({ raffleId: r._id, winnerOrder: null }).toArray();
  if (!pool.length) return res.status(409).json({ error: 'No quedan participantes para sortear.' });
  const already = await participants.countDocuments({ raffleId: r._id, winnerOrder: { $ne: null } });
  const want = Math.min(clamp(req.body.count, 1, 100, r.winnersCount), pool.length);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, want);
  for (let i = 0; i < picked.length; i++) {
    await participants.updateOne({ _id: picked[i]._id }, { $set: { winnerOrder: already + i + 1 } });
  }
  await raffles.updateOne({ _id: r._id }, { $set: { open: false, drawnAt: new Date() } });
  res.json({ winners: picked.map((p, i) => ({ _id: p._id, name: p.name, winnerOrder: already + i + 1 })) });
}));

app.post('/api/admin/raffles/:id/reset-draw', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  await participants.updateMany({ raffleId: r._id }, { $set: { winnerOrder: null } });
  await raffles.updateOne({ _id: r._id }, { $set: { drawnAt: null } });
  res.json({ ok: true });
}));

app.get('/api/admin/raffles/:id/export.csv', requireAdmin, ah(async (req, res) => {
  const r = await getRaffle(req, res); if (!r) return;
  const list = await participants.find({ raffleId: r._id }).sort({ createdAt: 1 }).toArray();
  const rows = [['Nombre', 'Contacto', 'Inscripción', 'Ganador'].map(csvCell).join(',')];
  for (const p of list) {
    rows.push([p.name, p.contact, p.createdAt.toISOString(), p.winnerOrder ? `#${p.winnerOrder}` : ''].map(csvCell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inscriptos-${r.code}.csv"` });
  res.send('\uFEFF' + rows.join('\r\n'));
}));

// ---------- arranque ----------
(async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'sorteos');
  raffles = db.collection('raffles');
  participants = db.collection('participants');
  await raffles.createIndex({ code: 1 }, { unique: true });
  await participants.createIndex({ raffleId: 1, contactKey: 1 }, { unique: true });
  app.listen(PORT, () => console.log(`Sorteos listo en el puerto ${PORT}`));
})().catch((e) => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
