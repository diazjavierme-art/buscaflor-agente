// Buscaflor - Robot de AmbarX
// Abre AmbarX en un Chrome invisible con su propio perfil y le carga el script de siempre
// (stock-ambarx-buscaflor.user.js, descargado de GitHub). Si AmbarX cierra la sesión, vuelve a entrar
// con el usuario del robot (config.json). Si Chrome se cuelga, lo reinicia. No necesita que nadie abra Chrome.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const VISIBLE = process.argv.includes('--visible') || CFG.visible === true;
const URL_AMBARX = (CFG.ambarxUrl || 'http://localhost:9070/AmbarX/').replace(/\/?$/, '/');
const URL_SCRIPT = 'https://raw.githubusercontent.com/diazjavierme-art/buscaflor-agente/main/stock-ambarx-buscaflor.user.js';
const URL_PDFLIB = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const PERFIL = CFG.perfil || path.join(DIR, 'perfil');
const LOG = path.join(DIR, 'robot.log');
const espera = ms => new Promise(r => setTimeout(r, ms));

function log(...a) {
  const l = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + a.join(' ');
  console.log(l);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, l + '\r\n');
  } catch (e) {}
}

let codigo = '', version = '';
async function bajarScript() {
  try {
    const [s, p] = await Promise.all([fetch(URL_SCRIPT + '?t=' + Date.now()).then(r => { if (!r.ok) throw new Error('script HTTP ' + r.status); return r.text(); }),
                                      fetch(URL_PDFLIB).then(r => { if (!r.ok) throw new Error('pdf-lib HTTP ' + r.status); return r.text(); })]);
    const v = (s.match(/@version\s+([\d.]+)/) || [])[1] || '?';
    const envuelto = p + '\n;(function(){ var arrancar = function(){ if (window.__bfRobot) return; window.__bfRobot = 1;\n' + s +
      '\n}; if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(arrancar, 1500); else document.addEventListener("DOMContentLoaded", function(){ setTimeout(arrancar, 1500); }); })();';
    try { fs.writeFileSync(path.join(DIR, 'script-cache.js'), envuelto); } catch (e) {}
    const cambio = v !== version; codigo = envuelto; version = v; return cambio;
  } catch (e) {
    log('No se pudo descargar el script:', e.message);
    if (!codigo && fs.existsSync(path.join(DIR, 'script-cache.js'))) { codigo = fs.readFileSync(path.join(DIR, 'script-cache.js'), 'utf8'); version = 'cache'; }
    return false;
  }
}

async function entrarSiHaceFalta(page) {
  const enLogin = await page.evaluate(() => {
    const hondo = (raiz, sel) => { const out = []; const w = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll(sel).forEach(e => out.push(e)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) w(e.shadowRoot); }); }; w(raiz); return out; };
    return /\/login/i.test(location.pathname) || hondo(document, 'vaadin-login-form, vaadin-login-overlay').length > 0;
  }).catch(() => false);
  if (!enLogin) return false;
  if (!CFG.usuario || !CFG.clave) { log('AmbarX pide iniciar sesión y no hay usuario en config.json'); return true; }
  log('AmbarX pide iniciar sesión: entrando con el usuario del robot');
  const ok = await page.evaluate((u, c) => {
    const hondo = (raiz, sel) => { const out = []; const w = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll(sel).forEach(e => out.push(e)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) w(e.shadowRoot); }); }; w(raiz); return out; };
    const vis = e => e && e.getBoundingClientRect().width > 0;
    const us = hondo(document, 'vaadin-text-field[name="username"], input[name="username"], input[autocomplete="username"]')[0]
      || hondo(document, 'vaadin-text-field, vaadin-email-field').find(f => vis(f) && /usuario|correo|user/i.test(f.label || f.getAttribute('aria-label') || ''))
      || hondo(document, 'input[type="text"], input[type="email"]').find(vis);
    const pw = hondo(document, 'vaadin-password-field, input[name="password"], input[type="password"]').find(vis);
    if (!us || !pw) return false;
    for (const [el, v] of [[us, u], [pw, c]]) { el.focus && el.focus(); el.value = v; const inp = el.inputElement || (el.querySelector && el.querySelector('input')); if (inp && inp !== el) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    const btn = hondo(document, 'vaadin-button[theme~="submit"], vaadin-button[part="submit"], button[type="submit"]')[0]
      || hondo(document, 'vaadin-button, button').find(b => /iniciar sesi[oó]n|entrar|acceder/i.test((b.textContent || '').trim()));
    const form = hondo(document, 'vaadin-login-form')[0];
    setTimeout(() => { if (btn) btn.click(); else if (form && form.submit) form.submit(); }, 500);
    return true;
  }, CFG.usuario, CFG.clave).catch(() => false);
  if (!ok) { log('No encuentro los campos de usuario y contraseña de AmbarX'); return true; }
  await espera(6000);
  return true;
}


// Pantalla de elegir empresa tras iniciar sesión: busca el texto BUSCAFLOR en cualquier elemento visible y lo pulsa con el ratón
async function buscarEmpresa(page) {
  return page.evaluate((emp) => {
    const re = new RegExp(emp, 'i');
    const htmlTodo = []; const w0 = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll('input').forEach(e => htmlTodo.push(e)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) w0(e.shadowRoot); }); }; w0(document);
    const enElegir = htmlTodo.some(i => /buscar empresa/i.test(i.placeholder || '') && i.getBoundingClientRect().width > 0);
    if (!enElegir) return null;
    const todos = []; const w = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll('*').forEach(e => { todos.push(e); if (e.shadowRoot) w(e.shadowRoot); }); }; w(document);
    let mejor = null, area = 1e12;
    for (const e of todos) {
      if (/^(SCRIPT|STYLE|HTML|BODY|TITLE)$/.test(e.tagName)) continue;
      const t = e.textContent || ''; if (!re.test(t) || t.length > 200) continue;
      const r = e.getBoundingClientRect(); if (r.width < 5 || r.height < 5) continue;
      const a = r.width * r.height; if (a < area) { area = a; mejor = { x: r.x + r.width / 2, y: r.y + r.height / 2, izq: r.x, tag: e.tagName, texto: t.trim().slice(0, 60) }; }
    }
    if (!mejor && re.test(document.body ? document.body.innerText : '')) return { invisible: true };
    return mejor;
  }, CFG.empresa || 'BUSCAFLOR').catch(e => ({ error: e.message }));
}
async function elegirEmpresaSiHaceFalta(page, esperar) {
  let pos = null;
  for (let i = 0; i < (esperar ? 10 : 1); i++) { pos = await buscarEmpresa(page); if (pos && pos.x) break; if (esperar) await espera(1500); }
  if (!pos) return false;
  if (!pos.x) { log('Elegir empresa: no puedo pulsarla', JSON.stringify(pos)); return false; }
  log('Pantalla de elegir empresa: pulsando «' + pos.texto + '» (' + pos.tag + ')');
  await page.mouse.click(pos.x, pos.y); await espera(2500);
  let p2 = await buscarEmpresa(page);
  if (p2 && p2.x) { await page.mouse.click(p2.x, p2.y, { clickCount: 2 }); await espera(2500); p2 = await buscarEmpresa(page); }
  if (p2 && p2.x) { await page.mouse.click(Math.max(5, p2.izq - 40), p2.y); await espera(2500); p2 = await buscarEmpresa(page); }
  if (p2 && p2.x) { await page.keyboard.press('Enter').catch(() => {}); await espera(3000); p2 = await buscarEmpresa(page); }
  log(p2 && p2.x ? 'La empresa sigue sin elegirse' : 'Empresa elegida');
  return true;
}

// ---------------- Verdnatura: albaranes confirmados a la app (buscaflor/verdnatura) ----------------
// A las 15:00 (y cuando se pida desde la app en buscaflor/peticiones/verdnatura) lee en shop.verdnatura.es
// la lista de «Pedidos confirmados» y guarda en Firebase cada ticket nuevo con sus líneas. La sesión de
// Verdnatura la inicia Javier una vez en el Chrome del robot (configurar.cmd); el robot nunca escribe contraseñas.
const DB = 'https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app';
const VN_DESDE = '2026-11-25'; // los tickets con entrega anterior ya se grabaron a mano
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const fechaEs = t => { const m = /(\d{1,2}) de ([a-záéíóú]+) de (\d{4})/i.exec(t || ''); return m && MESES[m[2].toLowerCase()] ? m[3] + '-' + String(MESES[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0') : null; };
const num = t => { const v = parseFloat(String(t || '').replace(/[^\d.,-]/g, '').replace(',', '.')); return isNaN(v) ? null : v; };
async function fb(metodo, ruta, datos) {
  const r = await fetch(DB + '/' + ruta + '.json', { method: metodo, headers: { 'Content-Type': 'application/json' }, body: datos === undefined ? undefined : JSON.stringify(datos) });
  if (!r.ok) throw new Error('Firebase ' + r.status);
  return r.json();
}
const ahoraLocal = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
let vnUltimoDia = '', vnOcupado = false;
async function leerVerdnatura(browser, motivo) {
  if (vnOcupado) return; vnOcupado = true;
  const page = await browser.newPage();
  try {
    log('Verdnatura: leyendo pedidos confirmados (' + motivo + ')');
    await page.goto('https://shop.verdnatura.es/#/ecomerce/orders', { waitUntil: 'networkidle2', timeout: 90000 });
    let lista = [];
    for (let i = 0; i < 20 && !lista.length; i++) {
      await espera(1500);
      if (/login|acceder|iniciar sesi/i.test(page.url()) && !/ecomerce/.test(page.url())) break;
      lista = await page.evaluate(() => [...document.querySelectorAll('a[href*="ecomerce/ticket/"]')].map(a => ({ n: (a.getAttribute('href').match(/ticket\/(\d+)/) || [])[1], t: a.innerText })).filter(x => x.n));
    }
    if (!lista.length) {
      const sinSesion = await page.evaluate(() => /contraseña|iniciar sesión|recuérdame/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      log(sinSesion ? 'Verdnatura: pide iniciar sesión (hay que entrar con configurar.cmd)' : 'Verdnatura: no veo la lista de pedidos');
      await fb('PATCH', 'buscaflor/verdnatura/estado', { leido: ahoraLocal(), error: sinSesion ? 'sinSesion' : 'sinLista' });
      return;
    }
    const ya = (await fb('GET', 'buscaflor/verdnatura/tickets', undefined).catch(() => null)) || {};
    let nuevos = 0;
    for (const it of lista) {
      if (ya[it.n]) continue;
      const entregaLista = fechaEs(it.t);
      if (!entregaLista || entregaLista < VN_DESDE) continue;
      await page.goto('https://shop.verdnatura.es/#/ecomerce/ticket/' + it.n, { waitUntil: 'networkidle2', timeout: 90000 });
      let d = null;
      for (let i = 0; i < 15; i++) {
        await espera(1000);
        d = await page.evaluate(() => {
          const m = document.querySelector('main'); if (!m) return null;
          const txt = m.innerText;
          const filas = [...m.querySelectorAll('[data-cy="basketItemRow"]')].map(r => {
            const lab = [...r.querySelectorAll('.q-item__label')];
            const img = r.querySelector('img'); const id = img ? ((img.getAttribute('src') || '').match(/\/(\d+)(?:\?|$)/) || [])[1] : null;
            const cxp = (r.querySelector('.flex.justify-between > div') || {}).innerText || '';
            const imp = (r.querySelector('.flex.justify-between span') || {}).innerText || '';
            return { id, nombre: (lab[0] || {}).innerText || '', detalle: (lab[1] || {}).innerText || '', cxp, imp };
          });
          return { txt, filas };
        }).catch(() => null);
        if (d && d.filas.length && d.txt.includes('#' + it.n)) break;
        d = null;
      }
      if (!d || !d.filas.length) { log('Verdnatura: ticket ' + it.n + ' sin líneas, se reintenta en la próxima lectura'); continue; }
      const lineas = d.filas.map(f => { const m = /([\d.,]+)\s*x\s*([\d.,]+)/.exec(f.cxp) || []; return { idVerdnatura: f.id || '', nombre: f.nombre.trim(), detalle: f.detalle.trim(), cantidad: num(m[1]), precio: num(m[2]), importe: num(f.imp) }; });
      const tot = /Total\s+([\d.,-]+)\s*€/.exec(d.txt), totIva = /Total \+ IVA\s+([\d.,-]+)\s*€/.exec(d.txt);
      const ticket = { numero: it.n, entrega: fechaEs(d.txt) || entregaLista, abono: /abono/i.test(it.t), abonoDe: ((/Abono del:\s*(\d+)/i.exec(it.t) || [])[1]) || '', total: tot ? num(tot[1]) : null, totalIva: totIva ? num(totIva[1]) : null, lineas, leido: ahoraLocal(), estado: 'pendiente' };
      await fb('PUT', 'buscaflor/verdnatura/tickets/' + it.n, ticket);
      nuevos++; log('Verdnatura: ticket ' + it.n + ' (entrega ' + ticket.entrega + ', ' + lineas.length + ' líneas, ' + ticket.total + ' €) guardado');
    }
    await fb('PATCH', 'buscaflor/verdnatura/estado', { leido: ahoraLocal(), error: null, nuevos });
    log('Verdnatura: ' + nuevos + ' ticket(s) nuevo(s)');
  } catch (e) { log('Verdnatura: error', e.message); }
  finally { vnOcupado = false; await page.close().catch(() => {}); }
}
async function vigilarVerdnatura(browser) {
  const h = new Date(), hoy = ahoraLocal().slice(0, 10);
  if (h.getDay() !== 0 && h.getHours() === 15 && vnUltimoDia !== hoy) { vnUltimoDia = hoy; await leerVerdnatura(browser, '15:00'); return; }
  const p = await fb('GET', 'buscaflor/peticiones/verdnatura', undefined).catch(() => null);
  if (p && p.estado === 'pedida') { await fb('PATCH', 'buscaflor/peticiones/verdnatura', { estado: 'enCurso' }).catch(() => {}); await leerVerdnatura(browser, 'pedido desde la app'); await fb('PATCH', 'buscaflor/peticiones/verdnatura', { estado: 'hecha', hecho: ahoraLocal() }).catch(() => {}); }
}

async function sesion() {
  await bajarScript();
  log('Arrancando Chrome' + (VISIBLE ? ' visible' : ' invisible') + ' con el script ' + version);
  const browser = await puppeteer.launch({
    executablePath: CFG.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: VISIBLE ? false : 'new',
    userDataDir: PERFIL,
    defaultViewport: VISIBLE ? null : { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check', '--window-size=1400,900'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(c => { if (window.top === window.self) { try { (0, eval)(c); } catch (e) { console.error('[bf-robot] script', e); } } }, codigo);
  page.on('console', m => { const t = m.text(); if (/\[bf-|Error/i.test(t)) log('página:', t.slice(0, 300)); });
  page.on('dialog', d => { if (d.type() === 'beforeunload') { d.accept().catch(() => {}); return; } log('Diálogo (' + d.type() + '):', d.message().slice(0, 200)); d.dismiss().catch(() => {}); });
  await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => log('goto:', e.message));
  let ultimaRevisionScript = Date.now(), fallos = 0;
  let primera = true;
  while (browser.isConnected()) {
    await espera(primera ? 8000 : 30000); primera = false;
    try {
      if (await elegirEmpresaSiHaceFalta(page)) continue;
      if (await entrarSiHaceFalta(page)) { await elegirEmpresaSiHaceFalta(page, true); continue; }
      const vivo = await page.evaluate(() => !!window.__bfRobot && !/sesión ha caducado|session expired/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')).catch(() => false);
      if (!vivo) { if (++fallos >= 3) { log('La página no responde: recargando'); fallos = 0; await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}); } }
      else fallos = 0;
      if (!VISIBLE) await vigilarVerdnatura(browser).catch(e => log('Verdnatura:', e.message));
      if (Date.now() - ultimaRevisionScript > 30 * 60000) {
        ultimaRevisionScript = Date.now();
        if (await bajarScript()) { log('Hay versión nueva del script (' + version + '): reiniciando'); await browser.close().catch(() => {}); return; }
      }
    } catch (e) { log('Error vigilando:', e.message); }
  }
  log('Chrome se ha cerrado');
}

(async () => {
  log('Robot de Buscaflor iniciado');
  for (;;) {
    try { await sesion(); } catch (e) { log('Error:', e.message); }
    if (VISIBLE) break;
    await espera(15000);
  }
})();
