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
  const r = await fetch(DB + '/' + ruta + '.json', { signal: AbortSignal.timeout(30000), method: metodo, headers: { 'Content-Type': 'application/json' }, body: datos === undefined ? undefined : JSON.stringify(datos) });
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
      await page.goto('about:blank').catch(() => {});
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

// ---------------- Verdnatura: grabar en AmbarX los tickets leídos (AC serie E, plantilla Excel) ----------------
const zlib = require('zlib');
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_T[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(archivos) { // [{nombre, datos(Buffer)}] -> Buffer
  const partes = [], central = []; let off = 0;
  for (const f of archivos) {
    const nom = Buffer.from(f.nombre), comp = zlib.deflateRawSync(f.datos), crc = crc32(f.datos);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(0, 10);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(f.datos.length, 22); h.writeUInt16LE(nom.length, 26); h.writeUInt16LE(0, 28);
    partes.push(h, nom, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(0, 12);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.datos.length, 24); c.writeUInt16LE(nom.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nom); off += 30 + nom.length + comp.length;
  }
  const cd = Buffer.concat(central), fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(off, 16);
  return Buffer.concat([...partes, cd, fin]);
}
const xmlEsc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function xlsx(filas) { // filas: array de arrays; Date -> fecha dd/mm/yyyy; número -> número; resto texto
  const col = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const serie = d => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000;
  const hoja = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    filas.map((f, r) => '<row r="' + (r + 1) + '">' + f.map((v, c) => { const ref = col(c) + (r + 1);
      if (v === null || v === undefined || v === '') return '';
      if (v instanceof Date) return '<c r="' + ref + '" s="1"><v>' + serie(v) + '</v></c>';
      if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"><is><t>' + xmlEsc(v) + '</t></is></c>'; }).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const A = (n, t) => ({ nombre: n, datos: Buffer.from(t) });
  return zip([
    A('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    A('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    A('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Documentos" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    A('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    A('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'),
    A('xl/worksheets/sheet1.xml', hoja),
  ]);
}

const sinAcentos = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const COLORES = { RED: 'ROJO', WHITE: 'BLANCO', PINK: 'ROSA', 'LIGHT PINK': 'ROSA', YELLOW: 'AMARILLO', ORANGE: 'NARANJA', PURPLE: 'MORADO', CARAMEL: 'CARAMELO', BURGUNDY: 'BURGUNDY', FUCHSIA: 'FUCSIA', FUCSIA: 'FUCSIA', 'DARK PINK': 'FUCSIA', BICOLOR: 'BICOLOR', MIX: 'MIXTO', MIXED: 'MIXTO' };
const GENERICOS = [[/^CALA\b/, '868'], [/^LO\b|^LILIUM ORIENTAL/, '352'], [/^HC\b|^HYPERICUM|^HIPERICUM/, '587'], [/^TANACETUM|^MANZANILLA/, '298'], [/^EUCALIPTO/, '903']];
function buscarIgual(nombre, medida, cat) {
  const n = sinAcentos(nombre), porDesc = d => Object.values(cat).find(a => sinAcentos(a.descripcion) === d);
  let m = /^CL (.+?) (FCY|FANCY|SEL|SELECT)\b/.exec(n);
  if (m) { const col = COLORES[m[1]]; if (col) { const f = /^F/.test(m[2]); const a = porDesc(f ? 'CLAVEL FCY ' + col : 'CLAVEL SELECT ' + col) || (f ? porDesc('CLAVEL FANCY ' + col) : porDesc('CLAVEL ' + col + ' SELECT')); if (a) return { codigo: a.codigo, factor: 1, desc: a.descripcion }; } return null; }
  m = /^ALS\b.*\b(FCY|SEL|SUP)\b/.exec(n);
  if (m) return { FCY: { codigo: '367', factor: 10, desc: 'ALSTROEMERIAS 60CM FANCY' }, SEL: { codigo: '245', factor: 10, desc: 'ALSTROEMERIAS SELECT' }, SUP: { codigo: '454', factor: 10, desc: 'ALSTROEMERIAS SUPER SELECT' } }[m[1]];
  m = /^RS (.+?) (SEL|SUP|FCY|PRE|EXT)?\s*$/.exec(n);
  if (m && medida) { const v = m[1].replace(/\s+/g, ''); const a = Object.values(cat).find(x => x.variedad && sinAcentos(x.variedad).replace(/\s+/g, '') === v && Number(x.medida) === Number(medida)); if (a) return { codigo: a.codigo, factor: 25, desc: a.descripcion }; return null; }
  for (const [re, cod] of GENERICOS) if (re.test(n) && cat[cod]) return { codigo: cod, factor: 1, desc: cat[cod].descripcion };
  return null;
}
async function irAmbarx(page, ruta) {
  if (!/\/AmbarX\//.test(page.url())) { await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }); await espera(5000); }
  await page.evaluate(r => { const a = document.createElement('a'); a.href = r; a.setAttribute('router-link', ''); document.body.appendChild(a); a.click(); a.remove(); }, ruta);
  await espera(4000);
}
const HONDO = `const hondo=(r,s)=>{const o=[];const w=n=>{if(!n||!n.querySelectorAll)return;n.querySelectorAll(s).forEach(e=>o.push(e));n.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)w(e.shadowRoot)})};w(r);return o};const vis=e=>e.getBoundingClientRect().width>0;`;
async function crearArticulo(page, codigo, descripcion) {
  await irAmbarx(page, 'articulos/nuevo');
  for (const [lab, val] of [['Código', codigo], ['Descripción', descripcion]]) {
    const ok = await page.evaluate(new Function('lab', HONDO + "const f=hondo(document,'vaadin-text-field').find(x=>x.label===lab&&vis(x)); if(!f) return false; f.inputElement.focus(); f.inputElement.select(); return true;"), lab);
    if (!ok) throw new Error('no encuentro el campo ' + lab + ' en el alta de artículo');
    await page.keyboard.type(String(val)); await page.keyboard.press('Tab'); await espera(600);
  }
  await page.evaluate(new Function(HONDO + "hondo(document,'vaadin-button').find(b=>vis(b)&&(b.querySelector('vaadin-icon')||{}).icon==='vaadin:check').click();"));
  for (let i = 0; i < 15; i++) {
    await espera(1000);
    const t = await page.evaluate(new Function(HONDO + "return hondo(document,'vaadin-notification-card').map(n=>n.innerText).join(' | ');")).catch(() => '');
    if (/creado/i.test(t)) return true;
    if (/error|existe|no se puede/i.test(t)) throw new Error('alta de artículo: ' + t.slice(0, 150));
  }
  throw new Error('el alta del artículo ' + codigo + ' no se confirmó');
}
async function importarPlantilla(page, ruta) {
  await irAmbarx(page, 'utilidades/importacion-documentos');
  const input = await page.evaluateHandle(new Function(HONDO + "return hondo(document,'input[type=file]')[0];"));
  if (!input || !input.asElement()) throw new Error('no encuentro el botón de subir ficheros');
  await input.asElement().uploadFile(ruta);
  await espera(4000);
  await page.evaluate(new Function(HONDO + "const b=hondo(document,'vaadin-button').find(b=>vis(b)&&/^Leer \\d+ documento/.test((b.innerText||'').trim())); if(b) b.click();"));
  const nombre = path.basename(ruta);
  for (let i = 0; i < 40; i++) {
    await espera(1500);
    const t = await page.evaluate(n => (document.body.innerText.split('\n').filter(l => l.startsWith(n + ':') && !/100%$/.test(l)).pop() || ''), nombre).catch(() => '');
    if (/grabado/i.test(t)) return t;
    if (/error|no se ha|rechaz/i.test(t)) throw new Error(t.slice(0, 200));
  }
  throw new Error('AmbarX no confirmó la importación de ' + nombre);
}
async function grabarVerdnatura(browser) {
  const tickets = (await fb('GET', 'buscaflor/verdnatura/tickets').catch(() => null)) || {};
  const pend = Object.values(tickets).filter(t => t.estado === 'pendiente' || (t.estado === 'error' && (t.intentos || 0) < 3)).sort((a, b) => String(a.numero).localeCompare(String(b.numero)));
  if (!pend.length) return;
  const cat = (await fb('GET', 'buscaflor/articulos/items').catch(() => null)) || {};
  const equiv = (await fb('GET', 'buscaflor/verdnatura/equivalencias').catch(() => null)) || {};
  const page = await browser.newPage();
  try {
    for (const t of pend) {
      try {
        const filas = [['DOC', 'TIPO', 'SERIE', 'FECHA', 'CLIENTE', 'PROVEEDOR', 'REFERENCIA', 'FECHA_REFERENCIA', 'ALMACEN', 'OBSERVACIONES', 'ARTICULO', 'DESCRIPCION', 'CANTIDAD', 'PRECIO', 'DTO1', 'DTO2', 'DTO3', 'IVA%', 'LOTE', 'CADUCIDAD']];
        const [y, mo, d] = String(t.entrega).split('-').map(Number); const fecha = new Date(y, mo - 1, d);
        const codigos = [], nuevos = [], usados = [];
        for (const l of t.lineas || []) {
          const medida = ((/(\d+)\s*cm/i.exec(l.detalle || '') || [])[1]) || '';
          const clave = (l.nombre + '|' + medida).replace(/[.#$\/\[\]]/g, '-');
          let e = equiv[clave];
          if (!e) {
            e = buscarIgual(l.nombre, medida, cat);
            if (e) { e = { ...e, origen: 'busqueda' }; usados.push(l.nombre + ' ' + medida + ' → ' + e.codigo + ' ' + e.desc); }
            else {
              const max = Math.max(...Object.keys(cat).filter(c => /^\d+$/.test(c)).map(Number), 0);
              const codigo = String(max + 1), desc = sinAcentos(l.nombre + (medida ? ' ' + medida + 'CM' : '')).replace(/[.#$\/\[\]]/g, '-').slice(0, 60);
              await crearArticulo(page, codigo, desc);
              cat[codigo] = { codigo, descripcion: desc };
              e = { codigo, factor: 1, desc, origen: 'nuevo' }; nuevos.push(codigo + ' ' + desc);
              log('Verdnatura: artículo nuevo ' + codigo + ' ' + desc);
            }
            equiv[clave] = e; await fb('PUT', 'buscaflor/verdnatura/equivalencias/' + encodeURIComponent(clave), e).catch(() => {});
          }
          const f = Number(e.factor) || 1;
          let cant = Math.round((Number(l.cantidad) / f) * 1000) / 1000, precio = Math.round(Number(l.precio) * f * 10000) / 10000;
          if (t.abono && cant > 0) cant = -cant;
          codigos.push(e.codigo);
          filas.push(['VN-' + t.numero, 'AC', 'E', fecha, null, '149', String(t.numero), fecha, null, 'Verdnatura ' + (t.abono ? 'abono ' + t.numero + (t.abonoDe ? ' del ticket ' + t.abonoDe : '') : 'ticket ' + t.numero), String(e.codigo), (l.nombre + ' · ' + (l.detalle || '')).slice(0, 100), cant, precio, null, null, null, 10, null, null]);
        }
        const dirTmp = path.join(DIR, 'tmp'); fs.mkdirSync(dirTmp, { recursive: true });
        const ruta = path.join(dirTmp, 'VN-' + t.numero + '.xlsx'); fs.writeFileSync(ruta, xlsx(filas));
        const res = await importarPlantilla(page, ruta);
        const ac = ((/(AC\s+[A-Z]-\d+)/.exec(res) || [])[1]) || res;
        await fb('PATCH', 'buscaflor/verdnatura/tickets/' + t.numero, { estado: 'grabado', ambarx: ac, grabado: ahoraLocal(), por: 'robot', codigos, error: null });
        if (nuevos.length || usados.length) await fb('POST', 'buscaflor/verdnatura/avisos', { fecha: ahoraLocal(), ticket: t.numero, ambarx: ac, articulosNuevos: nuevos, equivalenciasNuevas: usados, visto: false }).catch(() => {});
        log('Verdnatura: ticket ' + t.numero + ' grabado en AmbarX como ' + ac + (nuevos.length ? ' (artículos nuevos: ' + nuevos.join(', ') + ')' : ''));
      } catch (e) {
        log('Verdnatura: no se pudo grabar el ticket ' + t.numero + ': ' + e.message);
        await fb('PATCH', 'buscaflor/verdnatura/tickets/' + t.numero, { estado: 'error', error: e.message.slice(0, 300), intentos: (t.intentos || 0) + 1 }).catch(() => {});
      }
    }
  } finally { await page.close().catch(() => {}); }
}

// ---------------- Cobros pendientes de clientes (informe de AmbarX, formato detallado por cliente) ----------------
// Cada mañana (7:00, lunes a sábado) y cuando se pide desde la app: informe de todos los clientes -> buscaflor/cobros/resumen (+ PDF).
// Por cliente: buscaflor/cobros/envios/<id> {cliente, para, estado:'pedido'} -> el robot genera el PDF de ese cliente (estado 'pdfListo')
// y el buzón (Apps Script) lo envía por email. buscaflor/cobros/pdf/<cliente> {estado:'pedido'} -> solo genera el PDF para verlo.
async function informeCobros(page, cliente) {
  await irAmbarx(page, 'articulos'); await irAmbarx(page, 'informe/cobrospendientesclientes');
  if (cliente !== undefined && cliente !== null && cliente !== '') {
    const ok = await page.evaluate(new Function(HONDO + "const y=t=>{const e=hondo(document,'label,span').find(e=>vis(e)&&(e.textContent||'').trim()===t); return e?e.getBoundingClientRect().y:null}; const y1=y('Cliente'), y2=y('Comercial'); if(y1===null||y2===null) return 0; window.__bfCf=hondo(document,'vaadin-text-field').filter(f=>vis(f)&&f.getBoundingClientRect().y>y1&&f.getBoundingClientRect().y<y2); return window.__bfCf.length;"));
    if (ok < 2) throw new Error('no encuentro los campos de cliente del informe');
    for (const i of [0, 1]) {
      await page.evaluate(i => { window.__bfCf[i].inputElement.focus(); window.__bfCf[i].inputElement.select(); }, i);
      await page.keyboard.type(String(cliente)); await espera(700);
    }
    await page.evaluate(() => window.__bfCf[1].inputElement.blur()); await espera(1000);
  }
  const src0 = await page.evaluate(new Function(HONDO + "const s=hondo(document,'vaadin-select').find(x=>x.label==='Formato'); if(!s) return 'NOSEL'; s.value='3'; const v=hondo(document,'vcf-pdf-viewer')[0]; return v?v.src||'':'';"));
  if (src0 === 'NOSEL') throw new Error('no encuentro el formato del informe');
  await espera(800);
  await page.evaluate(new Function(HONDO + "hondo(document,'vaadin-button').find(b=>/Generar informe/.test(b.innerText||'')).click();"));
  for (let i = 0; i < 60; i++) {
    await espera(1000);
    const r = await page.evaluate(new Function('src0', HONDO + `const v=hondo(document,'vcf-pdf-viewer')[0];
      if(!v||!v.src||v.src===src0||!v.__viewer||!v.__viewer.pdfDocument) return null;
      return (async()=>{ const doc=v.__viewer.pdfDocument; const pags=[]; for(let p=1;p<=doc.numPages;p++){ const pg=await doc.getPage(p); const tc=await pg.getTextContent(); pags.push(tc.items.map(i=>i.str).filter(s=>s.trim()).join('|')); }
        const b=new Uint8Array(await (await fetch(v.src,{credentials:'include'})).arrayBuffer()); let s=''; for(let i=0;i<b.length;i+=8192) s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));
        return {texto:pags.join('|'), pdf64:btoa(s), bytes:b.length}; })();`), src0).catch(() => null);
    if (r) return r;
  }
  throw new Error('AmbarX no generó el informe de cobros pendientes');
}
function leerCobros(texto) {
  const n = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
  const tk = texto.split('|'), clientes = {}; let cli = null;
  const esDoc = x => /^(Factura|Albarán|Albaran|Pedido|Efecto|Recibo|Abono|Talón|Pagaré|Letra)/.test(x);
  for (let i = 0; i < tk.length; i++) {
    if (tk[i] === 'Cliente:' && tk[i + 1]) { const m = /^(\S+)\s*\/\s*(.+)$/.exec(tk[i + 1].trim()); if (m) { cli = m[1]; clientes[cli] = clientes[cli] || { codigo: cli, nombre: m[2].trim(), docs: [], pendiente: 0, total: 0, pagado: 0, masAntiguo: 0 }; } continue; }
    if (cli && esDoc(tk[i])) {
      const seq = []; let j = i + 1;
      while (j < tk.length && !esDoc(tk[j]) && !/^(TOTALES|Cliente:|AmbarX)/.test(tk[j])) { seq.push(tk[j]); j++; }
      if (seq.length < 4) continue;
      const m = /^(.*?)\s+(\S+)$/.exec(tk[i].trim());
      const d = { tipo: /^Albar/.test(tk[i]) ? 'albaran' : /^Factura/.test(tk[i]) ? 'factura' : (m ? m[1] : tk[i]).toLowerCase(), numero: m ? m[2] : tk[i], fecha: seq[0], total: n(seq[seq.length - 1]), dias: parseInt(seq[seq.length - 2], 10) || 0 };
      if (seq.length === 4) { d.pagado = 0; d.pendiente = n(seq[1]); } else { d.pagado = n(seq[1]); d.pendiente = n(seq[2]); if (/\d+\/\d+\/\d+/.test(seq[3])) d.ultimoCobro = seq[3]; }
      const c = clientes[cli]; c.docs.push(d); c.pendiente += d.pendiente; c.total += d.total; c.pagado += d.pagado; c.masAntiguo = Math.max(c.masAntiguo, d.dias);
    }
  }
  const lista = Object.values(clientes).map(c => ({ ...c, pendiente: Math.round(c.pendiente * 100) / 100, total: Math.round(c.total * 100) / 100, pagado: Math.round(c.pagado * 100) / 100 }));
  const res = { clientes: {}, pendiente: 0, total: 0, documentos: 0 };
  for (const c of lista) { res.clientes[c.codigo.replace(/[.#$\/\[\]]/g, '-')] = c; res.pendiente += c.pendiente; res.total += c.total; res.documentos += c.docs.length; }
  res.pendiente = Math.round(res.pendiente * 100) / 100; res.total = Math.round(res.total * 100) / 100;
  const tot = /PENDIENTE\|([\d.,]+)\s*€/.exec(texto); res.pendienteInforme = tot ? n(tot[1]) : null;
  return res;
}
let cobUltimoDia = '', cobOcupado = false;
async function vigilarCobros(browser) {
  if (cobOcupado) return; cobOcupado = true;
  let page = null;
  try {
    const h = new Date(), hoy = ahoraLocal().slice(0, 10);
    const pet = await fb('GET', 'buscaflor/peticiones/cobros').catch(() => null);
    const general = (h.getDay() !== 0 && h.getHours() === 7 && cobUltimoDia !== hoy) || (pet && pet.estado === 'pedida');
    const envios = (await fb('GET', 'buscaflor/cobros/envios').catch(() => null)) || {};
    const pdfs = (await fb('GET', 'buscaflor/cobros/pdf').catch(() => null)) || {};
    const pendEnv = Object.entries(envios).filter(([, e]) => e && e.estado === 'pedido');
    const pendPdf = Object.entries(pdfs).filter(([, e]) => e && e.estado === 'pedido');
    if (!general && !pendEnv.length && !pendPdf.length) return;
    page = await browser.newPage();
    await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }); await espera(6000);
    if (general) {
      cobUltimoDia = hoy;
      if (pet && pet.estado === 'pedida') await fb('PATCH', 'buscaflor/peticiones/cobros', { estado: 'enCurso' }).catch(() => {});
      try {
        const r = await informeCobros(page, null);
        const res = leerCobros(r.texto);
        await fb('PUT', 'buscaflor/cobros/resumen', { ...res, leido: ahoraLocal() });
        await fb('PUT', 'buscaflor/cobros/pdfGeneral', { fecha: ahoraLocal(), pdf64: r.pdf64, bytes: r.bytes });
        log('Cobros pendientes: ' + Object.keys(res.clientes).length + ' clientes, ' + res.documentos + ' documentos, ' + res.pendiente + ' € pendientes' + (res.pendienteInforme !== null && Math.abs(res.pendienteInforme - res.pendiente) > 0.05 ? ' (OJO: el informe dice ' + res.pendienteInforme + ')' : ''));
        if (pet && pet.estado === 'pedida') await fb('PATCH', 'buscaflor/peticiones/cobros', { estado: 'hecha', hecho: ahoraLocal(), error: null }).catch(() => {});
      } catch (e) { log('Cobros pendientes: error', e.message); if (pet && pet.estado === 'pedida') await fb('PATCH', 'buscaflor/peticiones/cobros', { estado: 'error', error: e.message }).catch(() => {}); }
    }
    for (const [id, e] of pendEnv.concat(pendPdf.map(([c, e]) => ['pdf:' + c, { ...e, cliente: c }]))) {
      const esPdf = id.startsWith('pdf:'), ruta = esPdf ? 'buscaflor/cobros/pdf/' + id.slice(4) : 'buscaflor/cobros/envios/' + id;
      try {
        await fb('PATCH', ruta, { estado: 'generando' });
        const r = await informeCobros(page, e.cliente);
        const res = leerCobros(r.texto);
        const c = Object.values(res.clientes)[0] || null;
        await fb('PATCH', ruta, { estado: esPdf ? 'listo' : 'pdfListo', pdf64: r.pdf64, bytes: r.bytes, generado: ahoraLocal(), pendiente: c ? c.pendiente : 0, documentos: c ? c.docs.length : 0, nombre: c ? c.nombre : (e.nombre || '') });
        log('Cobros pendientes: PDF del cliente ' + e.cliente + (esPdf ? ' para ver' : ' para enviar a ' + (e.para || '?')) + ' (' + (c ? c.pendiente : 0) + ' €)');
      } catch (err) { log('Cobros pendientes: error con el cliente ' + e.cliente + ': ' + err.message); await fb('PATCH', ruta, { estado: 'error', error: err.message }).catch(() => {}); }
    }
  } finally { cobOcupado = false; if (page) await page.close().catch(() => {}); }
}

async function vigilarVerdnatura(browser) {
  const h = new Date(), hoy = ahoraLocal().slice(0, 10);
  if (h.getDay() !== 0 && h.getHours() === 15 && vnUltimoDia !== hoy) { vnUltimoDia = hoy; await leerVerdnatura(browser, '15:00'); await grabarVerdnatura(browser); return; }
  const p = await fb('GET', 'buscaflor/peticiones/verdnatura', undefined).catch(() => null);
  if (p && p.estado === 'pedida') { log('Verdnatura: petición desde la app'); await fb('PATCH', 'buscaflor/peticiones/verdnatura', { estado: 'enCurso' }).catch(() => {}); await leerVerdnatura(browser, 'pedido desde la app'); await grabarVerdnatura(browser); await fb('PATCH', 'buscaflor/peticiones/verdnatura', { estado: 'hecha', hecho: ahoraLocal() }).catch(() => {}); }
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
  NAVEGADOR = browser; ultimaVuelta = Date.now();
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(c => { if (window.top === window.self) { try { (0, eval)(c); } catch (e) { console.error('[bf-robot] script', e); } } }, codigo);
  page.on('console', m => { const t = m.text(); if (/\[bf-|Error/i.test(t)) log('página:', t.slice(0, 300)); });
  page.on('dialog', d => { if (d.type() === 'beforeunload') { d.accept().catch(() => {}); return; } log('Diálogo (' + d.type() + '):', d.message().slice(0, 200)); d.dismiss().catch(() => {}); });
  await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => log('goto:', e.message));
  let ultimaRevisionScript = Date.now(), fallos = 0;
  let primera = true, vueltas = 0;
  while (browser.isConnected()) {
    await espera(primera ? 8000 : 30000); primera = false; ultimaVuelta = Date.now();
    if (++vueltas % 20 === 0) log('Sigo en marcha (' + page.url().slice(0, 80) + ')');
    try {
      await Promise.race([vuelta(), espera(180000).then(() => { throw new Error('una vuelta tarda más de 3 min'); })]);
    } catch (e) { log('Error vigilando:', e.message); if (/3 min/.test(e.message)) await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}); }
    if (reiniciarYa) { log('robot.js ha cambiado: reinicio para coger la versión nueva'); await browser.close().catch(() => {}); process.exit(1); }
  }
  log('Chrome se ha cerrado');
  async function vuelta() {
      if (await elegirEmpresaSiHaceFalta(page)) return;
      if (await entrarSiHaceFalta(page)) { await elegirEmpresaSiHaceFalta(page, true); return; }
      const vivo = await page.evaluate(() => !!window.__bfRobot && !/sesión ha caducado|session expired/i.test(document.body ? document.body.innerText.slice(0, 3000) : '')).catch(() => false);
      if (!vivo) { if (++fallos >= 3) { log('La página no responde: recargando'); fallos = 0; await page.goto(URL_AMBARX, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}); } }
      else fallos = 0;
      if (!VISIBLE) await vigilarVerdnatura(browser).catch(e => log('Verdnatura:', e.message));
      if (!VISIBLE) vigilarCobros(browser).catch(e => log('Cobros:', e.message));
      if (Date.now() - ultimaRevisionScript > 30 * 60000) {
        ultimaRevisionScript = Date.now();
        if (await bajarScript()) { log('Hay versión nueva del script (' + version + '): reiniciando'); await browser.close().catch(() => {}); return; }
      }
  }
}

let reiniciarYa = false, NAVEGADOR = null, ultimaVuelta = Date.now();
function salir(motivo) {
  log(motivo);
  try { const p = NAVEGADOR && NAVEGADOR.process(); if (p) p.kill('SIGKILL'); } catch (e) {}
  setTimeout(() => process.exit(1), 1500);
}
try {
  const m0 = fs.statSync(__filename).mtimeMs;
  setInterval(() => {
    try { if (fs.statSync(__filename).mtimeMs !== m0) { salir('robot.js ha cambiado: reinicio para coger la versión nueva'); return; } } catch (e) {}
    if (!VISIBLE && Date.now() - ultimaVuelta > 6 * 60000) salir('El robot lleva más de 6 minutos parado: reinicio');
  }, 60000);
} catch (e) {}
(async () => {
  log('Robot de Buscaflor iniciado');
  for (;;) {
    try { await sesion(); } catch (e) { log('Error:', e.message); }
    if (VISIBLE) break;
    await espera(15000);
  }
})();
