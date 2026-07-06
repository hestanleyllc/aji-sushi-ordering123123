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
    const opts = it.options ? Object.entries(it.options).map(([k,v])=>{
      if(Array.isArray(v)) return `    ${k}:\n` + v.map(x=>`      – ${x}`).join('\n');
      return `    ${k}: ${v}`;
    }).join('\n') : '';
    const note = it.note ? `\n    Note: ${it.note}` : '';
    return `  x${it.qty} ${it.name} ($${it.price})\n${opts}${note}`;
  }).join('\n');
  const text = `New order #${order.num}\n\n${itemLines}\n\nSubtotal: $${Number(order.subtotal||order.total).toFixed(2)}\nTax: $${Number(order.tax||0).toFixed(2)}\nTotal: $${Number(order.total).toFixed(2)}\nPayment: ${order.paid ? 'PAID ONLINE' : 'Pay in store'}\nCustomer: ${order.name || '—'}\nPhone: ${order.phone || '—'}\nType: ${order.location}${order.deliveryAddress ? ' — '+order.deliveryAddress : ''}\n${order.note ? 'Order note: '+order.note : ''}`;
  mailTransporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject: `New order #${order.num} — $${order.total}`,
    text,
  }).catch(err => console.error('Failed to send order notification email', err));
}

// ---- Printer (PrintNode) ----
const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = process.env.PRINTNODE_PRINTER_ID; // default/general printer, used as fallback
if(!PRINTNODE_API_KEY){
  console.log('Kitchen printing disabled — set PRINTNODE_API_KEY to enable it.');
}

function ticketHeaderLines(order, stationLabel){
  const name = (data.config.siteInfo && data.config.siteInfo.name) || 'ORDER';
  const line = '--------------------------------';
  const lines = [name, line];
  if(stationLabel) lines.push(`STATION: ${stationLabel.toUpperCase()}`, line);
  lines.push(`Order #${order.num}`, `Type: ${order.location}${order.deliveryAddress ? ' — '+order.deliveryAddress : ''}`);
  if(order.name) lines.push(`Name: ${order.name}`);
  if(order.phone) lines.push(`Phone: ${order.phone}`);
  lines.push(line);
  return lines;
}

function itemLines(it, label){
  const lines = [`x${it.qty}  ${label}  $${(it.price*it.qty).toFixed(2)}`];
  if(it.options){
    Object.entries(it.options).forEach(([k,v])=>{
      if(!v) return;
      if(Array.isArray(v)){
        lines.push(`   ${k}:`);
        v.forEach(x=> lines.push(`     - ${x}`));
      } else {
        lines.push(`   ${k}: ${v}`);
      }
    });
  }
  if(it.note) lines.push(`   Note: ${it.note}`);
  return lines;
}

function buildReceiptText(order){
  const line = '--------------------------------';
  const lines = ticketHeaderLines(order, null);
  order.items.forEach(it=>{ lines.push(...itemLines(it, it.name)); });
  lines.push(line);
  lines.push(`Subtotal: $${Number(order.subtotal||order.total).toFixed(2)}`);
  lines.push(`Tax: $${Number(order.tax||0).toFixed(2)}`);
  lines.push(`Total: $${Number(order.total).toFixed(2)}`);
  lines.push(`Payment: ${order.paid ? 'PAID ONLINE' : 'Pay in store'}`);
  if(order.note) lines.push(`Order note: ${order.note}`);
  lines.push('');
  lines.push(new Date(order.createdAt).toLocaleString('en-US'));
  return lines.join('\n');
}

function buildStationReceiptText(order, stationLabel, items){
  const lines = ticketHeaderLines(order, stationLabel);
  items.forEach(({it,label})=>{ lines.push(...itemLines(it, label)); });
  lines.push('--------------------------------');
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

async function printToPrinter(printerId, title, text){
  if(!PRINTNODE_API_KEY || !printerId) return;
  try{
    const content = buildEscPosBuffer(text).toString('base64');
    const auth = Buffer.from(PRINTNODE_API_KEY + ':').toString('base64');
    const res = await fetch('https://api.printnode.com/printjobs', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: Number(printerId),
        title,
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

async function printOrderTicket(order){
  if(!PRINTNODE_API_KEY) return;
  const stations = (data.config.printStations || []).filter(s => s.printerId);

  // No stations configured yet — keep the original single-ticket behavior.
  if(stations.length === 0){
    if(!PRINTNODE_PRINTER_ID) return;
    await printToPrinter(PRINTNODE_PRINTER_ID, `Order #${order.num}`, buildReceiptText(order));
    return;
  }

  // Split items across stations based on each item's printRouting rules.
  const groups = {}; // stationName -> [{it, label}]
  const generalItems = [];
  order.items.forEach(it=>{
    const routing = Array.isArray(it.printRouting) ? it.printRouting.filter(r => r.station) : [];
    if(routing.length){
      routing.forEach(r=>{
        const label = (r.label && r.label.trim()) ? r.label.trim() : it.name;
        groups[r.station] = groups[r.station] || [];
        groups[r.station].push({ it, label });
      });
    } else {
      generalItems.push({ it, label: it.name });
    }
  });

  for(const stationName of Object.keys(groups)){
    const station = stations.find(s => s.name === stationName);
    if(!station) continue;
    await printToPrinter(station.printerId, `Order #${order.num} — ${stationName}`, buildStationReceiptText(order, stationName, groups[stationName]));
  }

  if(generalItems.length){
    if(PRINTNODE_PRINTER_ID){
      await printToPrinter(PRINTNODE_PRINTER_ID, `Order #${order.num} — General`, buildStationReceiptText(order, 'General', generalItems));
    } else {
      const fallback = stations[0];
      await printToPrinter(fallback.printerId, `Order #${order.num} — ${fallback.name}`, buildStationReceiptText(order, fallback.name, generalItems));
    }
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
app.get('/restaurant-orders.html', requireAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'restaurant-orders.html')));
app.get('/admin.html', requireAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// If DATA_DIR is set (e.g. pointing to a Render persistent disk mount path),
// data.json is written there so it survives restarts and redeploys.
// If not set, it falls back to the app folder (fine for local use, but ephemeral on Render).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_CONFIG = {
  siteInfo: {
    name: 'MAPLE & MAIN',
    tagline: 'Est. on Main Street',
    payNote: 'No online payment — please pay at the counter or with your server.',
    contact: { phone: '', address: '1620 NY-22, Brewster, NY 10509', hours: '' },
    notifyEmail: '',
    taxRate: 8.375,
    deliveryEnabled: false,
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
  menu: [{"cat":"Appetizers","items":[{"id":"d1","name":"Gyoza","desc":"Pork or veggie, steamed or fried dumplings","price":6.5,"soldOut":false,"optionGroups":[]},{"id":"d2","name":"Shumai","desc":"Steamed shrimp dumpling","price":6.5,"soldOut":false,"optionGroups":[]},{"id":"d3","name":"Edamame","desc":"Steamed fresh soybeans","price":6.5,"soldOut":false,"optionGroups":[]},{"id":"d4","name":"Crispy Soft Shell Crab","desc":"","price":10.95,"soldOut":false,"optionGroups":[]},{"id":"d5","name":"Crispy Calamari","desc":"","price":9.5,"soldOut":false,"optionGroups":[]},{"id":"d6","name":"Japanese Spring Roll","desc":"","price":4,"soldOut":false,"optionGroups":[]},{"id":"d7","name":"Shrimp & Vegetable Tempura","desc":"","price":8.5,"soldOut":false,"optionGroups":[]},{"id":"d8","name":"Age Tofu","desc":"","price":6.5,"soldOut":false,"optionGroups":[]},{"id":"d9","name":"Sushi Pizza","desc":"Tuna roll, salmon roll & California roll","price":12.75,"soldOut":false,"optionGroups":[]},{"id":"d10","name":"Sashimi Appetizer","desc":"5 pcs assorted raw fish with seasoned rice","price":10.95,"soldOut":false,"optionGroups":[]},{"id":"d11","name":"Sashimi","desc":"Assorted of sliced raw fish","price":12.95,"soldOut":false,"optionGroups":[]},{"id":"d12","name":"Kani Su","desc":"Crabmeat and cucumber in ponzu sauce","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d13","name":"Tako Su","desc":"Octopus w. cucumber in ponzu sauce","price":10.25,"soldOut":false,"optionGroups":[]},{"id":"d14","name":"Sexy Jalapeno","desc":"Pancake topped w. avocado, spicy tuna, spicy mayo, eel sauce and scallion","price":12.75,"soldOut":false,"optionGroups":[]},{"id":"d15","name":"Yellowtail Jalapeno","desc":"Sliced yellowtail w. jalapeño and ponzu sauce","price":12.75,"soldOut":false,"optionGroups":[]},{"id":"d16","name":"Tuna or Salmon Tartar","desc":"Chopped tuna or salmon w. avocado and ponzu sauce","price":12.75,"soldOut":false,"optionGroups":[]},{"id":"d17","name":"Pepper Tuna","desc":"Sliced fresh tuna w. grounded pepper and ponzu sauce","price":12.75,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Salad","items":[{"id":"d18","name":"Green Salad","desc":"Lettuce, cucumber w. ginger dressing","price":3,"soldOut":false,"optionGroups":[]},{"id":"d19","name":"Seaweed Salad","desc":"Special Japanese seaweed w. sesame seeds","price":6.5,"soldOut":false,"optionGroups":[]},{"id":"d20","name":"Kani Salad","desc":"Crab sticks & cucumber mixed w. spicy mayo","price":6.75,"soldOut":false,"optionGroups":[]},{"id":"d21","name":"Spicy Seafood Salad","desc":"Crab salad w. kani, shrimp & octopus","price":9.75,"soldOut":false,"optionGroups":[]},{"id":"d22","name":"Black Pepper Tuna Salad","desc":"Green salad w. black pepper tuna","price":13.75,"soldOut":false,"optionGroups":[]},{"id":"d23","name":"Avocado Salad","desc":"Green salad w. avocado","price":6.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Soup","items":[{"id":"d24","name":"Miso Soup","desc":"","price":3,"soldOut":false,"optionGroups":[]},{"id":"d25","name":"Clear Soup","desc":"","price":3,"soldOut":false,"optionGroups":[]},{"id":"d26","name":"Spicy Noodle Soup","desc":"","price":9.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Sushi & Sashimi","items":[{"id":"d27","name":"Sushi Regular","desc":"9 pcs sushi with 1 California roll","price":20.95,"soldOut":false,"optionGroups":[]},{"id":"d28","name":"Sushi Deluxe","desc":"13 pcs sushi served w. rice on the side","price":23.95,"soldOut":false,"optionGroups":[]},{"id":"d29","name":"Sashimi Regular","desc":"16 pcs sashimi served w. rice on the side","price":23.95,"soldOut":false,"optionGroups":[]},{"id":"d30","name":"Sashimi Deluxe","desc":"16 pcs sashimi, deluxe cut, w. rice on the side","price":26.95,"soldOut":false,"optionGroups":[]},{"id":"d31","name":"Sushi and Sashimi Combo","desc":"Chef's choice of 7 pcs sushi, 9 pcs sashimi and a tuna roll","price":27.95,"soldOut":false,"optionGroups":[]},{"id":"d32","name":"Chirashi","desc":"Chef's choice of 15 pcs assorted fish over sushi rice","price":24.95,"soldOut":false,"optionGroups":[]},{"id":"d33","name":"Dinner Maki Combo","desc":"Tuna roll, salmon roll & California roll","price":16.95,"soldOut":false,"optionGroups":[]},{"id":"d34","name":"Unagi Don","desc":"Broiled smoked eel (10 pcs) with rice","price":24.95,"soldOut":false,"optionGroups":[]},{"id":"d35","name":"Salmon Don","desc":"10 pcs salmon with rice","price":23.95,"soldOut":false,"optionGroups":[]},{"id":"d36","name":"Tuna Don for 2","desc":"8 pcs sushi, 3 pcs salmon, 3 pcs yellowtail and a spicy crunchy tuna roll","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d37","name":"Love Boat for 2","desc":"3 pcs tuna, 3 pcs salmon, 3 pcs yellowtail and a spicy crunchy tuna roll","price":50.25,"soldOut":false,"optionGroups":[]},{"id":"d38","name":"Aji Sushi Combo","desc":"3 pcs sushi, 3 pcs sashimi, California roll and salmon avocado roll","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d39","name":"Aji Maki Combo","desc":"Spicy tuna roll, salmon avocado roll, red dragon roll and California roll","price":17.95,"soldOut":false,"optionGroups":[]},{"id":"d40","name":"Salmon Roe (2 pc)","desc":"A la carte","price":8,"soldOut":false,"optionGroups":[]},{"id":"d41","name":"Shrimp (2 pc)","desc":"A la carte","price":5,"soldOut":false,"optionGroups":[]},{"id":"d42","name":"Black Pepper Tuna (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d43","name":"Tuna (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d44","name":"White Tuna (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d45","name":"Striped Bass (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d46","name":"Red Snapper (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d47","name":"Yellowtail (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d48","name":"Salmon (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d49","name":"Flying Fish Roe (2 pc)","desc":"A la carte","price":5,"soldOut":false,"optionGroups":[]},{"id":"d50","name":"Scallop (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d51","name":"Red Clam (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d52","name":"Octopus (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d53","name":"Eel (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d54","name":"Smoked Salmon (2 pc)","desc":"A la carte","price":6,"soldOut":false,"optionGroups":[]},{"id":"d55","name":"Crab Stick (2 pc)","desc":"A la carte","price":5,"soldOut":false,"optionGroups":[]},{"id":"d56","name":"Custard Eggs (2 pc)","desc":"A la carte","price":5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Classic Rolls","items":[{"id":"d57","name":"Salmon Roll","desc":"Raw","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d58","name":"Yellowtail Roll","desc":"Raw","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d59","name":"Tuna Roll","desc":"Raw","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d60","name":"Tuna Avocado Roll","desc":"Raw","price":7,"soldOut":false,"optionGroups":[]},{"id":"d61","name":"Salmon Avocado Roll","desc":"Raw","price":7,"soldOut":false,"optionGroups":[]},{"id":"d62","name":"Yellowtail Jalapeño Roll","desc":"Raw, spicy","price":7,"soldOut":false,"optionGroups":[]},{"id":"d63","name":"Spicy Crunchy Tuna Roll","desc":"Raw","price":6.75,"soldOut":false,"optionGroups":[]},{"id":"d64","name":"Spicy Crunchy Salmon Roll","desc":"Raw","price":6.75,"soldOut":false,"optionGroups":[]},{"id":"d65","name":"Spicy Crunchy Yellowtail Roll","desc":"Raw","price":7,"soldOut":false,"optionGroups":[]},{"id":"d66","name":"Tokyo Roll","desc":"Tuna, salmon, yellowtail, tobiko, crunch","price":7.25,"soldOut":false,"optionGroups":[]},{"id":"d67","name":"Alaska Roll","desc":"Salmon, avocado, cucumber","price":7,"soldOut":false,"optionGroups":[]},{"id":"d68","name":"Christmas Roll","desc":"Shrimp tempura, avocado topped with sliced salmon","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d69","name":"Sweet Heart Roll","desc":"Shrimp tempura, avocado, topped w. tuna, salmon & special mayo","price":8.5,"soldOut":false,"optionGroups":[]},{"id":"d70","name":"New York Roll","desc":"California roll topped w. avocado and eel sauce","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d71","name":"Philadelphia Roll","desc":"Smoked salmon, cream cheese & avocado","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d72","name":"California Roll","desc":"Hand roll","price":5.75,"soldOut":false,"optionGroups":[]},{"id":"d73","name":"Boston Roll","desc":"Shrimp, cucumber, lettuce & avocado","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d74","name":"Shrimp Avocado Roll","desc":"Hand roll","price":6.25,"soldOut":false,"optionGroups":[]},{"id":"d75","name":"Shrimp Cucumber Roll","desc":"Hand roll","price":6.75,"soldOut":false,"optionGroups":[]},{"id":"d76","name":"Vegetable Roll","desc":"Oshinko, avocado, cucumber, asparagus tempura","price":4.5,"soldOut":false,"optionGroups":[]},{"id":"d77","name":"Salmon Tempura Roll","desc":"","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d78","name":"Red Snapper Tempura Roll","desc":"","price":6.95,"soldOut":false,"optionGroups":[]},{"id":"d79","name":"Spicy Crunchy Shrimp Roll","desc":"Shrimp, cucumber, crunchy & Japanese mayo","price":7.25,"soldOut":false,"optionGroups":[]},{"id":"d80","name":"Eel Avocado or Cucumber Tempura Roll","desc":"","price":6.5,"soldOut":false,"optionGroups":[]},{"id":"d81","name":"Crab Meat Tempura Roll","desc":"Crabmeat, cucumber, avocado","price":5.5,"soldOut":false,"optionGroups":[]},{"id":"d82","name":"Fried Banana Roll","desc":"Shrimp tempura & avocado, crabmeat tempura & avocado","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d83","name":"Shrimp Asparagus Roll","desc":"","price":6.75,"soldOut":false,"optionGroups":[]},{"id":"d84","name":"Spicy Tuna Tempura Roll","desc":"","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d85","name":"Angry Mr. Mike Roll","desc":"Spicy crab meat, tempura shrimp, spicy mayo, topped w. pepper crab","price":6.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Special Rolls","items":[{"id":"d86","name":"Snow Mountain Roll","desc":"Avocado & pepper topped with lobster salad on top","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d87","name":"Crazy Tuna Roll","desc":"Tuna, salmon, yellowtail and avocado topped w. crunchy spicy tuna","price":14.75,"soldOut":false,"optionGroups":[]},{"id":"d88","name":"Rising Sun Roll","desc":"Spicy crunchy tuna and avocado inside, lobster salad on top","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d89","name":"Special Eel Roll","desc":"Tuna, salmon, yellowtail and avocado inside, topped w. sliced eel and avocado","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d90","name":"Beautiful Tuna Roll","desc":"Spicy tuna and cucumber rolled inside, salmon and avocado on top","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d91","name":"Beautiful Salmon Roll","desc":"Spicy salmon rolled inside, tuna and avocado on top","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d92","name":"Rainbow Roll","desc":"California roll topped w. assorted raw fish, salmon, avocado","price":13.75,"soldOut":false,"optionGroups":[]},{"id":"d93","name":"Route 22 Roll","desc":"Shrimp tempura rolled w. crunchy spicy tuna","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d94","name":"Hot Dragon Roll","desc":"California roll topped w. spicy crab and eel sauce","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d95","name":"American Dream Roll","desc":"Salmon, avocado, cream cheese topped w. crab meat and avocado","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d96","name":"Tempura California Roll","desc":"California roll, deep fried","price":11.95,"soldOut":false,"optionGroups":[]},{"id":"d97","name":"Volcano Roll","desc":"Crab meat and eel roll topped w. baked scallop","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d98","name":"Sexy Avocado Roll","desc":"Crab meat, spicy tuna, wrapped w. avocado","price":14.5,"soldOut":false,"optionGroups":[]},{"id":"d99","name":"Aji Roll","desc":"Shrimp tempura and eel roll, topped w. spicy crab meat, avocado, spicy mayo, eel sauce & fish egg","price":17.5,"soldOut":false,"optionGroups":[]},{"id":"d100","name":"Bubble Roll","desc":"10 pcs jumbo roll, eel, crab meat, shrimp mayo, topped w. spicy crab meat, cucumber, avocado, soybean wrap","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d101","name":"Creamy Potato Roll","desc":"Sweet potato, cream cheese, topped w. crunchy & eel","price":12.95,"soldOut":false,"optionGroups":[]},{"id":"d102","name":"Godzilla Roll","desc":"Spicy crab, crunchy inside, topped w. eel","price":15,"soldOut":false,"optionGroups":[]},{"id":"d103","name":"Red Dragon Roll","desc":"","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d104","name":"Spider Roll","desc":"Deep-fried soft shell crab, avocado, cucumber, tempura crumb, eel sauce","price":12.5,"soldOut":false,"optionGroups":[]},{"id":"d105","name":"Brewster Roll","desc":"Spicy crab meat & mix crab crunchy inside, topped w. eel","price":17.75,"soldOut":false,"optionGroups":[]},{"id":"d106","name":"Naruto Roll","desc":"Tuna, salmon, yellowtail and avocado wrapped in cucumber instead of rice","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d107","name":"Pink Lady Roll","desc":"10 pcs jumbo rolls, tuna, yellowtail wrapped in soybean paper","price":16.5,"soldOut":false,"optionGroups":[]},{"id":"d108","name":"Special Lobster Roll","desc":"Shrimp tempura & avocado roll topped w. lobster salad & special sauce","price":14.5,"soldOut":false,"optionGroups":[]},{"id":"d109","name":"Special Scallop Roll","desc":"Shrimp tempura & avocado roll wrapped in soybean paper w. special sauce","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d110","name":"Black Dragon Roll","desc":"Shrimp tempura & cucumber roll topped w. sliced eel, avocado & special sauce","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d111","name":"Sweet Potato Roll","desc":"Crunchy roll, sweet potato tempura, cucumber and avocado","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d112","name":"Spicy Girl Roll","desc":"Spicy tuna, spicy yellowtail, crunchy & avocado wrapped in soybean paper","price":15.5,"soldOut":false,"optionGroups":[]},{"id":"d113","name":"Green Dragon Roll","desc":"Eel cucumber roll topped w. sliced avocado, eel sauce","price":14.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Udon Soup","items":[{"id":"d114","name":"Vegetable Udon Soup","desc":"","price":11.95,"soldOut":false,"optionGroups":[]},{"id":"d115","name":"Tempura Udon Soup","desc":"","price":14.95,"soldOut":false,"optionGroups":[]},{"id":"d116","name":"Nabeyaki Udon Soup","desc":"","price":15.95,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Rice & Noodle","items":[{"id":"d117","name":"Vegetable Egg Fried Rice","desc":"","price":4.95,"soldOut":false,"optionGroups":[]},{"id":"d118","name":"Chicken Egg Fried Rice","desc":"","price":6.95,"soldOut":false,"optionGroups":[]},{"id":"d119","name":"Shrimp Egg Fried Rice","desc":"","price":7.95,"soldOut":false,"optionGroups":[]},{"id":"d120","name":"White Rice","desc":"","price":2.5,"soldOut":false,"optionGroups":[]},{"id":"d121","name":"Chicken Noodle","desc":"","price":6.95,"soldOut":false,"optionGroups":[]},{"id":"d122","name":"Vegetable Noodle","desc":"","price":6.95,"soldOut":false,"optionGroups":[]},{"id":"d123","name":"Shrimp Noodle","desc":"","price":8.95,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Dessert","items":[{"id":"d124","name":"Green Tea Ice Cream","desc":"","price":4.5,"soldOut":false,"optionGroups":[]},{"id":"d125","name":"Vanilla Ice Cream","desc":"","price":4.5,"soldOut":false,"optionGroups":[]},{"id":"d126","name":"Tempura Banana","desc":"","price":7,"soldOut":false,"optionGroups":[]},{"id":"d127","name":"Tempura Ice Cream","desc":"","price":7,"soldOut":false,"optionGroups":[]},{"id":"d128","name":"Fried Cheesecake","desc":"","price":7,"soldOut":false,"optionGroups":[]},{"id":"d129","name":"Mochi Ice Cream","desc":"2 pcs","price":5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Tempura & Katsu","items":[{"id":"d130","name":"Vegetable Tempura","desc":"Served with miso soup, salad and rice","price":15.25,"soldOut":false,"optionGroups":[]},{"id":"d131","name":"Chicken Tempura","desc":"Served with miso soup, salad and rice","price":16.95,"soldOut":false,"optionGroups":[]},{"id":"d132","name":"Shrimp Tempura","desc":"Served with miso soup, salad and rice","price":17.95,"soldOut":false,"optionGroups":[]},{"id":"d133","name":"Chicken Katsu","desc":"Deep-fried chicken cutlet, served with miso soup, salad and rice","price":16.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Teriyaki Dinner","items":[{"id":"d134","name":"Tofu Teriyaki","desc":"Served with miso soup and fried noodle","price":17.75,"soldOut":false,"optionGroups":[]},{"id":"d135","name":"Chicken Teriyaki","desc":"Served with miso soup and fried noodle","price":18.95,"soldOut":false,"optionGroups":[]},{"id":"d136","name":"Beef Teriyaki","desc":"Served with miso soup and fried noodle","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d137","name":"Salmon Teriyaki","desc":"Served with miso soup and fried noodle","price":24.95,"soldOut":false,"optionGroups":[]},{"id":"d138","name":"Scallop Teriyaki","desc":"Served with miso soup and fried noodle","price":25.95,"soldOut":false,"optionGroups":[]},{"id":"d139","name":"Shrimp Teriyaki","desc":"Served with miso soup and fried noodle","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d140","name":"Chicken & Steak","desc":"Served with miso soup and fried noodle","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d141","name":"Chicken & Shrimp","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d142","name":"Chicken & Salmon","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d143","name":"Chicken & Scallop","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d144","name":"Steak & Shrimp","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d145","name":"Steak & Salmon","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d146","name":"Steak & Scallop","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d147","name":"Shrimp & Salmon","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d148","name":"Shrimp & Scallop","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]},{"id":"d149","name":"Salmon & Scallop","desc":"Served with miso soup and fried noodle","price":24.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Dinner Box","items":[{"id":"d150","name":"Chicken Teriyaki Box","desc":"Served with miso soup, salad, white rice","price":20.95,"soldOut":false,"optionGroups":[]},{"id":"d151","name":"Beef Teriyaki Box","desc":"Served with miso soup, salad, white rice","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d152","name":"Shrimp Teriyaki Box","desc":"Served with miso soup, salad, white rice","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d153","name":"Scallop Teriyaki Box","desc":"Served with miso soup, salad, white rice","price":23.95,"soldOut":false,"optionGroups":[]},{"id":"d154","name":"Salmon Teriyaki Box","desc":"Served with miso soup, salad, white rice","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d155","name":"Shrimp Tempura Box","desc":"Served with miso soup, salad, white rice","price":22.95,"soldOut":false,"optionGroups":[]},{"id":"d156","name":"Chicken Katsu Box","desc":"Served with miso soup, salad, white rice","price":19.95,"soldOut":false,"optionGroups":[]},{"id":"d157","name":"Chicken Tempura Box","desc":"Served with miso soup, salad, white rice","price":22.95,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Sushi Bar Lunch","items":[{"id":"d158","name":"Sushi Lunch","desc":"5 pcs sushi and California roll, served with miso soup","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d159","name":"Sashimi Lunch","desc":"10 pcs assorted sashimi, served with miso soup","price":15.95,"soldOut":false,"optionGroups":[]},{"id":"d160","name":"Sushi and Sashimi Lunch","desc":"4 pcs sushi, 6 pcs sashimi and spicy tuna roll, served with miso soup","price":17.95,"soldOut":false,"optionGroups":[]},{"id":"d161","name":"Any Two Rolls","desc":"Choose any 2 classic rolls","price":13,"soldOut":false,"optionGroups":[]},{"id":"d162","name":"Any Three Rolls","desc":"Choose any 3 classic rolls","price":16.5,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":true,"start":"11:00","end":"15:00"}},{"cat":"Lunch Bento Box","items":[{"id":"d163","name":"Chicken Teriyaki Bento Box","desc":"Served with miso soup, salad, rice, shumai & California roll","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d164","name":"Chicken Katsu Bento Box","desc":"Served with miso soup, salad, rice, shumai & California roll","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d165","name":"Shrimp Teriyaki Bento Box","desc":"Served with miso soup, salad, rice, shumai & California roll","price":13.95,"soldOut":false,"optionGroups":[]},{"id":"d166","name":"Beef Teriyaki Bento Box","desc":"Served with miso soup, salad, rice, shumai & California roll","price":14.95,"soldOut":false,"optionGroups":[]},{"id":"d167","name":"Salmon Teriyaki Bento Box","desc":"Served with miso soup, salad, rice, shumai & California roll","price":14.95,"soldOut":false,"optionGroups":[]},{"id":"d168","name":"Shrimp and Vegetable Tempura Bento Box","desc":"Served with miso soup, salad, rice, shumai & California roll","price":14.95,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":true,"start":"11:00","end":"15:00"}},{"cat":"Dinner Special","items":[{"id":"d169","name":"Any 2 Special Rolls","desc":"Served with soup or salad","price":25.95,"soldOut":false,"optionGroups":[]},{"id":"d170","name":"Any 3 Special Rolls","desc":"Served with soup or salad","price":36.95,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}},{"cat":"Party Tray","items":[{"id":"d171","name":"Party Tray A","desc":"1 Special Eel Roll, 1 Green Dragon Roll, 1 Creamy Potato Roll, 1 Godzilla Roll","price":85,"soldOut":false,"optionGroups":[]},{"id":"d172","name":"Party Tray B","desc":"2 Red Dragon Roll, 1 Special Lobster Roll, 2 California Roll, 2 Salmon Avocado Roll","price":60,"soldOut":false,"optionGroups":[]},{"id":"d173","name":"Party Tray C","desc":"2 Shrimp Tempura Roll, 2 Spicy Crab Roll, 1 Eel Cucumber Roll, 1 Avocado Roll","price":50,"soldOut":false,"optionGroups":[]},{"id":"d174","name":"Party Tray D","desc":"2 Red Dragon Roll, 2 Spicy Tuna Roll, 1 Special Lobster Roll, 1 Rainbow Roll, 1 Avocado Roll, 1 Salmon Avocado Roll","price":65,"soldOut":false,"optionGroups":[]}],"orderWindow":{"enabled":false,"start":"11:00","end":"15:00"}}],
  printStations: []
};

// Optional free persistent storage using Upstash Redis (no credit card, no paid Render plan needed).
// If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, data is stored there instead of a local file.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_KEY = 'maple-and-main-data';

if(useUpstash){
  console.log('Using Upstash Redis for persistent storage.');
} else {
  console.log('Using local file storage (' + DATA_FILE + '). Set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN, or a Render persistent disk, to avoid data loss on restart.');
}

function freshData(){
  return { config: DEFAULT_CONFIG, orders: [], dailyOrderCounter: { date: '', count: 0 } };
}

async function loadData(){
  if(useUpstash){
    try{
      const res = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const json = await res.json();
      if(json && json.result){
        const parsed = JSON.parse(json.result);
        if(!parsed.config) parsed.config = DEFAULT_CONFIG;
        if(!parsed.orders) parsed.orders = [];
        if(!parsed.dailyOrderCounter) parsed.dailyOrderCounter = { date: '', count: 0 };
        return parsed;
      }
    }catch(e){ console.error('Failed to load from Upstash', e); }
    return freshData();
  }
  if(!fs.existsSync(DATA_FILE)) return freshData();
  try{
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if(!parsed.config) parsed.config = DEFAULT_CONFIG;
    if(!parsed.orders) parsed.orders = [];
    if(!parsed.dailyOrderCounter) parsed.dailyOrderCounter = { date: '', count: 0 };
    return parsed;
  }catch(e){
    return freshData();
  }
}

let data;
let saveQueue = Promise.resolve();

async function persistData(){
  const payload = JSON.stringify(data, null, 2);
  if(useUpstash){
    try{
      await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: payload,
      });
    }catch(e){ console.error('Failed to save to Upstash', e); }
    return;
  }
  return new Promise((resolve) => {
    fs.writeFile(DATA_FILE, payload, (err) => {
      if(err) console.error('Failed to save data.json', err);
      resolve();
    });
  });
}

function saveData(){
  saveQueue = saveQueue.then(() => persistData());
  return saveQueue;
}

// ---- Config (site info + menu) ----
app.get('/api/config', (req, res) => {
  // Public endpoint (the ordering page needs it) — strip anything staff-only before sending.
  const publicConfig = JSON.parse(JSON.stringify(data.config));
  if(publicConfig.siteInfo) delete publicConfig.siteInfo.notifyEmail;
  if(publicConfig.siteInfo) publicConfig.siteInfo.onlinePaymentEnabled = !!stripe;
  delete publicConfig.printStations;
  res.json(publicConfig);
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
// Listing all orders exposes customer names/phone numbers — staff only.
app.get('/api/orders', requireAdminAuth, (req, res) => {
  res.json(data.orders);
});

// ---- Real-time push (Server-Sent Events) so the kitchen alarm rings instantly ----
// Also staff-only, since it streams new order details as they arrive.
let sseClients = [];

// Not password-protected: EventSource (unlike fetch) can't send a custom
// Authorization header, and some browsers handle its native auth prompt poorly,
// causing repeated login popups. The regular polling requests (which ARE
// protected) remain the authoritative, secure data source either way.
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

// Single-order lookup stays public — customers use their own order's
// unguessable id to check pickup status without logging in.
app.get('/api/orders/:id', (req, res) => {
  const order = data.orders.find(o => o.id === req.params.id);
  if(!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ---- Ordering hours ----
function getTodayKey(timezone){
  const tz = timezone || 'America/New_York';
  try{
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  }catch(e){
    return new Date().toISOString().slice(0,10);
  }
}

function nextOrderNumber(){
  const tz = (data.config.siteInfo && data.config.siteInfo.orderingHours && data.config.siteInfo.orderingHours.timezone) || 'America/New_York';
  const todayKey = getTodayKey(tz);
  if(data.dailyOrderCounter.date !== todayKey){
    data.dailyOrderCounter = { date: todayKey, count: 0 };
  }
  data.dailyOrderCounter.count += 1;
  return String(data.dailyOrderCounter.count);
}

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

function getNowMinutes(timezone){
  const tz = timezone || 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hourStr = parts.find(p=>p.type==='hour').value;
  const minuteStr = parts.find(p=>p.type==='minute').value;
  return (Number(hourStr) % 24) * 60 + Number(minuteStr);
}

function isCategoryOpenNow(categoryName){
  const cat = (data.config.menu || []).find(c => c.cat === categoryName);
  if(!cat || !cat.orderWindow || !cat.orderWindow.enabled) return true;
  const tz = (data.config.siteInfo.orderingHours && data.config.siteInfo.orderingHours.timezone) || 'America/New_York';
  let nowMinutes;
  try{ nowMinutes = getNowMinutes(tz); }catch(e){ return true; }
  const [sh, sm] = (cat.orderWindow.start || '00:00').split(':').map(Number);
  const [eh, em] = (cat.orderWindow.end || '23:59').split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

app.get('/api/store-status', (req, res) => {
  res.json(getStoreStatus());
});

function validateOrderPayload(body){
  if(!Array.isArray(body.items) || body.items.length === 0){
    return { error: 'Order must include at least one item' };
  }
  const status = getStoreStatus();
  if(!status.open){
    return { error: 'Sorry, online ordering is currently closed. Please check our hours.', code: 'closed' };
  }
  for(const it of body.items){
    if(it.category && !isCategoryOpenNow(it.category)){
      const cat = (data.config.menu || []).find(c => c.cat === it.category);
      const w = cat && cat.orderWindow;
      return {
        error: `Sorry, "${it.category}" can only be ordered ${w ? `between ${w.start} and ${w.end}` : 'during its available hours'}.`,
        code: 'category_closed'
      };
    }
  }
  return null;
}

function createOrder(body, extra){
  const order = {
    id: 'o_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    num: nextOrderNumber(),
    items: body.items,
    subtotal: body.subtotal || 0,
    tax: body.tax || 0,
    total: body.total || 0,
    note: body.note || '',
    name: body.name || '',
    phone: body.phone || '',
    location: body.location || 'Pickup',
    deliveryAddress: body.deliveryAddress || '',
    status: 'pending',
    pickupTime: null,
    createdAt: Date.now(),
    paid: !!(extra && extra.paid),
    paymentMethod: (extra && extra.paymentMethod) || 'in_store',
  };
  data.orders.push(order);
  saveData();
  broadcast('new-order', { order });
  sendNewOrderEmail(order);
  printOrderTicket(order);
  return order;
}

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const err = validateOrderPayload(body);
  if(err){
    return res.status(err.code === 'closed' || err.code === 'category_closed' ? 403 : 400).json({ error: err.code || 'invalid', message: err.error });
  }
  const order = createOrder(body, { paid: false, paymentMethod: 'in_store' });
  res.json(order);
});

// ---- Online payment (Stripe) ----
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
if(!stripe){
  console.log('Online payment disabled — set STRIPE_SECRET_KEY to enable it.');
}
const pendingCheckouts = new Map(); // checkoutId -> cart payload, cleared once paid or abandoned

app.post('/api/checkout', async (req, res) => {
  if(!stripe) return res.status(400).json({ error: 'Online payment is not enabled.' });
  const body = req.body || {};
  const err = validateOrderPayload(body);
  if(err){
    return res.status(err.code === 'closed' || err.code === 'category_closed' ? 403 : 400).json({ error: err.code || 'invalid', message: err.error });
  }
  const checkoutId = 'chk_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  pendingCheckouts.set(checkoutId, body);
  setTimeout(() => pendingCheckouts.delete(checkoutId), 30 * 60 * 1000); // expire abandoned checkouts after 30 min

  try{
    const line_items = body.items.map(it => ({
      price_data: {
        currency: 'usd',
        product_data: { name: it.name },
        unit_amount: Math.round(it.price * 100),
      },
      quantity: it.qty,
    }));
    if(body.tax){
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: 'Sales Tax' }, unit_amount: Math.round(body.tax * 100) },
        quantity: 1,
      });
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      client_reference_id: checkoutId,
      success_url: `${baseUrl}/customer-order.html?checkout_id=${checkoutId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/customer-order.html?payment_cancelled=1`,
    });
    res.json({ url: session.url });
  }catch(e){
    console.error('Stripe checkout session creation failed', e);
    pendingCheckouts.delete(checkoutId);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

app.get('/api/checkout/verify', async (req, res) => {
  if(!stripe) return res.status(400).json({ error: 'Online payment is not enabled.' });
  const { checkout_id, session_id } = req.query;
  if(!checkout_id || !session_id) return res.status(400).json({ error: 'Missing checkout_id or session_id' });
  const pending = pendingCheckouts.get(checkout_id);
  if(!pending) return res.status(404).json({ error: 'This checkout has already been processed or has expired.' });
  try{
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if(session.client_reference_id !== checkout_id || session.payment_status !== 'paid'){
      return res.status(402).json({ error: 'Payment not confirmed yet.' });
    }
    pendingCheckouts.delete(checkout_id);
    const order = createOrder(pending, { paid: true, paymentMethod: 'online' });
    res.json({ ok: true, order });
  }catch(e){
    console.error('Stripe verify failed', e);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

app.patch('/api/orders/:id', requireAdminAuth, (req, res) => {
  const idx = data.orders.findIndex(o => o.id === req.params.id);
  if(idx === -1) return res.status(404).json({ error: 'Order not found' });
  data.orders[idx] = { ...data.orders[idx], ...req.body };
  saveData();
  broadcast('order-updated', { order: data.orders[idx] });
  res.json(data.orders[idx]);
});

app.delete('/api/orders/:id', requireAdminAuth, (req, res) => {
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// Housekeeping: drop orders older than 48h so data.json doesn't grow forever
setInterval(() => {
  if(!data) return;
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const before = data.orders.length;
  data.orders = data.orders.filter(o => o.createdAt > cutoff);
  if(data.orders.length !== before) saveData();
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
loadData().then((loaded) => {
  data = loaded;
  app.listen(PORT, () => {
    console.log('Maple & Main server running on port ' + PORT);
  });
}).catch((e) => {
  console.error('Failed to load initial data, starting with defaults', e);
  data = freshData();
  app.listen(PORT, () => {
    console.log('Maple & Main server running on port ' + PORT);
  });
});
