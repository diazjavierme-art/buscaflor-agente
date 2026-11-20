// ==UserScript==
// @name         Buscaflor - Stock de AmbarX a la app de pedidos
// @namespace    buscaflor
// @version      0.1.0
// @description  Cuando en la app de pedidos se pulsa «Actualizar stock de AmbarX», genera en AmbarX el «Informe de stocks» (Formato base, solo stock > 0) y lo sube a Firebase (buscaflor/stockAmbarx). También se puede lanzar desde la propia página de AmbarX.
// @match        *://*/AmbarX/*
// @run-at       document-idle
// @grant        none
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
  async function conMarco(fn) {
    const base = location.pathname.split('/AmbarX/')[0] + '/AmbarX/';
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;left:-3000px;top:0;width:1400px;height:900px;opacity:0;pointer-events:none';
    fr.src = base + 'almacen/informestock/stocks';
    document.body.appendChild(fr);
    try {
      await new Promise((ok, ko) => { fr.onload = ok; setTimeout(() => ko(new Error('AmbarX no ha abierto el informe')), 45000); });
      await espera(2500);
      return await fn(fr.contentDocument);
    } finally { setTimeout(() => fr.remove(), 1500); }
  }

  // ---------------- Hacer la subida ----------------
  let ocupado = false, ultimo = null, ultimoErr = '', fase = '';
  function cogerCerrojo() {
    try { const l = JSON.parse(localStorage.getItem(LS_LOCK) || 'null'); if (l && Date.now() - l.t < 180000) return false; localStorage.setItem(LS_LOCK, JSON.stringify({ t: Date.now() })); return true; } catch (e) { return true; }
  }
  function soltarCerrojo() { try { localStorage.removeItem(LS_LOCK); } catch (e) {} }

  async function subirStock(pedidoISO) {
    if (ocupado || !cogerCerrojo()) return;
    ocupado = true; ultimoErr = ''; fase = 'Empezando…'; pintar();
    try {
      if (pedidoISO) await fb('PATCH', RUTA_PET, { estado: 'enCurso', empezado: ahoraISO() });
      const s = await conMarco(doc => leerStock(doc, t => { fase = t; pintar(); }));
      fase = 'Subiendo a la app…'; pintar();
      await fb('PUT', RUTA_STOCK, s);
      await fb('PATCH', RUTA_PET, { estado: 'hecho', hecho: ahoraISO(), atendido: pedidoISO || ahoraISO(), leido: s.leido, registros: s.registros, total: s.total, error: null });
      ultimo = { hora: ahoraISO(), n: s.registros, total: s.total };
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
      if (p && p.pedido && p.estado === 'pedido' && (!p.atendido || p.pedido > p.atendido)) await subirStock(p.pedido);
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
      badge.title = 'Stock de AmbarX → app de pedidos (pulsa para opciones)';
      badge.onclick = menu;
      document.body.appendChild(badge);
    }
    badge.style.background = !sesion ? '#e67e22' : (ultimoErr ? '#c0392b' : (ocupado ? '#1f3a5f' : '#2e7d32'));
    badge.textContent = 'Stock → app: ' + (!sesion ? 'SIN SESIÓN (pulsa aquí)' : ocupado ? (fase || 'trabajando…') :
      ultimoErr ? 'ERROR · ' + ultimoErr : ultimo ? 'subido ' + ultimo.hora.slice(11, 16) + ' (' + ultimo.n + ' art.)' : 'esperando peticiones') + (errSesion && sesion ? ' · ' + errSesion : '');
  }
  function menu() {
    if (document.getElementById('bf-stock-menu')) return;
    const f = document.createElement('div'); f.id = 'bf-stock-menu';
    f.style.cssText = 'position:fixed;right:8px;bottom:40px;z-index:100000;background:#fff;color:#222;border:1px solid #999;border-radius:6px;padding:10px;font:13px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);width:260px';
    f.innerHTML = '<b>Stock de AmbarX → app de pedidos</b><br><br>' + (sesion
      ? '<div style="margin-bottom:8px">Sesión: ' + (sesion.email || '') + '</div><button id="bf-ya">Subir el stock ahora</button> <button id="bf-out">Salir</button> <button id="bf-no">Cerrar</button>'
      : '<input id="bf-em" type="email" placeholder="email" style="width:100%;box-sizing:border-box;margin-bottom:6px"><input id="bf-pw" type="password" placeholder="contraseña" style="width:100%;box-sizing:border-box;margin-bottom:6px"><div id="bf-msg" style="color:#c0392b;min-height:16px"></div><button id="bf-ok">Entrar</button> <button id="bf-no">Cerrar</button>');
    document.body.appendChild(f);
    f.querySelector('#bf-no').onclick = () => f.remove();
    if (sesion) {
      f.querySelector('#bf-ya').onclick = () => { f.remove(); subirStock(null); };
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
