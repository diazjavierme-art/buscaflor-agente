// ==UserScript==
// @name         Buscaflor - Stock y reparto de AmbarX a la app
// @namespace    buscaflor
// @version      0.9.15
// @description  Cuando en la app de pedidos se pulsa «Actualizar stock de AmbarX», genera en AmbarX el «Informe de stocks» (Formato base, solo stock > 0) y lo sube a Firebase (buscaflor/stockAmbarx). Además sube los albaranes y facturas del día (buscaflor/reparto/<fecha>) para la app de reparto, y pasa a AmbarX las firmas de las entregas y envía el documento firmado al cliente por email desde AmbarX. Una vez al día copia a la app los clientes y artículos de AmbarX (altas, nombres, PVP y familia de las rosas). El último día de cada mes, a partir de las 20:00, factura los albaranes del mes con la «Facturación automática de albaranes» (una factura por cliente).
// @match        *://*/AmbarX/*
// @run-at       document-idle
// @grant        none
// @require      https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @updateURL    https://raw.githubusercontent.com/diazjavierme-art/buscaflor-agente/main/stock-ambarx-buscaflor.user.js
// @downloadURL  https://raw.githubusercontent.com/diazjavierme-art/buscaflor-agente/main/stock-ambarx-buscaflor.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // no correr dentro del marco oculto que usa el propio script

  // ---------------- Configuración ----------------
  const DB = 'https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app';
  const API_KEY = 'AIzaSyD0UwaxdqoAgei-pqr1abceXVj5jTzYw2o'; // clave pública del proyecto Firebase (no es secreta)
  const RUTA_PET = 'buscaflor/peticiones/stock';     // {pedido, por, estado, hecho, registros, total, error}
  const RUTA_AGENTE = 'buscaflor/peticiones/agenteStock'; // {visto, equipo}
  const RUTA_STOCK = 'buscaflor/stockAmbarx';
  const LS_AUTH = 'bf_stock_auth';                  // solo el token de refresco, nunca la contraseña
  const YO = Math.random().toString(36).slice(2);
  const LS_LOCK = 'bf_stock_lock';                  // evita que dos pestañas de AmbarX lo hagan a la vez
  const CADA = 15000;                               // cada cuánto mira si hay peticiones
  const RUTA_PET_REP = 'buscaflor/peticiones/reparto'; // {pedido, fecha, por, estado, hecho, docs, error}
  const RUTA_REP = 'buscaflor/reparto';                // /<YYYY-MM-DD>/docs/<nº>
  const REP_AUTO_MIN = 1;                              // de 6:30 a 15:00 refresca solo cada minuto (antes 10; Javier, 24-11)

  const pad = n => String(n).padStart(2, '0');
  const ahoraISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const espera = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- Sesión de Firebase (REST) ----------------
  let sesion = null; try { sesion = JSON.parse(localStorage.getItem(LS_AUTH) || 'null'); } catch (e) {}
  let idToken = null, idExp = 0, errSesion = '';
  async function token() {
    if (!sesion || !sesion.rt) return null;
    if (idToken && Date.now() < idExp - 60000) return idToken;
    const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(sesion.rt) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { errSesion = (j.error && j.error.message) || ('HTTP ' + r.status); if (r.status === 400) { sesion = null; localStorage.removeItem(LS_AUTH); } return null; }
    errSesion = ''; idToken = j.id_token; idExp = Date.now() + (+j.expires_in || 3600) * 1000;
    if (j.refresh_token && j.refresh_token !== sesion.rt) { sesion.rt = j.refresh_token; localStorage.setItem(LS_AUTH, JSON.stringify(sesion)); }
    return idToken;
  }
  async function entrar(email, pass) {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass, returnSecureToken: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    sesion = { rt: j.refreshToken, email: j.email }; localStorage.setItem(LS_AUTH, JSON.stringify(sesion));
    idToken = j.idToken; idExp = Date.now() + (+j.expiresIn || 3600) * 1000; errSesion = '';
  }
  async function fb(metodo, ruta, datos) {
    const tk = await token(); if (!tk) throw new Error('Sin sesión de Firebase');
    const r = await fetch(`${DB}/${ruta}.json?auth=${encodeURIComponent(tk)}`, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: datos === undefined ? undefined : JSON.stringify(datos) });
    if (!r.ok) throw new Error('Firebase HTTP ' + r.status);
    return r.json();
  }

  // ---------------- Leer el «Informe de stocks» de AmbarX ----------------
  // Trabaja sobre un documento de AmbarX ya abierto en /almacen/informestock/stocks (un marco oculto).
  async function leerStock(doc, log) {
    const todos = sel => { const out = []; const walk = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll(sel).forEach(e => out.push(e)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); }); }; walk(doc); return out; };
    async function hasta(fn, ms, paso) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await espera(paso || 500); } return null; }
    const numES = s => { const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : n; };
    const W = doc.defaultView;

    const sel = await hasta(() => todos('vaadin-select').find(s => s.label === 'Formato'), 30000);
    if (!sel) throw new Error('No se abre el informe de stocks de AmbarX (¿sesión de AmbarX cerrada?)');
    if (sel.value !== '2') { sel.value = '2'; sel.dispatchEvent(new W.CustomEvent('value-changed', { detail: { value: '2' } })); sel.dispatchEvent(new W.Event('change', { bubbles: true })); await espera(800); }
    const quiero = { 'Incluir artículos con stock menor a cero': false, 'Incluir artículos con stock igual a cero': false, 'Incluir artículos con stock mayor que cero': true };
    for (const cb of todos('vaadin-checkbox')) {
      const lab = (cb.label || cb.textContent || '').trim();
      if (lab in quiero && !!cb.checked !== quiero[lab]) { const inp = cb.querySelector('input') || (cb.shadowRoot && cb.shadowRoot.querySelector('input')); (inp || cb).click(); await espera(400); }
    }
    await espera(600);
    const mal = todos('vaadin-checkbox').filter(cb => { const lab = (cb.label || cb.textContent || '').trim(); return lab in quiero && !!cb.checked !== quiero[lab]; });
    if (mal.length || sel.value !== '2') throw new Error('No se han podido poner las opciones del informe (Formato base y solo stock > 0)');

    const antes = new Set(todos('a[href*="dynamic/resource"]').map(a => a.href));
    const gen = todos('vaadin-button').find(b => /Generar informe/i.test(b.textContent));
    if (!gen) throw new Error('No encuentro el botón «Generar informe»');
    gen.click(); log('Generando el informe en AmbarX…');
    const pdf = await hasta(() => { if (todos('*').some(e => e.childElementCount === 0 && /Ha ocurrido un error/i.test(e.textContent || ''))) return 'error'; return todos('a[href*="dynamic/resource"]').find(a => /\.pdf/i.test(a.href) && !antes.has(a.href)); }, 90000, 1000);
    if (!pdf) throw new Error('AmbarX no ha generado el informe en 90 s');
    if (pdf === 'error') throw new Error('AmbarX dice «Ha ocurrido un error» al generar el informe');

    const tt = todos('vaadin-tooltip').find(t => /HTML/i.test(t.text || t.textContent || ''));
    const bHtml = tt && (tt.target || (tt.getAttribute('for') && doc.getElementById(tt.getAttribute('for'))));
    if (!bHtml) throw new Error('No encuentro el botón «Descargar como HTML»');
    const antesH = new Set(todos('a[href*="dynamic/resource"]').map(a => a.href));
    bHtml.click(); log('Leyendo el informe…');
    const html = await hasta(() => todos('a[href*="dynamic/resource"]').find(a => /\.html?/i.test(a.href) && !antesH.has(a.href)), 60000, 1000);
    if (!html) throw new Error('AmbarX no ha dado el informe en HTML');

    const txt = await fetch(html.href, { credentials: 'include' }).then(r => r.text());
    const d = new DOMParser().parseFromString(txt, 'text/html');
    const items = {}; let total = 0;
    d.querySelectorAll('tr').forEach(tr => {
      const tx = [...tr.children].filter(c => c.tagName === 'TD').map(td => td.textContent.replace(/\s+/g, ' ').trim());
      if (tx.length === 6 && /^\d+$/.test(tx[1]) && tx[2] && tx[3] && /^-?[\d.]+(,\d+)?$/.test(tx[3])) {
        const q = numES(tx[3]); if (q == null) return; items[tx[1]] = { d: tx[2], q: q }; total += q;
      }
    });
    const m = txt.replace(/<[^>]+>/g, ' ').match(/Fecha de generaci[oó]n[^0-9]*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/i);
    const g = m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) : new Date();
    const n = Object.keys(items).length;
    if (!n) throw new Error('El informe ha salido vacío');
    return { leido: g.toISOString().replace(/\.\d+Z$/, 'Z'), aFecha: `${g.getFullYear()}-${pad(g.getMonth() + 1)}-${pad(g.getDate())}`,
      origen: 'AmbarX · Informe de stocks · Formato base · solo stock mayor que cero · subido desde AmbarX', registros: n, total: Math.round(total * 100) / 100, items };
  }

  // Abre el informe en un marco oculto (sin tocar la pantalla en la que se está trabajando)
  async function conMarco(fn, ruta) {
    const base = location.pathname.split('/AmbarX/')[0] + '/AmbarX/';
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;left:-3000px;top:0;width:1400px;height:900px;opacity:0;pointer-events:none';
    fr.src = base + (ruta || 'almacen/informestock/stocks');
    document.body.appendChild(fr);
    try {
      await new Promise((ok, ko) => { fr.onload = ok; setTimeout(() => ko(new Error('AmbarX no ha abierto ' + (ruta || 'el informe'))), 45000); });
      await espera(2500);
      return await fn(fr.contentDocument);
    } finally { setTimeout(() => fr.remove(), 1500); }
  }

  // ---------------- Leer albaranes y facturas de venta (para la app de reparto) ----------------
  const hondo = (raiz, sel) => { const out = []; const w = n => { if (!n || !n.querySelectorAll) return; n.querySelectorAll(sel).forEach(e => out.push(e)); n.querySelectorAll('*').forEach(e => { if (e.shadowRoot) w(e.shadowRoot); }); }; w(raiz); return out; };
  async function hastaQue(fn, ms, paso) { const t0 = Date.now(); while (Date.now() - t0 < ms) { let v = null; try { v = fn(); } catch (e) {} if (v) return v; await espera(paso || 500); } return null; }
  const numEs = s => { const n = parseFloat(String(s || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
  const itemsDe = g => ((g && g._dataProviderController && g._dataProviderController.rootCache && g._dataProviderController.rootCache.items) || []).filter(Boolean);

  // Lista de albaranes o facturas: devuelve las cabeceras de la fecha dd/mm/aaaa
  async function leerListado(doc, fechaES) {
    const g = await hastaQue(() => { const x = hondo(doc, 'vaadin-grid')[0]; return x && x.size > 0 && itemsDe(x).length >= Math.min(x.size, 50) ? x : null; }, 40000);
    if (!g) throw new Error('No se abre la lista de documentos de AmbarX');
    const out = [];
    for (const it of itemsDe(g)) {
      const v = Object.entries(it);
      const lab = re => { const e = v.find(([k, x]) => /_label$/.test(k) && re.test(String(x))); return e ? String(e[1]) : ''; };
      const ref = re => { const e = v.find(([k, x]) => /_href$/.test(k) && re.test(String(x))); if (!e) return ''; const pre = e[0].replace(/_href$/, ''); return String(it[pre + '_representacion'] || ''); };
      const num = lab(/^[A-Z]{1,3}-\d+$/), fecha = lab(/^\d{2}\/\d{2}\/\d{4}$/);
      if (!num || fecha !== fechaES) continue;
      const cli = ref(/\/clientes\/editar\//), com = ref(/\/personal\/editar\//);
      const cob = v.find(([k, x]) => /_texto$/.test(k) && /cobrad/i.test(String(x)));
      out.push({ num, comercial: (com.match(/^\d+/) || [''])[0], cliCod: (cli.match(/^\d+/) || [''])[0], cliente: cli.replace(/^\d+\s*\/\s*/, ''),
        total: numEs(lab(/€/)), cobroAmbarx: cob ? String(cob[1]) : '' });
    }
    return out;
  }

  // Un documento abierto: líneas, datos del cliente y origen
  async function leerDocumento(doc) {
    const g = await hastaQue(() => { const x = hondo(doc, 'vaadin-grid')[0]; const t = doc.body && doc.body.innerText || ''; return x && /Datos fiscales/.test(t) && itemsDe(x).length >= (x.size || 0) ? x : null; }, 40000);
    if (!g) throw new Error('No se abre el documento en AmbarX');
    await espera(400);
    const lineas = itemsDe(g).map(it => {
      const l = Object.keys(it).filter(k => /_label$/.test(k)).map(k => String(it[k] || ''));
      return { c: l[0] || '', d: l[1] || '', u: numEs(l[2]), p: numEs(l[3]), dto: numEs(l[l.length - 4]), iva: numEs(l[l.length - 2]), t: numEs(l[l.length - 1]) };
    }).filter(x => x.d || x.c);
    const t = doc.body.innerText;
    const fis = ((t.split('Datos fiscales')[1] || '').split(/R[ée]g\. IVA|Recargo|Agencia transporte/)[0] || '').split('\n').map(x => x.trim()).filter(Boolean);
    const contacto = fis.find(x => /@|\d{9}/.test(x) && !/^[A-Z]?\d{7,8}[A-Z]?$/.test(x)) || '';
    const tel = (contacto.replace(/\s/g, '').match(/(?:\+34)?[6789]\d{8}/g) || []).join(' ');
    const emails = (contacto.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase());
    const poblacion = fis.find(x => /,\s*\d{5}/.test(x)) || '';
    const iPob = fis.indexOf(poblacion);
    const origen = ((t.split(/\nOrigen\n/)[1] || '').split('\n')[0] || '').trim();
    const otraDir = hondo(doc, 'vaadin-checkbox').some(cb => /direcci[oó]n diferente/i.test(cb.label || cb.textContent || '') && cb.checked);
    return { v: 2, lineas, nombreFiscal: fis[0] || '', nif: fis[1] || '', direccion: iPob > 1 ? fis.slice(2, iPob).join(', ') : '', poblacion, tel, emails, origen, otraDireccion: otraDir };
  }

  async function subirReparto(fechaISO, pedidoISO, porPeticion) {
    if (ocupado || !cogerCerrojo()) return;
    ocupado = true; ultimoErr = ''; fase = 'Reparto: empezando…'; pintar();
    const f = fechaISO || ahoraISO().slice(0, 10);
    const fechaES = f.slice(8, 10) + '/' + f.slice(5, 7) + '/' + f.slice(0, 4);
    try {
      if (porPeticion) await fb('PATCH', RUTA_PET_REP, { estado: 'enCurso', empezado: ahoraISO() });
      const previos = (await fb('GET', RUTA_REP + '/' + f + '/docs')) || {};
      const docs = {};
      for (const [tipo, ruta] of [['albaran', 'ventas/albaranes'], ['factura', 'ventas/facturas']]) {
        fase = 'Reparto: lista de ' + (tipo === 'albaran' ? 'albaranes' : 'facturas') + '…'; pintar();
        const lista = await conMarco(doc => leerListado(doc, fechaES), ruta);
        let i = 0;
        for (const h of lista) {
          i++;
          const k = h.num.replace(/[.#$\/\[\]]/g, '-');
          const prev = previos[k];
          let det = prev && prev.v === 2 && prev.total === h.total && prev.lineas ? prev : null;
          if (!det) {
            fase = 'Reparto: ' + tipo + ' ' + h.num + ' (' + i + '/' + lista.length + ')'; pintar();
            try { det = await conMarco(doc => leerDocumento(doc), ruta + '/editar/' + encodeURIComponent(h.num)); }
            catch (e) { det = { error: String(e.message || e) }; }
          }
          docs[k] = Object.assign({}, det, h, { tipo, fecha: f, leido: (prev && det === prev && prev.leido) || ahoraISO() });
        }
      }
      fase = 'Reparto: subiendo…'; pintar();
      await fb('PUT', RUTA_REP + '/' + f + '/docs', docs);
      await fb('PUT', RUTA_REP + '/' + f + '/leido', ahoraISO());
      const n = Object.keys(docs).length;
      if (porPeticion) await fb('PATCH', RUTA_PET_REP, { estado: 'hecho', hecho: ahoraISO(), atendido: pedidoISO, docs: n, error: null });
      ultimo = { hora: ahoraISO(), n, que: 'docs de reparto' };
    } catch (e) {
      ultimoErr = 'Reparto: ' + String(e.message || e);
      if (porPeticion) { try { await fb('PATCH', RUTA_PET_REP, { estado: 'error', error: ultimoErr, atendido: pedidoISO, hecho: ahoraISO() }); } catch (e2) {} }
      console.error('[bf-reparto]', e);
    } finally { ocupado = false; fase = ''; soltarCerrojo(); pintar(); }
  }

  // ---------------- Firmas y emails de las entregas (app de reparto → AmbarX) ----------------
  const boton = (doc, re) => hondo(doc, 'vaadin-button').find(b => re.test((b.textContent || '').trim()) && !b.disabled && b.offsetParent !== null) || hondo(doc, 'vaadin-button').find(b => re.test((b.textContent || '').trim()) && !b.disabled);
  const textoDe = doc => hondo(doc, '*').filter(e => e.childElementCount === 0).map(e => e.textContent || '').join('\n') + '\n' + (doc.body ? doc.body.innerText : '');

  // Abre /AmbarX/movil › Firmar, carga el documento y estampa la firma (la misma pantalla que usa la app de Querry)
  async function firmarEnAmbarx(doc, tipo, num, firma, obs) {
    const W = doc.defaultView;
    const bF = await hastaQue(() => boton(doc, /^Firmar$/), 30000); if (!bF) throw new Error(/\/movil/.test(doc.defaultView.location.pathname) ? 'No se abre el menú móvil de AmbarX' : 'AmbarX no deja abrir su pantalla móvil con este usuario (redirige a ' + doc.defaultView.location.pathname + ')');
    bF.click();
    const cb = await hastaQue(() => { const c = hondo(doc, 'vaadin-combo-box')[0]; return c && (c.filteredItems || []).length ? c : null; }, 20000); if (!cb) throw new Error('No se abre «Firmar documento»');
    const clave = tipo === 'factura' ? '2' : '1';
    if (cb.value !== clave) {
      // Se elige como lo haría una persona (abrir la lista y pulsar), para que el servidor de AmbarX se entere
      cb.opened = true;
      const op = await hastaQue(() => hondo(doc, 'vaadin-combo-box-item').find(x => clave === '2' ? /Factura venta/.test(x.textContent) : /Albar[aá]n venta/.test(x.textContent)), 5000);
      if (op) op.click();
      await espera(800);
    }
    if (!await hastaQue(() => cb.value === clave, 5000)) throw new Error('No se puede elegir el tipo de documento');
    await espera(400);
    const tf = hondo(doc, 'vaadin-text-field')[0]; tf.value = num; tf.dispatchEvent(new W.CustomEvent('change', { bubbles: true })); await espera(600);
    const cargar = async () => { boton(doc, /^Cargar$/).click(); return hastaQue(() => { const t = textoDe(doc); if (/ya est[aá] firmado/i.test(t)) return 'ya'; if (new RegExp('Documento:[^\\n]*' + num.replace('-', '\\-')).test(t) && boton(doc, /^Firmar documento$/)) return 'ok'; if (/no existe|no encontrado|no se ha encontrado/i.test(t)) return 'no'; return null; }, 20000); };
    const r = await cargar();
    if (r === 'ya') return { r: 'yaFirmado', email: 'noConsta' };
    if (r !== 'ok') throw new Error(r === 'no' ? 'AmbarX no encuentra el documento ' + num : 'AmbarX no carga el documento ' + num);
    boton(doc, /^Firmar documento$/).click();
    const sp = await hastaQue(() => { const x = hondo(doc, 'signature-pad')[0]; return x && x._pad && x._canvas && x._canvas.width ? x : null; }, 15000);
    if (!sp) throw new Error('No se abre el recuadro de firma de AmbarX');
    // Encaja la firma en el recuadro de AmbarX sin deformarla
    const img = await new Promise((ok, ko) => { const i = new W.Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('Firma ilegible')); i.src = firma; });
    const cw = sp._canvas.width, ch = sp._canvas.height, k = Math.min(cw / img.width, ch / img.height);
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    await sp._pad.fromDataURL(firma, { ratio: 1, width: w, height: h, xOffset: Math.round((cw - w) / 2), yOffset: Math.round((ch - h) / 2) });
    await espera(400);
    if (sp.estaVacia()) throw new Error('La firma no se ha podido pasar a AmbarX');
    const ta = hondo(doc, 'vaadin-text-area')[0];
    if (ta && obs) { ta.value = obs.slice(0, 250); ta.dispatchEvent(new W.CustomEvent('change', { bubbles: true })); await espera(400); }
    boton(doc, /^Aceptar$/).click();
    await hastaQue(() => !hondo(doc, 'signature-pad').length, 20000);
    // Al aceptar, AmbarX firma y, si el cliente tiene email, se lo manda él mismo
    await hastaQue(() => /firmado correctamente/i.test(textoDe(doc)), 15000);
    const em = await hastaQue(() => { const t = textoDe(doc); if (/Email enviado correctamente/i.test(t)) return 'enviado'; if (/error[^\n]*email|email[^\n]*error|no se ha podido enviar/i.test(t)) return 'error'; return null; }, 12000, 500);
    await espera(1000);
    // Comprobación: al volver a cargarlo, AmbarX debe decir que ya está firmado
    const bc = boton(doc, /^Cargar$/);
    if (bc) { bc.click(); const ok = await hastaQue(() => /ya est[aá] firmado/i.test(textoDe(doc)), 12000); if (!ok) throw new Error('AmbarX no confirma la firma'); }
    return { r: 'firmado', email: em || 'noConsta' };
  }

  // Firmado por la pantalla móvil pero AmbarX no confirma el email (24-11: A-12225 no llegó): el robot lo manda
  // él con «Enviar por email» del documento, que ya lleva la firma. Solo firmas desde EMAIL_REPARO_DESDE, o las
  // marcadas a mano con ambarx.reenviarAmbarx = true. 'yaFirmado' no entra (lo firmó otro y pudo mandarlo).
  const EMAIL_REPARO_DESDE = '2026-11-24T14:40:00';
  const reenvioAmbarx = a => a.firma === 'firmado' && a.firmaAmbarx === 'firmado' && (a.email === 'noConsta' || a.email === 'error') &&
    (String(a.firmaHora || '') >= EMAIL_REPARO_DESDE || a.reenviarAmbarx === true);

  // Abre el documento y lo envía por email con el formato habitual y los correos del cliente
  async function emailDesdeAmbarx(doc, esperados) {
    const env = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:envelope'; }), 40000);
    if (!env) throw new Error('No encuentro «Enviar por email» en el documento');
    await espera(800); env.click();
    const sig = await hastaQue(() => boton(doc, /^Siguiente$/), 20000); if (!sig) throw new Error('No sale la ventana de formato del email');
    await espera(500); sig.click();
    const enviar = await hastaQue(() => /Enviar email/.test(textoDe(doc)) && boton(doc, /^Enviar$/), 30000);
    if (!enviar) throw new Error('No se abre la ventana «Enviar email»');
    await espera(1200);
    const txt = hondo(doc, '*').map(e => e.childElementCount === 0 ? (e.textContent || '') : '').join(' ');
    const vistos = (txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase());
    const para = (esperados || []).map(x => String(x).toLowerCase()).filter(x => vistos.includes(x));
    if (!para.length) { cerrarDialogo(doc); return { email: 'sinEmail', para: [] }; }
    enviar.click();
    const fin = await hastaQue(() => { const t = textoDe(doc); if (/error al enviar|no se ha podido enviar/i.test(t)) return 'error'; return !/Enviar email/.test(t) ? 'ok' : null; }, 60000, 1000);
    if (fin !== 'ok') throw new Error(fin === 'error' ? 'AmbarX da error al enviar el email' : 'AmbarX no confirma el envío del email');
    return { email: 'enviado', para };
  }

  // PDF oficial de AmbarX (formato aBuscaflor Normal, con la firma): Imprimir › Aceptar abre la vista previa con el PDF
  async function pdfOficial(doc) {
    const W = doc.defaultView;
    const imp = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:print'; }), 40000);
    if (!imp) throw new Error('No encuentro «Imprimir» en el documento');
    await espera(800); imp.click();
    const ok = await hastaQue(() => /Desea imprimir/.test(textoDe(doc)) && boton(doc, /^Aceptar$/), 20000);
    if (!ok) throw new Error('No sale la ventana de imprimir');
    // que no lo mande también por email
    hondo(doc, 'vaadin-checkbox').forEach(cb => { if (/Enviar por Email/i.test(cb.label || cb.textContent || '') && cb.checked) { const i = cb.querySelector('input') || (cb.shadowRoot && cb.shadowRoot.querySelector('input')); (i || cb).click(); } });
    await espera(500);
    const antes = new Set(hondo(doc, 'a[href*="dynamic/resource"]').map(a => a.href));
    ok.click();
    const a = await hastaQue(() => hondo(doc, 'a[href*="dynamic/resource"]').find(x => /\.pdf/i.test(x.href) && !antes.has(x.href)), 40000, 800);
    if (!a) throw new Error('AmbarX no ha generado el PDF');
    const buf = await fetch(a.href, { credentials: 'include' }).then(r => r.arrayBuffer());
    let bin = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
    if (!/^%PDF/.test(bin.slice(0, 5))) throw new Error('El PDF de AmbarX ha salido vacío');
    return 'data:application/pdf;base64,' + W.btoa(bin);
  }

  // ---------------- Firma sin AmbarX móvil: PDF oficial + firma en el recuadro «Firma» → adjunto del documento ----------------
  const b64aBytes = d => { const s = atob(String(d).split(',').pop()); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const bytesAb64 = u => { let bin = ''; for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return 'data:application/pdf;base64,' + btoa(bin); };

  // pdf-lib: si el @require no la ha dejado en window (AmbarX puede tener un cargador AMD), se carga con una etiqueta <script>
  async function cargarPdfLib() {
    if (window.PDFLib && window.PDFLib.PDFDocument) return window.PDFLib;
    const amd = window.define;
    try {
      window.define = undefined;
      await new Promise((ok, ko) => {
        const sc = document.createElement('script');
        sc.src = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
        sc.onload = ok; sc.onerror = () => ko(new Error('No se pudo cargar la librería de PDF (sin internet en el servidor)'));
        document.head.appendChild(sc);
      });
    } finally { window.define = amd; }
    if (!window.PDFLib || !window.PDFLib.PDFDocument) throw new Error('Falta la librería de PDF');
    return window.PDFLib;
  }

  // Recuadro «Firma» del formato aBuscaflor (A4, puntos PDF desde abajo): albarán 415-575 × 45-90; factura, bajo la palabra «Firma»
  async function estamparFirma(pdfDataUrl, firma, tipo) {
    const P = await cargarPdfLib();
    const pdf = await P.PDFDocument.load(b64aBytes(pdfDataUrl));
    const img = /image\/png/.test(String(firma).slice(0, 30)) ? await pdf.embedPng(b64aBytes(firma)) : await pdf.embedJpg(b64aBytes(firma));
    const pgs = pdf.getPages(), pg = pgs[pgs.length - 1], H = pg.getSize().height;
    const c = tipo === 'factura' ? { x: 410, y: H - 805, w: 165, h: 48 } : { x: 415, y: H - 797, w: 160, h: 45 };
    const m = 3, k = Math.min((c.w - 2 * m) / img.width, (c.h - 2 * m) / img.height), w = img.width * k, h = img.height * k;
    pg.drawRectangle({ x: c.x + 1, y: c.y + 1, width: c.w - 2, height: c.h - 2, color: P.rgb(1, 1, 1) });
    pg.drawImage(img, { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, width: w, height: h });
    return await pdf.save();
  }

  // Sube un fichero con el vaadin-upload que aparece al abrir una ventana (adjuntos o email)
  async function subirConUpload(doc, up, bytes, nombre) {
    const W = doc.defaultView;
    if (!up) throw new Error('AmbarX no deja subir el fichero');
    const fichero = new W.File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' });
    // Igual que en «Importación de documentos»: meter el fichero en el input del vaadin-upload y lanzar «change»
    const inp = (up.shadowRoot && up.shadowRoot.querySelector('input[type=file]')) || up.querySelector('input[type=file]');
    if (inp) { const dt = new W.DataTransfer(); dt.items.add(fichero); inp.files = dt.files; inp.dispatchEvent(new W.Event('change', { bubbles: true })); }
    await espera(800);
    if (!(up.files || []).some(x => x.name === nombre) && typeof up._addFiles === 'function') up._addFiles([fichero]);
    await espera(500);
    const f0 = (up.files || []).find(x => x.name === nombre);
    if (f0 && !f0.uploading && !f0.complete && typeof up.uploadFiles === 'function') up.uploadFiles(); // la ventana de adjuntos no sube sola (no-auto)
    // AmbarX vacía la lista del vaadin-upload al terminar y deja el texto «<nombre>: 100%»
    const r = await hastaQue(() => { const f = (up.files || []).find(x => x.name === nombre); if (f && (f.complete || f.error)) return f; return textoDe(doc).includes(nombre + ': 100%') ? { complete: true } : null; }, 40000, 500);
    if (!r || !r.complete) {
      const f = (up.files || []).find(x => x.name === nombre);
      const info = f ? ' (estado: ' + [f.status, f.error, f.progress != null ? f.progress + '%' : '', f.held ? 'retenido' : ''].filter(Boolean).join(', ') + '; target: ' + (up.target || '-') + ', noAuto: ' + !!up.noAuto + ', maxSize: ' + up.maxFileSize + ', accept: ' + (up.accept || '-') + ')' : ' (el fichero no entra en la lista: accept=' + (up.accept || '-') + ', maxFiles=' + up.maxFiles + ')';
      throw new Error('No se ha podido subir ' + nombre + info);
    }
  }

  async function adjuntarEnAmbarx(doc, bytes, nombre) {
    const clip = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:paperclip'; }), 40000);
    if (!clip) throw new Error('No encuentro «Adjuntos» en el documento');
    await espera(800);
    const antes = new Set(hondo(doc, 'vaadin-upload'));
    clip.click();
    const up = await hastaQue(() => hondo(doc, 'vaadin-upload').find(u => !antes.has(u)), 15000);
    if (!up) throw new Error('No se abre la ventana de adjuntos');
    await espera(800);
    await subirConUpload(doc, up, bytes, nombre);
    const visto = await hastaQue(() => textoDe(doc).includes(nombre.replace(/\.pdf$/i, '')), 15000);
    if (!visto) throw new Error('El adjunto no aparece en la lista de AmbarX');
    return 'ok';
  }

  // «Enviar por email» del documento, cambiando el PDF sin firmar por el firmado
  // Cierra la ventana «Enviar email» sin enviar (no tiene botón Cancelar, solo la X)
  function cerrarDialogo(doc) { const x = boton(doc, /^Cancelar$|^Cerrar$/); if (x) { x.click(); return; } hondo(doc, 'vaadin-dialog').forEach(d => { if (d.opened) d.opened = false; }); }

  async function emailConPdf(doc, bytes, nombre, esperados) {
    const env = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:envelope'; }), 40000);
    if (!env) throw new Error('No encuentro «Enviar por email» en el documento');
    await espera(800); env.click();
    const sig = await hastaQue(() => boton(doc, /^Siguiente$/), 20000); if (!sig) throw new Error('No sale la ventana de formato del email');
    const antesUp = new Set(hondo(doc, 'vaadin-upload'));
    await espera(500); sig.click();
    const enviar = await hastaQue(() => /Enviar email/.test(textoDe(doc)) && boton(doc, /^Enviar$/), 30000);
    if (!enviar) throw new Error('No se abre la ventana «Enviar email»');
    await espera(1500);
    const txt = hondo(doc, '*').map(e => e.childElementCount === 0 ? (e.textContent || '') : '').join(' ');
    const vistos = (txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase());
    const para = (esperados || []).map(x => String(x).toLowerCase()).filter(x => vistos.includes(x));
    if (!para.length) { cerrarDialogo(doc); return { email: 'sinEmail', para: [] }; }
    const up = hondo(doc, 'vaadin-upload').find(u => !antesUp.has(u)) || hondo(doc, 'vaadin-upload').pop();
    // Quitar el PDF sin firmar que adjunta AmbarX: hay que esperar a que aparezca (tarda unos segundos en generarlo)
    const ajenos = () => (up.files || []).filter(x => x.name !== nombre);
    await hastaQue(() => ajenos().length, 15000, 500);
    for (let i = 0; i < 3 && ajenos().length; i++) {
      for (const fi of hondo(up, 'vaadin-upload-file')) {
        if ((fi.fileName || (fi.file && fi.file.name)) === nombre) continue;
        const rm = fi.shadowRoot && fi.shadowRoot.querySelector('[part="remove-button"]'); if (rm) { rm.click(); await espera(700); }
      }
      if (ajenos().length) { up.files = (up.files || []).filter(x => x.name === nombre); await espera(700); }
    }
    if (ajenos().length) { cerrarDialogo(doc); throw new Error('No se ha podido quitar el PDF sin firmar del email'); }
    await subirConUpload(doc, up, bytes, nombre);
    await espera(800);
    // Comprobación final: solo debe ir el PDF firmado, una vez
    const nombres = (up.files || []).map(x => x.name);
    if (nombres.length !== 1 || nombres[0] !== nombre) { cerrarDialogo(doc); throw new Error('El email no lleva solo el PDF firmado (' + nombres.join(', ') + ')'); }
    enviar.click();
    const fin = await hastaQue(() => { const t = textoDe(doc); if (/error al enviar|no se ha podido enviar/i.test(t)) return 'error'; return !/Enviar email/.test(t) ? 'ok' : null; }, 60000, 1000);
    if (fin !== 'ok') throw new Error(fin === 'error' ? 'AmbarX da error al enviar el email' : 'AmbarX no confirma el envío del email');
    return { email: 'enviado', para };
  }

  // Cobro en AmbarX (botón € del documento › Gestión de cobros): efectivo = EF, tarjeta = TPV (Javier, 24-11-2026)
  const FORMA_AMBARX = { efectivo: 'EF', tarjeta: 'TP' };   // forma de pago en «Gestión de cobros»
  const BANCO_AMBARX = { tarjeta: '51' };                   // tarjeta: banco 51 CAIXA TPV (efectivo deja el banco por defecto)
  async function cobrarEnAmbarx(doc, codigo, importe, banco) {
    const W = doc.defaultView;
    const eur = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:euro'; }), 40000);
    if (!eur) throw new Error('No encuentro «Cobrar» en el documento');
    // Si AmbarX ya lo da por cobrado (p. ej. ventas de contado), no se abre la ventana: no hay nada que hacer
    const yaC = (textoDe(doc) || '').match(/Cobro\s*Cobrado\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*€/);
    if (yaC && numEs(yaC[2]) > 0 && numEs(yaC[1]) >= numEs(yaC[2]) - 0.005) return 'yaCobrado';
    await espera(800); eur.click();
    const caja = await hastaQue(() => { const fc = hondo(doc, 'vaadin-date-picker').find(e => e.label === 'Fecha cobro'); let c = fc; while (c && !(c.innerText || '').includes('Importe a cobrar')) c = c.parentElement; return c; }, 20000);
    if (!caja) throw new Error('No se abre la ventana de cobro');
    await espera(800);
    const estado = () => { const m = (caja.innerText || '').match(/([\d.,]+)\s*\/\s*([\d.,]+)\s*€/); return m ? [numEs(m[1]), numEs(m[2])] : null; };
    const e0 = estado();
    let dlg = caja; while (dlg && !(dlg.innerText || '').includes('Gestión de cobros')) dlg = dlg.parentElement;
    const cancelar = () => { const b = [...(dlg || doc).querySelectorAll('vaadin-button')].find(x => /^Cancelar$/.test(x.textContent.trim())); if (b) b.click(); };
    if (e0 && e0[1] > 0 && e0[0] >= e0[1] - 0.005) { cancelar(); return 'yaCobrado'; }
    const tfs = [...caja.querySelectorAll('vaadin-text-field')];
    if (banco) {
      // El banco solo se resuelve con eventos del input nativo y al perder el foco (probado en AmbarX, 24-11)
      const fb0 = tfs[0], ib = fb0 && (fb0.inputElement || fb0.querySelector('input'));
      if (!ib) { cancelar(); throw new Error('No encuentro «Banco» en la ventana de cobro'); }
      ib.focus(); ib.value = banco;
      ib.dispatchEvent(new W.InputEvent('input', { bubbles: true, composed: true }));
      ib.dispatchEvent(new W.Event('change', { bubbles: true, composed: true }));
      ib.dispatchEvent(new W.FocusEvent('blur')); ib.dispatchEvent(new W.FocusEvent('focusout', { bubbles: true, composed: true }));
      const okB = await hastaQue(() => String(fb0.value || '').indexOf(banco + ' - ') === 0, 8000);
      if (!okB) { cancelar(); throw new Error('AmbarX no reconoce el banco ' + banco + ' (' + fb0.value + ')'); }
      await espera(600);
    }
    const fp = tfs[1];
    if (!fp) { cancelar(); throw new Error('No encuentro «Forma de pago» en la ventana de cobro'); }
    fp.focus(); fp.value = codigo; fp.dispatchEvent(new W.CustomEvent('change', { bubbles: true }));
    const inp = fp.inputElement || fp.querySelector('input'); if (inp) { inp.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); inp.blur(); }
    const okForma = await hastaQue(() => [...caja.querySelectorAll('vaadin-custom-field')].some(x => String(x.value || '').indexOf(codigo + ' - ') === 0), 8000);
    if (!okForma) {
      // Para saber qué enseña AmbarX: valores de los campos de la ventana y textos de listas abiertas
      const vals = [...caja.querySelectorAll('vaadin-custom-field,vaadin-text-field,vaadin-combo-box')].map(x => (x.label || '?') + '=' + String(x.value || '')).join(' | ');
      const pops = hondo(doc, 'vaadin-grid-cell-content,vaadin-combo-box-item,vaadin-item').map(x => (x.textContent || '').trim()).filter(t => /\bT[A-Z]*\b/.test(t)).slice(0, 15).join(' ; ');
      const cf = [...caja.querySelectorAll('vaadin-custom-field')].map(x => (x.label || x.getAttribute('label') || '?') + ':' + [...x.querySelectorAll('vaadin-text-field')].map(t => t.value).join('/')).join(' | ');
      const txt = (dlg || caja).innerText.replace(/\s+/g, ' ').slice(0, 700);
      cancelar(); throw new Error('AmbarX no reconoce la forma de pago ' + codigo + ' · campos: ' + vals.slice(0, 300) + ' · grupos: ' + cf.slice(0, 300) + ' · texto: ' + txt + ' · listas: ' + pops.slice(0, 200));
    }
    const imp = tfs.find(t => t.label === 'Importe contado');
    imp.value = String(importe.toFixed(2)).replace('.', ','); imp.dispatchEvent(new W.CustomEvent('change', { bubbles: true }));
    await espera(1200);
    const e1 = estado();
    if (!e1 || Math.abs(e1[0] - importe) > 0.01) { cancelar(); throw new Error('El importe no ha entrado bien en AmbarX'); }
    const cobrar = [...(dlg || doc).querySelectorAll('vaadin-button')].find(x => /^Cobrar$/.test(x.textContent.trim()));
    if (!cobrar) { cancelar(); throw new Error('No encuentro el botón «Cobrar»'); }
    cobrar.click();
    const fin = await hastaQue(() => !hondo(doc, 'vaadin-date-picker').some(e => e.label === 'Fecha cobro'), 20000);
    if (!fin) throw new Error('AmbarX no ha cerrado la ventana de cobro');
    await espera(1500);
    return 'cobrado';
  }

  const DIAS_ENTREGAS = 3; // hoy y los 2 días anteriores
  async function pasarEntregas() {
    if (ocupado) return;
    // Repasa hoy y los 2 días anteriores (3 días): si el servidor estuvo parado, las entregas firmadas que quedaron
    // sin pasar a AmbarX se terminan al volver. Va día a día (primero hoy); el resto en las vueltas siguientes.
    let f = '', ent = {}, pend = [];
    // Cada paso (firma, cobro, PDF) va por su lado: si uno falla, los demás se hacen igual (3 intentos cada uno)
    const pasos = e => { const a = e.ambarx || {}, c = e.cobro || {}, n = a.n || {};
      return {
        firma: !!e.firma && !a.firma && (n.firma || 0) < 3,
        cobro: !!FORMA_AMBARX[c.forma] && (+c.importe || 0) > 0 && !a.cobro && (n.cobro || 0) < 3,
        email: (a.firma === 'adjunto' && !a.email || reenvioAmbarx(a)) && (n.email || 0) < 3,
        pdf: !a.pdf && (n.pdf || 0) < 3 && (a.firma === 'firmado' || a.firma === 'error' || !e.firma)
      }; };
    const yaPasados = new Set(); // documentos que ya se firmaron en AmbarX desde un día posterior: no se repiten (ni firma ni email)
    for (let atras = 0; atras < DIAS_ENTREGAS; atras++) {
      const d0 = new Date(); d0.setDate(d0.getDate() - atras);
      const fd = ahoraISO(d0).slice(0, 10);
      const en = (await fb('GET', RUTA_REP + '/' + fd + '/entregas')) || {};
      const pe = Object.keys(en).filter(k => { const e = en[k]; if (e.estado !== 'entregado' || yaPasados.has(k)) return false; const p = pasos(e); return p.firma || p.cobro || p.email || p.pdf; });
      if (pe.length) { f = fd; ent = en; pend = pe; break; }
      for (const k of Object.keys(en)) { const a = en[k].ambarx || {}; if (a.firma || a.email) yaPasados.add(k); }
    }
    if (!pend.length || !cogerCerrojo()) return;
    if (!(await cerrojoComun())) { soltarCerrojo(); return; }
    ocupado = true; ultimoErr = ''; pintar();
    try {
      const docs = (await fb('GET', RUTA_REP + '/' + f + '/docs')) || {};
      for (const k of pend) {
        const e = ent[k], d = docs[k] || {}, a = Object.assign({}, e.ambarx || {});
        a.n = Object.assign({}, a.n || {}); a.errores = Object.assign({}, a.errores || {});
        const tipo = e.tipo || d.tipo || 'albaran', num = e.num || d.num || k;
        const ruta = (tipo === 'factura' ? 'ventas/facturas' : 'ventas/albaranes') + '/editar/' + encodeURIComponent(num);
        const paso = async (nombre, fn) => {
          try { await fn(); delete a.errores[nombre]; }
          catch (err) {
            a.n[nombre] = (a.n[nombre] || 0) + 1; a.errores[nombre] = String(err.message || err);
            if (a.n[nombre] >= 3) a[nombre] = 'error';
            console.error('[bf-reparto] ' + num + ' ' + nombre, err);
          }
        };
        let p = pasos(Object.assign({}, e, { ambarx: a }));
        const nombrePdf = (tipo === 'factura' ? 'FV-' : 'AV-') + String(num).replace('-', '') + '_firmado.pdf';
        const correos = (d.emails || []).filter(Boolean);
        if (p.firma) await paso('firma', async () => {
          // Si el buzón ya mandó el email directo (AmbarX falló o el servidor estuvo parado), no se usa la pantalla móvil
          // porque AmbarX mandaría un segundo email: solo se guarda el PDF firmado como adjunto.
          const directo = e.emailDirecto && e.emailDirecto.estado === 'enviado';
          if ((a.n.firma || 0) < 2 && !directo) {
            // Vía principal: la pantalla de firma de AmbarX (deja «Firmado», mete la firma en su PDF y manda el email)
            fase = 'Firmando ' + num + ' en AmbarX…'; pintar();
            const h = String(e.hora || '');
            const obs = 'Entregado ' + h.slice(8, 10) + '/' + h.slice(5, 7) + ' ' + h.slice(11, 16) + (e.por ? ' por ' + e.por : '') + (e.recibe ? ' · Recibe: ' + e.recibe : '') +
              (FORMA_AMBARX[(e.cobro || {}).forma] ? ' · Cobro: ' + e.cobro.forma + ' ' + String((+e.cobro.importe || 0).toFixed(2)).replace('.', ',') + ' €' : '') + (e.nota ? ' · ' + e.nota : '');
            const r = await conMarco(doc => firmarEnAmbarx(doc, tipo, num, e.firma, obs), 'movil');
            a.firma = 'firmado'; a.firmaHora = ahoraISO(); a.firmaAmbarx = r.r;
            if (!correos.length) a.email = 'sinEmail';
            else { a.email = r.email; a.para = correos; }   // 'enviado' · 'error' · 'noConsta' (no se reenvía para no duplicar)
            a.emailHora = ahoraISO();
            return;
          }
          // Último intento: PDF firmado como adjunto (por si la pantalla móvil no está disponible)
          fase = 'Firmando ' + num + ' (adjunto)…'; pintar();
          const oficial = await conMarco(doc => pdfOficial(doc), ruta);
          const firmado = await estamparFirma(oficial, e.firma, tipo);
          await fb('PUT', RUTA_REP + '/' + f + '/pdfs/' + k, bytesAb64(firmado));
          a.pdf = 'ok'; a.pdfHora = ahoraISO();
          // Si el cliente tiene email, NO se adjunta aquí: al subir el PDF en «Enviar por email» AmbarX ya lo guarda
          // como adjunto del documento, y si ya estuviera adjunto lo mete otra vez en el email (salían dos PDF, 23-11)
          if (!correos.length || directo) {
            fase = 'Guardando ' + num + ' firmado en AmbarX…'; pintar();
            await conMarco(doc => adjuntarEnAmbarx(doc, firmado, nombrePdf), ruta);
            a.email = directo ? 'directo' : 'sinEmail'; a.emailHora = ahoraISO();
          }
          a.firma = 'adjunto'; a.firmaHora = ahoraISO(); a.nombrePdf = nombrePdf;
        });
        p = pasos(Object.assign({}, e, { ambarx: a }));
        if (p.cobro) await paso('cobro', async () => {
          const co = e.cobro || {};
          fase = 'Cobro de ' + num + ' en AmbarX…'; pintar();
          a.cobro = await conMarco(doc => cobrarEnAmbarx(doc, FORMA_AMBARX[co.forma], +co.importe, BANCO_AMBARX[co.forma]), ruta);
          a.cobroHora = ahoraISO();
        });
        p = pasos(Object.assign({}, e, { ambarx: a }));
        if (p.email) await paso('email', async () => {
          fase = 'Enviando ' + num + ' firmado por email…'; pintar();
          if (a.firma === 'firmado') {
            if (!correos.length) { a.email = 'sinEmail'; return; }
            const r = await conMarco(doc => emailDesdeAmbarx(doc, correos), ruta);
            a.email = r.email; a.para = r.para; a.emailHora = ahoraISO(); a.emailVia = 'robot'; delete a.reenviarAmbarx;
            return;
          }
          const pdf = await fb('GET', RUTA_REP + '/' + f + '/pdfs/' + k);
          if (!pdf) throw new Error('No encuentro el PDF firmado');
          try {
            const r = await conMarco(doc => emailConPdf(doc, b64aBytes(pdf), nombrePdf, correos), ruta);
            a.email = r.email; a.para = r.para; a.emailHora = ahoraISO();
            if (r.email === 'sinEmail') await conMarco(doc => adjuntarEnAmbarx(doc, b64aBytes(pdf), nombrePdf), ruta);
          } catch (err) {
            // Último intento fallido: que al menos quede el PDF firmado como adjunto del documento
            if ((a.n.email || 0) >= 2) { try { await conMarco(doc => adjuntarEnAmbarx(doc, b64aBytes(pdf), nombrePdf), ruta); } catch (e2) {} }
            throw err;
          }
        });
        p = pasos(Object.assign({}, e, { ambarx: a }));
        if (p.pdf) await paso('pdf', async () => {
          fase = 'PDF de ' + num + '…'; pintar();
          const pdf = await conMarco(doc => pdfOficial(doc), ruta);
          await fb('PUT', RUTA_REP + '/' + f + '/pdfs/' + k, pdf);
          a.pdf = 'ok'; a.pdfHora = ahoraISO();
        });
        a.error = Object.values(a.errores).join(' · ') || null;
        await fb('PUT', RUTA_REP + '/' + f + '/entregas/' + k + '/ambarx', a);
      }
      ultimo = { hora: ahoraISO(), n: pend.length, que: 'entregas a AmbarX' };
    } catch (e) { ultimoErr = 'Entregas: ' + String(e.message || e); }
    finally { ocupado = false; fase = ''; soltarCerrojo(); pintar(); }
  }

  let ultimoAutoRep = 0;

  // ---------------- Hacer la subida ----------------
  let ocupado = false, ultimo = null, ultimoErr = '', fase = '';
  function cogerCerrojo() {
    try { const l = JSON.parse(localStorage.getItem(LS_LOCK) || 'null'); if (l && l.yo !== YO && Date.now() - l.t < 120000) return false; localStorage.setItem(LS_LOCK, JSON.stringify({ t: Date.now(), yo: YO })); return true; } catch (e) { return true; }
  }
  function soltarCerrojo() { try { localStorage.removeItem(LS_LOCK); } catch (e) {} if (tengoComun) { tengoComun = false; fb('PUT', 'buscaflor/peticiones/cerrojoAmbarx', null).catch(() => {}); } }
  // Un solo proceso a la vez aunque haya AmbarX abierto con dos direcciones (cada dirección tiene su propio localStorage)
  let tengoComun = false;
  // Mientras trabaja, renueva los cerrojos cada 30 s; si la pestaña se cierra o recarga, caducan en 2 minutos
  setInterval(() => { if (!ocupado) return; try { localStorage.setItem(LS_LOCK, JSON.stringify({ t: Date.now(), yo: YO })); } catch (e) {} if (tengoComun) fb('PUT', 'buscaflor/peticiones/cerrojoAmbarx', { yo: YO, t: Date.now(), equipo: location.host }).catch(() => {}); }, 30000);
  window.addEventListener('beforeunload', () => { if (ocupado) soltarCerrojo(); });
  async function cerrojoComun() {
    try {
      const l = await fb('GET', 'buscaflor/peticiones/cerrojoAmbarx');
      if (l && l.yo !== YO && Date.now() - (l.t || 0) < 120000) return false;
      await fb('PUT', 'buscaflor/peticiones/cerrojoAmbarx', { yo: YO, t: Date.now(), equipo: location.host });
      await new Promise(r => setTimeout(r, 1500));
      const l2 = await fb('GET', 'buscaflor/peticiones/cerrojoAmbarx');
      tengoComun = !!l2 && l2.yo === YO; return tengoComun;
    } catch (e) { return true; }
  }

  async function subirStock(pedidoISO) {
    if (ocupado || !cogerCerrojo()) return;
    ocupado = true; ultimoErr = ''; fase = 'Empezando…'; pintar();
    try {
      if (pedidoISO) await fb('PATCH', RUTA_PET, { estado: 'enCurso', empezado: ahoraISO() });
      const s = await conMarco(doc => leerStock(doc, t => { fase = t; pintar(); }));
      fase = 'Subiendo a la app…'; pintar();
      await fb('PUT', RUTA_STOCK, s);
      await fb('PATCH', RUTA_PET, { estado: 'hecho', hecho: ahoraISO(), atendido: pedidoISO || ahoraISO(), leido: s.leido, registros: s.registros, total: s.total, error: null });
      ultimo = { hora: ahoraISO(), n: s.registros, total: s.total, que: 'art.' };
    } catch (e) {
      ultimoErr = String(e.message || e);
      try { await fb('PATCH', RUTA_PET, { estado: 'error', error: ultimoErr, atendido: pedidoISO || ahoraISO(), hecho: ahoraISO() }); } catch (e2) {}
      console.error('[bf-stock]', e);
    } finally { ocupado = false; fase = ''; soltarCerrojo(); pintar(); }
  }


  // ---------------- Catálogo diario: clientes y artículos de AmbarX → app ----------------
  // AmbarX manda. Solo añade y actualiza: nunca borra nada en Firebase.
  const RUTA_CAT = 'buscaflor/peticiones/catalogo';   // {hecho, clientes, articulos, error, pedido}
  const CAT_DESDE = 6 * 60 + 10;                      // a partir de las 6:10, una vez al día
  const limpio = t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const sinRaros = t => limpio(t).replace(/[.#$\/\[\]]/g, '-');   // regla fija: sin . # $ / [ ] en variedad y medida
  // Lee una lista de AmbarX (vaadin-grid) entera y devuelve filas {cabecera: texto} + los enlaces de cada fila
  async function leerTabla(doc) {
    const g = await hastaQue(() => { const x = hondo(doc, 'vaadin-grid')[0]; return x && x.size > 0 && itemsDe(x).length >= x.size ? x : null; }, 60000);
    if (!g) throw new Error('No se abre la lista en AmbarX');
    await espera(800);
    const it = itemsDe(g);
    const cols = [...g.querySelectorAll('vaadin-grid-column, vaadin-grid-sort-column')];
    const txtCelda = td => { const sl = td && td.querySelector('slot'); const c = sl && sl.assignedNodes()[0]; return c ? limpio(c.textContent) : ''; };
    const cab = [...g.shadowRoot.querySelectorAll('thead tr:last-child th')].map(th => ({ col: cols.indexOf(th._column), t: txtCelda(th) })).filter(h => h.t);
    const filas = [...g.shadowRoot.querySelectorAll('tbody tr')].filter(tr => it[tr.index]);
    const mapa = {};
    cab.forEach(h => {
      const n = {};
      filas.forEach(tr => { const item = it[tr.index]; const td = [...tr.querySelectorAll('td')].find(d => cols.indexOf(d._column) === h.col); const t = txtCelda(td); if (!t) return;
        Object.keys(item).forEach(k => { if (/_(label|representacion)$/.test(k) && limpio(item[k]) === t) n[k] = (n[k] || 0) + 1; }); });
      const mejor = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; if (mejor) mapa[h.t] = mejor[0];
    });
    return it.map(item => {
      const o = { _href: Object.keys(item).filter(k => /_href$/.test(k)).map(k => String(item[k] || '')) };
      Object.keys(mapa).forEach(h => { o[h] = limpio(item[mapa[h]]); });
      o._fam = (Object.keys(item).find(k => /_href$/.test(k) && /\/familias\/editar\/[^?]/.test(String(item[k])) && !/\/subfamilias/.test(String(item[k]))) || '');
      if (o._fam) o._fam = decodeURIComponent(String(item[o._fam]).split('/editar/')[1].split('?')[0]);
      return o;
    });
  }
  const codigoDe = (f, re) => { const h = f._href.find(x => re.test(x)); return h ? decodeURIComponent(h.split('/editar/')[1].split('?')[0]) : ''; };
  // «FREEDOM 90CM/25T» → variedad FREEDOM, medida 90, 25 tallos
  function trocear(desc) {
    const d = limpio(desc);
    let m = d.match(/^(.*?)\s*(\d+)\s*CM\s*\/\s*(\d+)\s*T/i);
    if (m) return { variedad: sinRaros(m[1]), medida: +m[2], tallosPaquete: +m[3], rosa: true };
    m = d.match(/^(.*?)\s*(\d+)\s*CM\b/i);
    if (m) return { variedad: sinRaros(m[1]), medida: +m[2], tallosPaquete: null, rosa: false };
    return { variedad: sinRaros(d), medida: null, tallosPaquete: null, rosa: false };
  }
  async function subirCatalogo(pedidoISO) {
    if (ocupado || !cogerCerrojo()) return;
    if (!(await cerrojoComun())) { soltarCerrojo(); return; }
    ocupado = true; ultimoErr = ''; pintar();
    try {
      // Clientes
      fase = 'Leyendo clientes de AmbarX…'; pintar();
      const cl = await conMarco(doc => leerTabla(doc), 'clientes');
      const fbCli = (await fb('GET', 'buscaflor/clientes/items')) || {};
      const upd = {}; let nCliNuevos = 0, nCliCambios = 0;
      cl.forEach(f => {
        const c = codigoDe(f, /\/clientes\/editar\//); if (!c || /[.#$\/\[\]]/.test(c)) return;
        const v = { codigo: c, nombre: f['Nombre'] || '', denominacion: f['Denominación'] || '', poblacion: f['Población'] || '' };
        const a = fbCli[c];
        if (!a) { upd['clientes/items/' + c] = v; nCliNuevos++; return; }
        let cambia = false;
        ['nombre', 'denominacion', 'poblacion'].forEach(k => { if (v[k] && limpio(a[k]) !== v[k]) { upd['clientes/items/' + c + '/' + k] = v[k]; cambia = true; } });
        if (cambia) nCliCambios++;
      });
      // Artículos
      fase = 'Leyendo artículos de AmbarX…'; pintar();
      const ar = await conMarco(doc => leerTabla(doc), 'articulos');
      const fbArt = (await fb('GET', 'buscaflor/articulos/items')) || {};
      let nArtNuevos = 0, nArtCambios = 0, nFam = 0;
      ar.forEach(f => {
        const c = codigoDe(f, /\/articulos\/editar\//); if (!c || /[.#$\/\[\]]/.test(c)) return;
        const desc = limpio(f['Descripción']); if (!desc) return;
        const pvp = (() => { const t = f['P.V.P. (Sin I.V.A.)'] || ''; if (!/\d/.test(t)) return null; const n = parseFloat(t.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : Math.round(n * 1000) / 1000; })();
        const tr = trocear(desc);
        const fam = (f._fam || '').split(' / ')[0];
        const a = fbArt[c], base = 'articulos/items/' + c;
        if (!a) {
          const v = { codigo: c, descripcion: desc, variedad: tr.variedad };
          if (tr.medida != null) v.medida = tr.medida; if (tr.tallosPaquete != null) v.tallosPaquete = tr.tallosPaquete; if (pvp != null) v.pvp = pvp;
          if (tr.rosa && fam) v.familia = fam;
          upd[base] = v; nArtNuevos++; return;
        }
        let cambia = false;
        if (limpio(a.descripcion) !== desc) {
          upd[base + '/descripcion'] = desc; upd[base + '/variedad'] = tr.variedad;
          if (tr.medida != null) upd[base + '/medida'] = tr.medida; if (tr.tallosPaquete != null) upd[base + '/tallosPaquete'] = tr.tallosPaquete; cambia = true;
        }
        if (pvp != null && +a.pvp !== pvp) { upd[base + '/pvp'] = pvp; cambia = true; }
        // La familia solo se copia en las rosas (en AmbarX «VERDE» sirve también para los verdes)
        if (tr.rosa && fam && a.familia !== fam) { upd[base + '/familia'] = fam; cambia = true; nFam++; }
        if (cambia) nArtCambios++;
      });
      fase = 'Subiendo a la app…'; pintar();
      const ahora = ahoraISO();
      upd['clientes/actualizado'] = ahora.slice(0, 16); upd['clientes/fuente'] = 'AmbarX - Clientes (copia diaria automática)';
      upd['clientes/total'] = Object.keys(fbCli).length + nCliNuevos;
      upd['articulos/actualizado'] = ahora.slice(0, 16) + ':00'; upd['articulos/fuente'] = 'AmbarX - Archivo de artículos (copia diaria automática)';
      upd['articulos/total'] = Object.keys(fbArt).length + nArtNuevos;
      await fb('PATCH', 'buscaflor', upd);
      const res = { estado: 'hecho', hecho: ahora, atendido: pedidoISO || ahora, error: null,
        clientes: { leidos: cl.length, nuevos: nCliNuevos, cambiados: nCliCambios },
        articulos: { leidos: ar.length, nuevos: nArtNuevos, cambiados: nArtCambios, familias: nFam } };
      await fb('PATCH', RUTA_CAT, res);
      ultimo = { hora: ahora, n: cl.length + ar.length, que: 'clientes y art.' };
    } catch (e) {
      ultimoErr = String(e.message || e);
      try { await fb('PATCH', RUTA_CAT, { estado: 'error', error: ultimoErr, atendido: pedidoISO || ahoraISO() }); } catch (e2) {}
      console.error('[bf-catalogo]', e);
    } finally { ocupado = false; fase = ''; soltarCerrojo(); pintar(); }
  }


  // ---------------- Fin de mes: facturación automática de albaranes ----------------
  // Último día del mes, de 20:00 a 23:50. Una factura por cliente, serie A, banco 20, forma de pago del cliente.
  // Si algo no está como se espera, NO factura y deja el aviso en peticiones/facturacionMes.
  const RUTA_FACT = 'buscaflor/peticiones/facturacionMes';
  const btnTxt = (doc, re) => hondo(doc, 'vaadin-button').filter(x => re.test((x.textContent || '').trim())).pop();
  async function pendientesDelMes(doc) {
    const rango = await hastaQue(() => hondo(doc, 'vaadin-select').find(x => x.label === 'Rangos frecuentes'), 30000);
    if (!rango) throw new Error('No encuentro el filtro de fechas');
    rango.value = '7'; rango.dispatchEvent(new CustomEvent('change', { bubbles: true })); // «Este mes»
    await espera(1500);
    const dps = hondo(doc, 'vaadin-date-picker');
    const desde = (dps.find(d => d.label === 'Desde') || {}).value || '', hasta = (dps.find(d => d.label === 'Hasta') || {}).value || '';
    const hoy = ahoraISO().slice(0, 10);
    if (desde !== hoy.slice(0, 8) + '01' || hasta !== hoy) throw new Error('El filtro de fechas no es este mes (' + desde + ' a ' + hasta + ')');
    const sig = btnTxt(doc, /^Siguiente$/); if (!sig) throw new Error('No encuentro «Siguiente»');
    sig.click();
    const g = await hastaQue(() => { const x = hondo(doc, 'vaadin-grid')[0]; return x && btnTxt(doc, /^Facturar$/) && (x.size === 0 || itemsDe(x).length >= x.size) ? x : null; }, 90000, 1000);
    if (!g) throw new Error('No sale la lista de albaranes a facturar');
    await espera(1500);
    const filas = itemsDe(g).map(it => { const v = Object.entries(it);
      const lab = re => v.filter(([k, y]) => /_label$/.test(k) && re.test(String(y))).map(z => String(z[1]));
      const cli = (v.find(([k, y]) => /_representacion$/.test(k) && / - /.test(String(y))) || [])[1] || '';
      const e = lab(/€/); return { doc: lab(/^[A-Z]-\d+$/)[0] || '', cli: String(cli), total: numEs(e[2]) }; });
    return { g, filas };
  }
  async function facturarMes(doc) {
    const ahora = ahoraISO(), hoy = ahora.slice(0, 10);
    // Ajustes: una factura por cliente y forma de pago del cliente
    const aj = btnTxt(doc, /^Ajustes$/); if (!aj) throw new Error('No encuentro «Ajustes»');
    aj.click(); await espera(1500);
    const radio = hondo(doc, 'vaadin-radio-button').find(x => (x.label || x.textContent || '').trim() === 'Cliente');
    const fp = hondo(doc, 'vaadin-checkbox').find(x => /Tomar forma de pago del cliente/.test(x.label || x.textContent || ''));
    if (!radio || !fp) throw new Error('No encuentro los ajustes de agrupar y forma de pago');
    if (!radio.checked) { radio.click(); await espera(600); }
    if (!fp.checked) { fp.click(); await espera(600); }
    if (!radio.checked || !fp.checked) throw new Error('No se han podido poner los ajustes');
    const ac = btnTxt(doc, /^Aceptar$/); if (ac) ac.click(); await espera(1200);
    const { g, filas } = await pendientesDelMes(doc);
    const total = Math.round(filas.reduce((a, f) => a + f.total, 0) * 100) / 100;
    const clientes = new Set(filas.map(f => f.cli)).size;
    if (!filas.length) return { estado: 'nadaQueFacturar', mes: hoy.slice(0, 7), hecho: ahora, albaranes: 0 };
    // Datos de la factura: serie A, fecha de hoy (último día del mes), banco 20
    const serie = hondo(doc, 'vaadin-select').find(x => x.label === 'Serie');
    const fecha = hondo(doc, 'vaadin-date-picker').find(x => x.label === 'Fecha');
    const banco = hondo(doc, 'vaadin-text-field').map(t => t.value || '').find(v => /^\d+ - /.test(v)) || '';
    const serieTxt = serie ? ((serie.querySelector('vaadin-select-item[selected]') || {}).textContent || (serie.value === '2' ? 'A' : serie.value)) : '';
    if (!serie || String(serieTxt).trim() !== 'A') throw new Error('La serie de factura no es A');
    if (!fecha || fecha.value !== hoy) throw new Error('La fecha de factura no es hoy (' + (fecha && fecha.value) + ')');
    if (!/^20 - /.test(banco)) throw new Error('El banco para efectos no es el 20 (' + banco + ')');
    // Marcar todos
    const sc = g.querySelector('vaadin-grid-flow-selection-column');
    const cab = sc && sc._headerCell && sc._headerCell._content && sc._headerCell._content.querySelector('vaadin-checkbox');
    if (!cab) throw new Error('No encuentro la casilla de marcar todos');
    if (!sc.selectAll) { cab.click(); await espera(2500); }
    const marcados = hondo(g, 'vaadin-checkbox').filter(c => c.checked).length - 1;
    if (marcados < filas.length) throw new Error('Solo se han marcado ' + marcados + ' de ' + filas.length + ' albaranes');
    // Facturar (y confirmar si AmbarX lo pregunta)
    btnTxt(doc, /^Facturar$/).click();
    const t0 = Date.now(); let confirmado = false;
    while (Date.now() - t0 < 240000) {
      await espera(1500);
      const dlg = hondo(doc, 'vaadin-dialog, vaadin-confirm-dialog').find(d => d.opened);
      if (dlg && !confirmado) { const b = hondo(doc, 'vaadin-button').filter(x => /^(Aceptar|Sí|Si|Confirmar|Facturar)$/.test((x.textContent || '').trim()) && x.closest && !x.closest('vaadin-grid')).pop(); if (b) { b.click(); confirmado = true; continue; } }
      const gg = hondo(doc, 'vaadin-grid')[0];
      if (!dlg && (!gg || gg.size === 0 || !btnTxt(doc, /^Facturar$/))) break;
    }
    const aviso = hondo(doc, 'vaadin-notification-card').map(c => limpio(c.innerText || c.textContent)).filter(Boolean).join(' | ');
    return { estado: 'facturado', mes: hoy.slice(0, 7), hecho: ahoraISO(), albaranes: filas.length, clientes, total, aviso: aviso.slice(0, 500) };
  }
  async function hacerFacturacionMes() {
    if (ocupado || !cogerCerrojo()) return;
    if (!(await cerrojoComun())) { soltarCerrojo(); return; }
    ocupado = true; ultimoErr = ''; fase = 'Facturando albaranes del mes…'; pintar();
    const mes = ahoraISO().slice(0, 7);
    try {
      await fb('PATCH', RUTA_FACT, { mes, estado: 'enCurso', empezado: ahoraISO(), error: null });
      const r = await conMarco(doc => facturarMes(doc), 'ventas/facturacion/albaranes-automatica');
      // Comprobación: vuelve a mirar cuántos albaranes del mes quedan sin facturar
      if (r.estado === 'facturado') { fase = 'Comprobando…'; pintar(); await espera(3000);
        try { const c = await conMarco(doc => pendientesDelMes(doc).then(x => x.filas.length), 'ventas/facturacion/albaranes-automatica'); r.pendientesDespues = c; } catch (e) { r.pendientesDespues = 'sin comprobar: ' + (e.message || e); } }
      await fb('PUT', RUTA_FACT, r);
      ultimo = { hora: ahoraISO(), n: r.albaranes, que: 'albaranes facturados' };
      // Para la revisión del día 1: copia las facturas de hoy con sus líneas (duplicados, precios raros, líneas sin cobrar)
      if (r.estado === 'facturado') {
        try {
          const hoy = ahoraISO().slice(0, 10), fechaES = hoy.slice(8, 10) + '/' + hoy.slice(5, 7) + '/' + hoy.slice(0, 4);
          fase = 'Leyendo las facturas para revisarlas…'; pintar();
          const lista = await conMarco(doc => leerListado(doc, fechaES), 'ventas/facturas');
          const facturas = {}; let i = 0;
          for (const h of lista) {
            i++; fase = 'Leyendo factura ' + h.num + ' (' + i + '/' + lista.length + ')'; pintar();
            let det; try { det = await conMarco(doc => leerDocumento(doc), 'ventas/facturas/editar/' + encodeURIComponent(h.num)); } catch (e) { det = { error: String(e.message || e) }; }
            facturas[h.num.replace(/[.#$\/\[\]]/g, '-')] = { num: h.num, cliCod: h.cliCod, cliente: h.cliente, total: h.total, origen: det.origen || '', lineas: det.lineas || [], error: det.error || null };
          }
          await fb('PUT', 'buscaflor/revisionFacturas/' + hoy.slice(0, 7), { leido: ahoraISO(), fecha: hoy, n: lista.length, facturas });
          await fb('PATCH', RUTA_FACT, { facturasLeidas: lista.length });
        } catch (e) { try { await fb('PATCH', RUTA_FACT, { facturasLeidas: 'error: ' + (e.message || e) }); } catch (e2) {} }
      }
    } catch (e) {
      ultimoErr = String(e.message || e);
      try { await fb('PATCH', RUTA_FACT, { mes, estado: 'error', error: ultimoErr, hecho: ahoraISO() }); } catch (e2) {}
      console.error('[bf-facturacion]', e);
    } finally { ocupado = false; fase = ''; soltarCerrojo(); pintar(); }
  }

  // Mira cada 15 s si alguien ha pedido actualizar desde la app
  // ---------------- Sesión de AmbarX: que no caduque y avisar si pide contraseña ----------------
  // La contraseña de AmbarX nunca la escribe el script: si la sesión se pierde, avisa y la pone Javier.
  const BASE_AMBARX = location.pathname.split('/AmbarX/')[0] + '/AmbarX/';
  let estadoAmbarx = 'ok';
  const estaEnLogin = () => /\/login/i.test(location.pathname) || hondo(document, 'vaadin-login-form, vaadin-login-overlay').length > 0;
  async function mantenerAmbarx() {
    if (estaEnLogin()) { estadoAmbarx = 'login'; return; }
    try {
      const r = await fetch(BASE_AMBARX, { credentials: 'include', cache: 'no-store' });
      if ((r.redirected && /login/i.test(r.url)) || r.status === 401 || r.status === 403) { estadoAmbarx = 'caducada'; if (!ocupado) location.href = BASE_AMBARX; }
      else estadoAmbarx = 'ok';
    } catch (e) { estadoAmbarx = 'sinRespuesta'; }
  }
  setInterval(mantenerAmbarx, 4 * 60000);
  setTimeout(mantenerAmbarx, 20000);

  async function vigilar() {
    if (!sesion || ocupado) return;
    try {
      if (estaEnLogin()) estadoAmbarx = 'login';
      await fb('PUT', RUTA_AGENTE, { visto: ahoraISO(), equipo: location.host, ambarx: estadoAmbarx, version: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '' });
      if (estadoAmbarx !== 'ok' && estadoAmbarx !== 'sinRespuesta') return; // sin sesión en AmbarX no se puede hacer nada
      const p = await fb('GET', RUTA_PET);
      if (p && p.pedido && p.estado === 'pedido' && (!p.atendido || p.pedido > p.atendido)) { await subirStock(p.pedido); return; }
      const r = await fb('GET', RUTA_PET_REP);
      if (r && r.pedido && (r.estado === 'pedido' || (r.estado === 'enCurso' && Date.now() - new Date(r.empezado || 0).getTime() > 20 * 60000)) && (!r.atendido || r.pedido > r.atendido)) { ultimoAutoRep = Date.now(); await subirReparto(r.fecha, r.pedido, true); return; }
      await pasarEntregas(); if (ocupado) return;
      { const d = new Date(), manana = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), mF = d.getHours() * 60 + d.getMinutes();
        if (manana.getDate() === 1 && mF >= 20 * 60 && mF <= 23 * 60 + 50) {
          const pf = await fb('GET', RUTA_FACT); const mes = ahoraISO().slice(0, 7);
          if (!pf || pf.mes !== mes) { await hacerFacturacionMes(); return; }
        } }
      const pc = await fb('GET', RUTA_CAT);
      const hoyC = ahoraISO().slice(0, 10), mC = new Date().getHours() * 60 + new Date().getMinutes();
      if (pc && pc.pedido && pc.estado === 'pedido' && (!pc.atendido || pc.pedido > pc.atendido)) { await subirCatalogo(pc.pedido); return; }
      if (mC >= CAT_DESDE && (!pc || !pc.hecho || String(pc.hecho).slice(0, 10) < hoyC) && !(pc && pc.estado === 'error' && String(pc.atendido || '').slice(0, 10) === hoyC && Date.now() - new Date(pc.atendido).getTime() < 3600000)) { await subirCatalogo(null); return; }
      const h = new Date(), min = h.getHours() * 60 + h.getMinutes(), hoyR = ahoraISO().slice(0, 10);
      // Ventas del día: repaso de noche (20:00) para coger lo hecho por la tarde, y repaso del día anterior a primera hora (6:15)
      if (h.getDay() !== 0 && min >= 20 * 60 && localStorage.getItem('bf_rep_noche') !== hoyR) { localStorage.setItem('bf_rep_noche', hoyR); await subirReparto(hoyR, null, false); return; }
      if (h.getDay() !== 0 && min >= 375 && localStorage.getItem('bf_rep_ayer') !== hoyR) {
        localStorage.setItem('bf_rep_ayer', hoyR);
        const a = new Date(h.getFullYear(), h.getMonth(), h.getDate() - (h.getDay() === 1 ? 2 : 1), 12);
        await subirReparto(a.getFullYear() + '-' + String(a.getMonth() + 1).padStart(2, '0') + '-' + String(a.getDate()).padStart(2, '0'), null, false); return; }
      if (h.getDay() !== 0 && min >= 390 && min <= 900 && Date.now() - ultimoAutoRep > REP_AUTO_MIN * 60000) { ultimoAutoRep = Date.now(); await subirReparto(null, null, false); }
    } catch (e) { errSesion = String(e.message || e); pintar(); }
  }
  setInterval(vigilar, CADA);
  setTimeout(vigilar, 3000);

  // ---------------- Indicador y menú en la página de AmbarX ----------------
  let badge;
  function pintar() {
    if (!document.body) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;font:12px/1.3 Arial,sans-serif;padding:5px 9px;border-radius:4px;color:#fff;opacity:.9;cursor:pointer;max-width:420px';
      badge.title = 'Stock y reparto de AmbarX → app (pulsa para opciones)';
      badge.onclick = menu;
      document.body.appendChild(badge);
    }
    badge.style.background = !sesion ? '#e67e22' : (ultimoErr ? '#c0392b' : (ocupado ? '#1f3a5f' : '#2e7d32'));
    badge.textContent = 'AmbarX → app: ' + (!sesion ? 'SIN SESIÓN (pulsa aquí)' : ocupado ? (fase || 'trabajando…') :
      ultimoErr ? 'ERROR · ' + ultimoErr : ultimo ? 'subido ' + ultimo.hora.slice(11, 16) + ' (' + ultimo.n + ' ' + (ultimo.que || 'art.') + ')' : 'esperando peticiones') + (errSesion && sesion ? ' · ' + errSesion : '');
  }
  function menu() {
    if (document.getElementById('bf-stock-menu')) return;
    const f = document.createElement('div'); f.id = 'bf-stock-menu';
    f.style.cssText = 'position:fixed;right:8px;bottom:40px;z-index:100000;background:#fff;color:#222;border:1px solid #999;border-radius:6px;padding:10px;font:13px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);width:260px';
    f.innerHTML = '<b>Stock de AmbarX → app de pedidos</b><br><br>' + (sesion
      ? '<div style="margin-bottom:8px">Sesión: ' + (sesion.email || '') + '</div><button id="bf-ya">Subir el stock ahora</button> <button id="bf-rep">Subir reparto de hoy</button><br><br><button id="bf-cat">Copiar clientes y artículos</button><br><br><button id="bf-out">Salir</button> <button id="bf-no">Cerrar</button>'
      : '<input id="bf-em" type="email" placeholder="email" style="width:100%;box-sizing:border-box;margin-bottom:6px"><input id="bf-pw" type="password" placeholder="contraseña" style="width:100%;box-sizing:border-box;margin-bottom:6px"><div id="bf-msg" style="color:#c0392b;min-height:16px"></div><button id="bf-ok">Entrar</button> <button id="bf-no">Cerrar</button>');
    document.body.appendChild(f);
    f.querySelector('#bf-no').onclick = () => f.remove();
    if (sesion) {
      f.querySelector('#bf-ya').onclick = () => { f.remove(); subirStock(null); };
      f.querySelector('#bf-cat').onclick = () => { f.remove(); subirCatalogo(null); };
      f.querySelector('#bf-rep').onclick = () => { f.remove(); ultimoAutoRep = Date.now(); subirReparto(null, null, false); };
      f.querySelector('#bf-out').onclick = () => { sesion = null; idToken = null; localStorage.removeItem(LS_AUTH); f.remove(); pintar(); };
    } else {
      f.querySelector('#bf-em').focus();
      f.querySelector('#bf-ok').onclick = async () => {
        const msg = f.querySelector('#bf-msg'); msg.textContent = 'Entrando…';
        try { await entrar(f.querySelector('#bf-em').value.trim(), f.querySelector('#bf-pw').value); f.remove(); vigilar(); }
        catch (e) { msg.textContent = /INVALID|PASSWORD|EMAIL/.test(e.message) ? 'Email o contraseña incorrectos' : 'Error: ' + e.message; }
        pintar();
      };
    }
  }
  pintar();
})();
