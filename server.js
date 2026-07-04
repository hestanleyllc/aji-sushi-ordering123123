const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

let mailTransporter = null;
if(process.env.EMAIL_USER && process.env.EMAIL_PASS){
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
} else {
  console.log('Email notifications disabled — set EMAIL_USER and EMAIL_PASS to enable them.');
}

function sendNewOrderEmail(order){
  const to = data.config.siteInfo && data.config.siteInfo.notifyEmail;
  if(!mailTransporter || !to) return;
  const itemLines = order.items.map(it=>{
    const opts = it.options ? Object.entries(it.options).map(([k,v])=>`    - ${k}: ${v}`).join('\n') : '';
    const note = it.note ? `\n    Note: ${it.note}` : '';
    return `  x${it.qty} ${it.name} ($${it.price})\n${opts}${note}`;
  }).join('\n');
  const text = `New order #${order.num}\n\n${itemLines}\n\nTotal: $${order.total}\nCustomer: ${order.name || '—'}\nPhone: ${order.phone || '—'}\nType: ${order.location}\n${order.note ? 'Order note: '+order.note : ''}`;
  mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject: `New order #${order.num} — $${order.total}`,
    text,
  }).catch(err => console.error('Failed to send order notification email', err));
}

// ---- Printer (PrintNode) ----
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = process.env.PRINTNODE_PRINTER_ID;
if(!PRINTNODE_API_KEY || !PRINTNODE_PRINTER_ID){
  console.log('Kitchen printing disabled — set PRINTNODE_API_KEY and PRINTNODE_PRINTER_ID to enable it.');
}

function buildReceiptText(order){
  const name = (data.config.siteInfo && data.config.siteInfo.name) || 'ORDER';
  const line = '--------------------------------';
  const lines = [name, line, `Order #${order.num}`, `Type: ${order.location}`];
  if(order.name) lines.push(`Name: ${order.name}`);
  if(order.phone) lines.push(`Phone: ${order.phone}`);
  lines.push(line);
  order.items.forEach(it=>{
    lines.push(`x${it.qty}  ${it.name}  $${(it.price*it.qty).toFixed(2)}`);
    if(it.options){
      Object.entries(it.options).forEach(([k,v])=>{ if(v) lines.push(`   ${k}: ${v}`); });
    }
    if(it.note) lines.push(`   Note: ${it.note}`);
  });
  lines.push(line);
  lines.push(`Total: $${Number(order.total).toFixed(2)}`);
  if(order.note) lines.push(`Order note: ${order.note}`);
  lines.push('');
  lines.push(new Date(order.createdAt).toLocaleString('en-US'));
  return lines.join('\n');
}

function buildEscPosBuffer(text){
  const INIT = Buffer.from([0x1B, 0x40]); // ESC @  (reset printer)
  const body = Buffer.from(text + '\n\n\n', 'utf8');
  const CUT = Buffer.from([0x1D, 0x56, 0x00]); // GS V 0 (full cut)
  return Buffer.concat([INIT, body, CUT]);
}

async function printOrderTicket(order){
  if(!PRINTNODE_API_KEY || !PRINTNODE_PRINTER_ID) return;
  try{
    const content = buildEscPosBuffer(buildReceiptText(order)).toString('base64');
    const auth = Buffer.from(PRINTNODE_API_KEY + ':').toString('base64');
    const res = await fetch('https://api.printnode.com/printjobs', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: Number(PRINTNODE_PRINTER_ID),
        title: `Order #${order.num}`,
        contentType: 'raw_base64',
        content,
        source: 'Maple & Main website',
      }),
    });
    if(!res.ok){
      console.error('PrintNode print failed:', res.status, await res.text());
    }
  }catch(e){
    console.error('Failed to send print job to PrintNode', e);
  }
}

const app = express();
app.use(express.json());

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

function requireAdminAuth(req, res, next){
  const authHeader = req.headers.authorization;
  if(!authHeader || !authHeader.startsWith('Basic ')){
    res.set('WWW-Authenticate', 'Basic realm="Maple & Main Admin"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
  const sep = decoded.indexOf(':');
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if(user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="Maple & Main Admin"');
  return res.status(401).send('Invalid credentials');
}

// ---- Pages (all html files live in the same folder as server.js — no subfolder needed) ----
function escapeAttr(str){
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function injectSeo(html, seo){
  if(!seo) return html;
  let out = html;
  if(seo.title){
    out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeAttr(seo.title)}</title>`);
  }
  if(seo.description){
    if(/<meta name="description"[^>]*>/.test(out)){
      out = out.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeAttr(seo.description)}">`);
    } else {
      out = out.replace('</head>', `  <meta name="description" content="${escapeAttr(seo.description)}">\n</head>`);
    }
  }
  return out;
}

app.get('/', (req, res) => res.redirect('/customer-order.html'));
app.get('/customer-order.html', (req, res) => {
  fs.readFile(path.join(__dirname, 'customer-order.html'), 'utf8', (err, html) => {
    if(err) return res.status(500).send('Error loading page');
    res.set('Content-Type', 'text/html');
    res.send(injectSeo(html, data.config.seo));
  });
});
app.get('/restaurant-orders.html', (req, res) => res.sendFile(path.join(__dirname, 'restaurant-orders.html')));
app.get('/admin.html', requireAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_CONFIG = {
  siteInfo: {
    name: 'MAPLE & MAIN',
    tagline: 'Est. on Main Street',
    payNote: 'No online payment — please pay at the counter or with your server.',
    contact: { phone: '', address: '1620 NY-22, Brewster, NY 10509', hours: '' },
    notifyEmail: '',
    orderingHours: {
      timezone: 'America/New_York',
      schedule: {
        mon: { closed: true },
        tue: { open: '11:00', close: '20:45' },
        wed: { open: '11:00', close: '20:45' },
        thu: { open: '11:00', close: '20:45' },
        fri: { open: '11:00', close: '20:45' },
        sat: { open: '11:00', close: '20:45' },
        sun: { open: '11:00', close: '20:45' },
      }
    }
  },
  seo: {
    title: 'Maple & Main · Order Online',
    description: 'Order online for pickup at Maple & Main.'
  },
  menu: [
    {cat:'Griddle & Eggs', items:[
      {id:'d1', name:'Buttermilk Pancake Stack', desc:'Three tall stack, warm maple syrup', price:11, soldOut:false, optionGroups:[]},
      {id:'d2', name:'The Main Street Skillet', desc:'Eggs, hash browns, cheddar, peppers', price:13, soldOut:false, optionGroups:[]},
    ]},
    {cat:'From the Grill', items:[
      {id:'d3', name:'Bacon Cheeseburger', desc:'Half-pound patty, smoked bacon, fries', price:15, soldOut:false, optionGroups:[]},
      {id:'d4', name:'BBQ Pulled Pork Sandwich', desc:'Slow-smoked, house slaw, brioche bun', price:14, soldOut:false, optionGroups:[]},
      {id:'d5', name:'Baked Mac & Cheese', desc:'Three-cheese blend, toasted crumb topping', price:12, soldOut:false, optionGroups:[]},
    ]},
    {cat:'Fountain & Sides', items:[
      {id:'d6', name:'Hand-Spun Milkshake', desc:'Vanilla, chocolate, or strawberry', price:7, soldOut:false, optionGroups:[]},
      {id:'d7', name:'Sweet Tea', desc:'Southern-style, brewed daily', price:3, soldOut:false, optionGroups:[]},
      {id:'d8', name:'Slice of Apple Pie', desc:'Warm, with a scoop of vanilla', price:6, soldOut:false, optionGroups:[]},
    ]},
  ]
};

function loadData(){
  if(!fs.existsSync(DATA_FILE)){
    return { config: DEFAULT_CONFIG, orders: [] };
  }
  try{
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if(!parsed.config) parsed.config = DEFAULT_CONFIG;
    if(!parsed.orders) parsed.orders = [];
    return parsed;
  }catch(e){
    return { config: DEFAULT_CONFIG, orders: [] };
  }
}

let data = loadData();
let saveQueue = Promise.resolve();
function saveData(){
  saveQueue = saveQueue.then(() => new Promise((resolve) => {
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
      if(err) console.error('Failed to save data.json', err);
      resolve();
    });
  }));
  return saveQueue;
}

// ---- Config (site info + menu) ----
app.get('/api/config', (req, res) => {
  res.json(data.config);
});

app.post('/api/config', requireAdminAuth, (req, res) => {
  if(!req.body || typeof req.body !== 'object'){
    return res.status(400).json({ error: 'Invalid config payload' });
  }
  data.config = req.body;
  saveData();
  res.json({ ok: true });
});

// ---- Orders ----
app.get('/api/orders', (req, res) => {
  res.json(data.orders);
});

// ---- Real-time push (Server-Sent Events) so the kitchen alarm rings instantly ----
let sseClients = [];

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.push(res);
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) {}
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c !== res);
  });
});

function broadcast(event, payload){
  const message = `data: ${JSON.stringify({ type: event, ...payload })}\n\n`;
  sseClients.forEach(res => {
    try { res.write(message); } catch(e) {}
  });
}

app.get('/api/orders/:id', (req, res) => {
  const order = data.orders.find(o => o.id === req.params.id);
  if(!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ---- Ordering hours ----
function getStoreStatus(){
  const orderingHours = data.config.siteInfo && data.config.siteInfo.orderingHours;
  if(!orderingHours || !orderingHours.schedule){
    return { open: true, schedule: null, timezone: null };
  }
  const tz = orderingHours.timezone || 'America/New_York';
  const now = new Date();
  let parts;
  try{
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
  }catch(e){
    return { open: true, schedule: orderingHours.schedule, timezone: tz };
  }
  const dayKey = parts.find(p=>p.type==='weekday').value.toLowerCase().slice(0,3);
  const hourStr = parts.find(p=>p.type==='hour').value;
  const minuteStr = parts.find(p=>p.type==='minute').value;
  const nowMinutes = (Number(hourStr) % 24) * 60 + Number(minuteStr);

  const day = orderingHours.schedule[dayKey];
  if(!day || day.closed){
    return { open: false, reason: 'closed_today', schedule: orderingHours.schedule, timezone: tz };
  }
  const [openH, openM] = (day.open || '00:00').split(':').map(Number);
  const [closeH, closeM] = (day.close || '23:59').split(':').map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;
  const isOpen = nowMinutes >= openMinutes && nowMinutes <= closeMinutes;
  return { open: isOpen, reason: isOpen ? null : 'outside_hours', schedule: orderingHours.schedule, timezone: tz };
}

app.get('/api/store-status', (req, res) => {
  res.json(getStoreStatus());
});

app.post('/api/orders', (req, res) => {
  const status = getStoreStatus();
  if(!status.open){
    return res.status(403).json({ error: 'closed', message: 'Sorry, online ordering is currently closed. Please check our hours.' });
  }
  const body = req.body || {};
  if(!Array.isArray(body.items) || body.items.length === 0){
    return res.status(400).json({ error: 'Order must include at least one item' });
  }
  const order = {
    id: 'o_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    num: String(Math.floor(100 + Math.random() * 900)),
    items: body.items,
    total: body.total || 0,
    note: body.note || '',
    name: body.name || '',
    phone: body.phone || '',
    location: body.location || 'Pickup',
    status: 'pending',
    pickupTime: null,
    createdAt: Date.now(),
  };
  data.orders.push(order);
  saveData();
  broadcast('new-order', { order });
  sendNewOrderEmail(order);
  printOrderTicket(order);
  res.json(order);
});

app.patch('/api/orders/:id', (req, res) => {
  const idx = data.orders.findIndex(o => o.id === req.params.id);
  if(idx === -1) return res.status(404).json({ error: 'Order not found' });
  data.orders[idx] = { ...data.orders[idx], ...req.body };
  saveData();
  broadcast('order-updated', { order: data.orders[idx] });
  res.json(data.orders[idx]);
});

app.delete('/api/orders/:id', (req, res) => {
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// Housekeeping: drop orders older than 48h so data.json doesn't grow forever
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const before = data.orders.length;
  data.orders = data.orders.filter(o => o.createdAt > cutoff);
  if(data.orders.length !== before) saveData();
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Maple & Main server running on port ' + PORT);
});
