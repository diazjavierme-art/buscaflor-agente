// ==UserScript==
// @name         Buscaflor - Stock y reparto de AmbarX a la app
// @namespace    buscaflor
// @version      0.6.2
// @description  Cuando en la app de pedidos se pulsa «Actualizar stock de AmbarX», genera en AmbarX el «Informe de stocks» (Formato base, solo stock > 0) y lo sube a Firebase (buscaflor/stockAmbarx). Además sube los albaranes y facturas del día (buscaflor/reparto/<fecha>) para la app de reparto, y pasa a AmbarX las firmas de las entregas y envía el documento firmado al cliente por email desde AmbarX.
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
  const LS_LOCK = 'bf_stock_lock';                  // evita que dos pestañas de AmbarX lo hagan a la vez
  const CADA = 15000;                               // cada cuánto mira si hay peticiones
  const RUTA_PET_REP = 'buscaflor/peticiones/reparto'; // {pedido, fecha, por, estado, hecho, docs, error}
  const RUTA_REP = 'buscaflor/reparto';                // /<YYYY-MM-DD>/docs/<nº>
  const REP_AUTO_MIN = 10;                             // de 6:30 a 15:00 refresca solo cada 10 min

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
      const it = (cb.filteredItems || cb.items || []).find(i => i.key === clave);
      if (it) cb.selectedItem = it;
      await espera(800);
      if (cb.value !== clave) { cb.value = clave; cb.dispatchEvent(new W.CustomEvent('change', { bubbles: true })); }
      if (cb.value !== clave) { cb.opened = true; await espera(800); const op = hondo(doc, 'vaadin-combo-box-item').find(x => /Factura venta|Albar[aá]n venta/.test(x.textContent) && (clave === '2' ? /Factura/.test(x.textContent) : /Albar/.test(x.textContent))); if (op) op.click(); }
    }
    if (!await hastaQue(() => cb.value === clave, 5000)) throw new Error('No se puede elegir el tipo de documento');
    await espera(400);
    const tf = hondo(doc, 'vaadin-text-field')[0]; tf.value = num; tf.dispatchEvent(new W.CustomEvent('change', { bubbles: true })); await espera(600);
    const cargar = async () => { boton(doc, /^Cargar$/).click(); return hastaQue(() => { const t = textoDe(doc); if (/ya est[aá] firmado/i.test(t)) return 'ya'; if (new RegExp('Documento:[^\\n]*' + num.replace('-', '\\-')).test(t) && boton(doc, /^Firmar documento$/)) return 'ok'; if (/no existe|no encontrado|no se ha encontrado/i.test(t)) return 'no'; return null; }, 20000); };
    const r = await cargar();
    if (r === 'ya') return 'yaFirmado';
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
    await espera(1500);
    // Comprobación: al volver a cargarlo, AmbarX debe decir que ya está firmado
    const bc = boton(doc, /^Cargar$/);
    if (bc) { bc.click(); const ok = await hastaQue(() => /ya est[aá] firmado/i.test(textoDe(doc)), 12000); if (!ok) throw new Error('AmbarX no confirma la firma (se volverá a comprobar)'); }
    return 'firmado';
  }

  // Abre el documento y lo envía por email con el formato habitual y los correos del cliente
  async function emailDesdeAmbarx(doc) {
    const env = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:envelope'; }), 40000);
    if (!env) throw new Error('No encuentro «Enviar por email» en el documento');
    await espera(800); env.click();
    const sig = await hastaQue(() => boton(doc, /^Siguiente$/), 20000); if (!sig) throw new Error('No sale la ventana de formato del email');
    await espera(500); sig.click();
    const enviar = await hastaQue(() => /Enviar email/.test(textoDe(doc)) && boton(doc, /^Enviar$/), 30000);
    if (!enviar) throw new Error('No se abre la ventana «Enviar email»');
    await espera(1200);
    const txt = hondo(doc, '*').map(e => e.childElementCount === 0 ? (e.textContent || '') : '').join(' ');
    const para = [...new Set((txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase()).filter(x => !/rosasdebuscaflor/i.test(x)))];
    if (!para.length) { const x = boton(doc, /^Cancelar$|^Cerrar$/); if (x) x.click(); return { email: 'sinEmail', para: [] }; }
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
    if (!up || typeof up._addFiles !== 'function') throw new Error('AmbarX no deja subir el fichero');
    up._addFiles([new W.File([new Uint8Array(bytes)], nombre, { type: 'application/pdf' })]);
    await espera(500);
    const f0 = (up.files || []).find(x => x.name === nombre);
    if (f0 && !f0.uploading && !f0.complete && typeof up.uploadFiles === 'function') up.uploadFiles(); // la ventana de adjuntos no sube sola (no-auto)
    const r = await hastaQue(() => { const f = (up.files || []).find(x => x.name === nombre); return f && (f.complete || f.error) ? f : null; }, 40000, 500);
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
  async function emailConPdf(doc, bytes, nombre) {
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
    const para = [...new Set((txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(x => x.toLowerCase()).filter(x => !/rosasdebuscaflor|diazjavierme/i.test(x)))];
    if (!para.length) return { email: 'sinEmail', para: [] };
    const up = hondo(doc, 'vaadin-upload').find(u => !antesUp.has(u)) || hondo(doc, 'vaadin-upload').pop();
    // quitar el PDF sin firmar que adjunta AmbarX
    for (const fi of hondo(doc, 'vaadin-upload-file')) {
      if (!up.contains(fi) && !(up.shadowRoot && up.shadowRoot.contains(fi))) continue;
      const rm = fi.shadowRoot && fi.shadowRoot.querySelector('[part="remove-button"]'); if (rm) { rm.click(); await espera(600); }
    }
    await subirConUpload(doc, up, bytes, nombre);
    await espera(800);
    enviar.click();
    const fin = await hastaQue(() => { const t = textoDe(doc); if (/error al enviar|no se ha podido enviar/i.test(t)) return 'error'; return !/Enviar email/.test(t) ? 'ok' : null; }, 60000, 1000);
    if (fin !== 'ok') throw new Error(fin === 'error' ? 'AmbarX da error al enviar el email' : 'AmbarX no confirma el envío del email');
    return { email: 'enviado', para };
  }

  // Cobro en AmbarX (botón € del documento › Gestión de cobros): efectivo = EF, tarjeta = TP
  const FORMA_AMBARX = { efectivo: 'EF', tarjeta: 'TP' };
  async function cobrarEnAmbarx(doc, codigo, importe) {
    const W = doc.defaultView;
    const eur = await hastaQue(() => hondo(doc, 'vaadin-button').find(b => { const i = b.querySelector('vaadin-icon'); return i && i.getAttribute('icon') === 'vaadin:euro'; }), 40000);
    if (!eur) throw new Error('No encuentro «Cobrar» en el documento');
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
    const fp = tfs[1];
    if (!fp) { cancelar(); throw new Error('No encuentro «Forma de pago» en la ventana de cobro'); }
    fp.focus(); fp.value = codigo; fp.dispatchEvent(new W.CustomEvent('change', { bubbles: true }));
    const inp = fp.inputElement || fp.querySelector('input'); if (inp) { inp.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); inp.blur(); }
    const okForma = await hastaQue(() => [...caja.querySelectorAll('vaadin-custom-field')].some(x => String(x.value || '').indexOf(codigo + ' - ') === 0), 8000);
    if (!okForma) { cancelar(); throw new Error('AmbarX no reconoce la forma de pago ' + codigo); }
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

  async function pasarEntregas() {
    if (ocupado) return;
    const f = ahoraISO().slice(0, 10);
    const ent = (await fb('GET', RUTA_REP + '/' + f + '/entregas')) || {};
    // Cada paso (firma, cobro, PDF) va por su lado: si uno falla, los demás se hacen igual (3 intentos cada uno)
    const pasos = e => { const a = e.ambarx || {}, c = e.cobro || {}, n = a.n || {};
      return {
        firma: !!e.firma && !a.firma && (n.firma || 0) < 3,
        cobro: !!FORMA_AMBARX[c.forma] && (+c.importe || 0) > 0 && !a.cobro && (n.cobro || 0) < 3,
        email: a.firma === 'adjunto' && !a.email && (n.email || 0) < 3,
        pdf: !a.pdf && (n.pdf || 0) < 3 && (a.firma === 'error' || !e.firma)
      }; };
    const pend = Object.keys(ent).filter(k => { const e = ent[k]; if (e.estado !== 'entregado') return false; const p = pasos(e); return p.firma || p.cobro || p.email || p.pdf; });
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
        if (p.firma) await paso('firma', async () => {
          fase = 'Firmando ' + num + '…'; pintar();
          const oficial = await conMarco(doc => pdfOficial(doc), ruta);
          const firmado = await estamparFirma(oficial, e.firma, tipo);
          await fb('PUT', RUTA_REP + '/' + f + '/pdfs/' + k, bytesAb64(firmado));
          a.pdf = 'ok'; a.pdfHora = ahoraISO();
          fase = 'Guardando ' + num + ' firmado en AmbarX…'; pintar();
          await conMarco(doc => adjuntarEnAmbarx(doc, firmado, nombrePdf), ruta);
          a.firma = 'adjunto'; a.firmaHora = ahoraISO(); a.nombrePdf = nombrePdf;
        });
        p = pasos(Object.assign({}, e, { ambarx: a }));
        if (p.cobro) await paso('cobro', async () => {
          const co = e.cobro || {};
          fase = 'Cobro de ' + num + ' en AmbarX…'; pintar();
          a.cobro = await conMarco(doc => cobrarEnAmbarx(doc, FORMA_AMBARX[co.forma], +co.importe), ruta);
          a.cobroHora = ahoraISO();
        });
        p = pasos(Object.assign({}, e, { ambarx: a }));
        if (p.email) await paso('email', async () => {
          fase = 'Enviando ' + num + ' firmado por email…'; pintar();
          const pdf = await fb('GET', RUTA_REP + '/' + f + '/pdfs/' + k);
          if (!pdf) throw new Error('No encuentro el PDF firmado');
          const r = await conMarco(doc => emailConPdf(doc, b64aBytes(pdf), nombrePdf), ruta);
          a.email = r.email; a.para = r.para; a.emailHora = ahoraISO();
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
    try { const l = JSON.parse(localStorage.getItem(LS_LOCK) || 'null'); if (l && Date.now() - l.t < 900000) return false; localStorage.setItem(LS_LOCK, JSON.stringify({ t: Date.now() })); return true; } catch (e) { return true; }
  }
  function soltarCerrojo() { try { localStorage.removeItem(LS_LOCK); } catch (e) {} if (tengoComun) { tengoComun = false; fb('PUT', 'buscaflor/peticiones/cerrojoAmbarx', null).catch(() => {}); } }
  // Un solo proceso a la vez aunque haya AmbarX abierto con dos direcciones (cada dirección tiene su propio localStorage)
  const YO = Math.random().toString(36).slice(2); let tengoComun = false;
  async function cerrojoComun() {
    try {
      const l = await fb('GET', 'buscaflor/peticiones/cerrojoAmbarx');
      if (l && l.yo !== YO && Date.now() - (l.t || 0) < 900000) return false;
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

  // Mira cada 15 s si alguien ha pedido actualizar desde la app
  async function vigilar() {
    if (!sesion || ocupado) return;
    try {
      await fb('PUT', RUTA_AGENTE, { visto: ahoraISO(), equipo: location.host });
      const p = await fb('GET', RUTA_PET);
      if (p && p.pedido && p.estado === 'pedido' && (!p.atendido || p.pedido > p.atendido)) { await subirStock(p.pedido); return; }
      const r = await fb('GET', RUTA_PET_REP);
      if (r && r.pedido && r.estado === 'pedido' && (!r.atendido || r.pedido > r.atendido)) { ultimoAutoRep = Date.now(); await subirReparto(r.fecha, r.pedido, true); return; }
      await pasarEntregas(); if (ocupado) return;
      const h = new Date(), min = h.getHours() * 60 + h.getMinutes();
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
      ? '<div style="margin-bottom:8px">Sesión: ' + (sesion.email || '') + '</div><button id="bf-ya">Subir el stock ahora</button> <button id="bf-rep">Subir reparto de hoy</button><br><br><button id="bf-out">Salir</button> <button id="bf-no">Cerrar</button>'
      : '<input id="bf-em" type="email" placeholder="email" style="width:100%;box-sizing:border-box;margin-bottom:6px"><input id="bf-pw" type="password" placeholder="contraseña" style="width:100%;box-sizing:border-box;margin-bottom:6px"><div id="bf-msg" style="color:#c0392b;min-height:16px"></div><button id="bf-ok">Entrar</button> <button id="bf-no">Cerrar</button>');
    document.body.appendChild(f);
    f.querySelector('#bf-no').onclick = () => f.remove();
    if (sesion) {
      f.querySelector('#bf-ya').onclick = () => { f.remove(); subirStock(null); };
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
