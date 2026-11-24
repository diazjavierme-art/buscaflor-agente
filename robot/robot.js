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


// Pantalla de elegir empresa tras iniciar sesión (rejilla «Buscar empresa...»): elige la de Buscaflor
async function elegirEmpresaSiHaceFalta(page) {
  const r = await page.evaluate((emp) => {
    const hondo = (raiz, sel) => { const out = []; const w = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll(sel).forEach(e => out.push(e)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) w(e.shadowRoot); }); }; w(raiz); return out; };
    const buscar = hondo(document, 'vaadin-text-field, input').find(f => /buscar empresa/i.test(f.placeholder || f.getAttribute('placeholder') || ''));
    const txt = (document.body && document.body.innerText) || '';
    if (!buscar && !/(elegir|elija|seleccione)\s+(la\s+|una\s+)?empresa/i.test(txt)) return 'no';
    const re = new RegExp(emp, 'i');
    const celda = hondo(document, 'vaadin-grid-cell-content').find(c => re.test(c.textContent || ''));
    if (!celda) return 'sinEmpresa';
    const clic = el => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, composed: true })); };
    let hecho = false;
    try {
      const tr = celda.assignedSlot && celda.assignedSlot.parentElement && celda.assignedSlot.parentElement.parentElement;
      if (tr) for (const td of tr.children) { const sl = td.querySelector('slot'); const c = sl && sl.assignedNodes()[0]; if (!c || c === celda) continue; const boton = c.querySelector && (c.querySelector('vaadin-button, button, vaadin-icon, a') || c); if (boton) { clic(boton); hecho = true; break; } }
    } catch (e) {}
    if (!hecho) { clic(celda); celda.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true })); }
    return 'elegida';
  }, CFG.empresa || 'BUSCAFLOR').catch(() => 'no');
  if (r === 'no') return false;
  log(r === 'elegida' ? 'Elegida la empresa de Buscaflor' : 'Pantalla de elegir empresa, pero no encuentro Buscaflor');
  await espera(6000);
  return true;
}

async function sesion() {
  await bajarScript();
  log('Arrancando Chrome' + (VISIBLE ? ' visible' : ' invisible') + ' con el script ' + version);
  const browser = await puppeteer.launch({
    executablePath: CFG.chrome || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: VISIBLE ? false : 'new',
    userDataDir: PERFIL,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check', '--window-size=1400,900'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(c => { if (window.top === window.self) { try { (0, eval)(c); } catch (e) { console.error('[bf-robot] script', e); } } }, codigo);
  page.on('console', m => { const t = m.text(); if (/\[bf-|Error/i.test(t)) log('página:', t.slice(0, 300)); });
  page.on('dialog', d => { log('Diálogo:', d.message().slice(0, 200)); d.dismiss().catch(() => {}); });
  await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => log('goto:', e.message));
  let ultimaRevisionScript = Date.now(), fallos = 0;
  let primera = true;
  while (browser.isConnected()) {
    await espera(primera ? 8000 : 30000); primera = false;
    try {
      if (await elegirEmpresaSiHaceFalta(page)) continue;
      if (await entrarSiHaceFalta(page)) { await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}); continue; }
      const vivo = await page.evaluate(() => !!window.__bfRobot && !/sesión ha caducado|session expired/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')).catch(() => false);
      if (!vivo) { if (++fallos >= 3) { log('La página no responde: recargando'); fallos = 0; await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}); } }
      else fallos = 0;
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
