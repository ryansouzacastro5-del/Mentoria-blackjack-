require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('node:https');
const dns = require('node:dns');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const PAGBANK_ENV = process.env.PAGBANK_ENV || 'sandbox';
const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ACCESS_SECRET = process.env.ACCESS_SECRET || 'troque-por-uma-chave-de-64-caracteres-aleatoria';
const LAYERBASE_URL = (process.env.LAYERBASE_URL || '').replace(/\/$/, '');
const LAYERBASE_API_KEY = process.env.LAYERBASE_API_KEY || '';
const BASE = PAGBANK_ENV === 'production' ? 'https://api.pagbank.com.br' : 'https://sandbox.api.pagbank.com.br';

// ===== CORREÇÃO DNS DO RENDER =====
// O DNS do Render não resolve api.pagbank.com.br, então a gente
// resolve o IP usando DNS do Google/Cloudflare e conecta direto no IP
const resolver = new dns.Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);

function resolvePagbankIp() {
  return new Promise((resolve, reject) => {
    const hostname = new URL(BASE).hostname;
    resolver.resolve4(hostname, (err, addrs) => {
      if (err) return reject(err);
      if (!addrs || !addrs.length) return reject(new Error('DNS sem resposta'));
      resolve(addrs[0]);
    });
  });
}

function pagbankRequest(pathUrl, method = 'GET', bodyObj = null) {
  return new Promise(async (resolve, reject) => {
    try {
      const hostname = new URL(BASE).hostname;
      const ip = await resolvePagbankIp();
      const body = bodyObj ? JSON.stringify(bodyObj) : null;
      const req = https.request({
        host: ip,
        port: 443,
        path: pathUrl,
        method: method,
        servername: hostname,
        headers: {
          'Authorization': 'Bearer ' + PAGBANK_TOKEN,
          'Content-Type': 'application/json',
          'Host': hostname,
          'Content-Length': body ? Buffer.byteLength(body) : 0
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}
// ===== FIM CORREÇÃO =====

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
function loadLocal(){ try{ return JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')); }catch{ return {}; } }
function saveLocal(o){ try{ fs.writeFileSync(ORDERS_FILE, JSON.stringify(o,null,2)); }catch{} }
async function lbRequest(p, method='GET', body=null){
  if(!LAYERBASE_URL || !LAYERBASE_API_KEY) return null;
  try{
    const r = await fetch(LAYERBASE_URL + p, { method, headers: { 'Authorization': 'Bearer ' + LAYERBASE_API_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); try{ return JSON.parse(t); }catch{ return t; }
  }catch(e){ console.log('Layerbase erro:', e.message); return null; }
}
function normalize(list){
  if(!list) return null;
  if(Array.isArray(list)) return list[0] || null;
  if(list.data && Array.isArray(list.data)) return list.data[0] || null;
  if(list.order_id || list.orderId) return list;
  return null;
}
async function getOrderById(orderId){
  const d = await lbRequest(`/orders?order_id=${encodeURIComponent(orderId)}`);
  const n = normalize(d);
  if(n) return { order_id: n.order_id || n.orderId, nome: n.nome || n.name, email: (n.email||'').toLowerCase(), status: n.status, pagbank_id: n.pagbank_id || n.pagbankId };
  return loadLocal()[orderId] || null;
}
async function getOrderByEmail(email){
  const d = await lbRequest(`/orders?email=${encodeURIComponent(email)}`);
  const n = normalize(d);
  if(n) return { order_id: n.order_id || n.orderId, nome: n.nome || n.name, email: (n.email||'').toLowerCase(), status: n.status, pagbank_id: n.pagbank_id || n.pagbankId };
  const local = loadLocal(); for(const id in local){ if(local[id].email === email) return local[id]; } return null;
}
async function saveOrder(order){
  const local = loadLocal(); local[order.order_id] = order; saveLocal(local);
  await lbRequest('/orders', 'POST', { order_id: order.order_id, nome: order.nome, email: order.email, status: order.status, pagbank_id: order.pagbank_id, created_at: order.created_at });
}
async function updateStatus(orderId, status){
  const local = loadLocal(); if(local[orderId]){ local[orderId].status = status; saveLocal(local); }
  await lbRequest(`/orders/${encodeURIComponent(orderId)}`, 'PATCH', { status });
}
function signToken(orderId, email){
  const payload = Buffer.from(JSON.stringify({ orderId, email, exp: Date.now() + 1000*60*60*24*7 })).toString('base64url');
  const sig = crypto.createHmac('sha256', ACCESS_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token){
  try{
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', ACCESS_SECRET).update(payload).digest('base64url');
    if(sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if(data.exp < Date.now()) return null;
    return data;
  }catch{ return null; }
}
app.use(express.static(__dirname));
app.post('/api/checkout', async (req, res) => {
  try{
    const nome = (req.body.nome||'').trim(); const email = (req.body.email||'').trim().toLowerCase();
    if(!nome || !email) return res.status(400).json({ error: 'Nome e e-mail obrigatórios' });
    if(!PAGBANK_TOKEN) return res.status(500).json({ error: 'PAGBANK_TOKEN não configurado no Render' });
    const orderId = 'BJ-' + Date.now() + '-' + Math.random().toString(36).slice(2,8).toUpperCase();
    const body = { reference_id: orderId, customer: { name: nome, email }, items: [{ reference_id: 'mentoria-blackjack', name: 'Mentoria BLACKJACK', quantity: 1, unit_amount: 499 }], payment_methods: [{ type: 'PIX' }, { type: 'CREDIT_CARD' }], redirect_url: PUBLIC_URL + '/retorno.html?order=' + orderId, notification_urls: PUBLIC_URL ? [PUBLIC_URL + '/api/webhook'] : [], expiration_date: new Date(Date.now() + 1000*60*60*2).toISOString() };
    const r = await pagbankRequest('/checkouts', 'POST', body);
    const data = r.data; if(!r.ok) return res.status(r.status).json({ error: 'Erro PagBank', details: data });
    await saveOrder({ order_id: orderId, nome, email, status: 'PENDING', pagbank_id: data.id, created_at: new Date().toISOString() });
    const link = data.links?.find(l => l.rel === 'PAY')?.href || data.links?.[0]?.href;
    return res.json({ orderId, pay_url: link });
  }catch(e){ console.error(e); return res.status(500).json({ error: 'Erro interno' }); }
});
app.post('/api/verificar-acesso', async (req, res) => {
  const nome = (req.body.nome||'').trim().toLowerCase();
  const email = (req.body.email||'').trim().toLowerCase();
  const orderId = req.body.orderId;
  if(!email) return res.json({ paid: false, status: 'NO_EMAIL', message: 'Informe o e-mail usado na compra.' });
  let order = null;
  if(orderId) order = await getOrderById(orderId);
  if(!order) order = await getOrderByEmail(email);
  if(!order) return res.json({ paid: false, status: 'NOT_FOUND', needCheckout: true, message: 'Você ainda não comprou.' });
  if(order.email !== email) return res.json({ paid: false, status: 'EMAIL_MISMATCH', message: 'Esse e-mail não é o mesmo usado na compra.' });
  if(nome && order.nome){
    const primeiro = order.nome.toLowerCase().split(' ')[0];
    if(!nome.includes(primeiro) && !primeiro.includes(nome.split(' ')[0])) return res.json({ paid: false, status: 'NAME_MISMATCH', message: 'Nome não confere com a compra.' });
  }
  try{
    if(order.pagbank_id){
      const r = await pagbankRequest('/checkouts/' + order.pagbank_id, 'GET');
      const d = r.data;
      if(d.status && d.status !== order.status){ order.status = d.status; await updateStatus(order.order_id, d.status); }
    }
  }catch{}
  const isPaid = ['PAID','AUTHORIZED','COMPLETED'].includes(order.status);
  if(!isPaid) return res.json({ paid: false, status: order.status, message: 'Pagamento ainda: ' + order.status + '. Se já pagou, aguarde 10s e tente de novo.' });
  return res.json({ paid: true, status: order.status, orderId: order.order_id, nome: order.nome, email: order.email, token: signToken(order.order_id, order.email) });
});
app.post('/api/webhook', async (req, res) => {
  try{ const charges = req.body.charges; if(charges && charges[0]){ const ref = charges[0].reference_id; if(ref && charges[0].status) await updateStatus(ref, charges[0].status); } res.sendStatus(200); }catch{ res.sendStatus(200); }
});
app.get('/pdf', (req, res) => {
  const data = verifyToken(req.query.token || ''); if(!data) return res.status(403).send('Acesso negado.');
  const file = path.join(__dirname, 'bmentoria.pdf'); if(!fs.existsSync(file)) return res.status(404).send('PDF não encontrado.');
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'inline; filename="bmentoria.pdf"'); res.sendFile(file);
});
app.get('/health', (req,res)=>res.send('ok'));
app.get('*', (req,res)=>res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, ()=>console.log('BLACKJACK rodando na porta '+PORT+' Env:'+PAGBANK_ENV));
