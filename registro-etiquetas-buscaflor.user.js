// ==UserScript==
// @name         Buscaflor - Registro de cajas (etiquetas Querry -> Firebase)
// @namespace    buscaflor
// @version      0.1.0
// @description  Registra en Firebase cada caja impresa en la app de etiquetas (cliente, nº de caja, artículos y cantidades). FASE 1: solo registra, no descuenta stock.
// @match        *://*/ImpresionEtiquetasRosasBuscaflor/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/diazjavierme-art/buscaflor-agente/main/registro-etiquetas-buscaflor.user.js
// @downloadURL  https://raw.githubusercontent.com/diazjavierme-art/buscaflor-agente/main/registro-etiquetas-buscaflor.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- Configuración ----------------
  const DB = 'https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app';
  const RAIZ = 'buscaflor/etiquetas';          // documentos/, eventos/
  const PUESTO = 'almacen';                     // identifica el PC que imprime
  const LS = 'bf_etiquetas_v1';                 // estado local (sobrevive a recargas)

  // ---------------- Utilidades ----------------
  const pad = n => String(n).padStart(2, '0');
  function fechaLocalISO(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function sanitizarClaveFirebase(s) { return String(s).replace(/[.#$\[\]\/]/g, '_').trim(); }
  function numES(s) { // "1.234,50" -> 1234.5
    if (s == null) return null;
    const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  const RE_CANT = /^-?[\d.]+,\d+$/;

  // ---------------- Motor (sin dependencias del DOM: testeable) ----------------
  function crearMotor({ leerCliente, enviar, ahora = () => new Date(), guardar = () => {}, estadoInicial = null }) {
    const S = estadoInicial || { docs: {}, docAbierto: null, ultimoDoc: null };
    const capMap = {};          // connectorId -> caption (botones, de la UIDL)
    let gridId = null;          // connector del DataCommunicator de la tabla principal
    let filas = [];             // filas actuales de la tabla principal
    let modo = null;            // 'repetir' | 'modificar' | 'cierre' | null
    let selCaja = null;         // caja seleccionada en el diálogo (Repetir / Modificar)
    let ultimoClick = null;     // texto del último botón pulsado en pantalla

    const fila = r => {
      const ks = Object.keys(r.d).map(Number).sort((a, b) => a - b).map(String);
      const [kc, kd, kq] = ks.slice(-3);
      return { codigo: String(r.d[kc]).trim(), descripcion: String(r.d[kd]).replace(/\s+/g, ' ').trim(), cantidad: numES(r.d[kq]), _k: r.k };
    };
    const esFilaPrincipal = r => {
      if (!r || !r.d || !r.cs) return false;
      const ks = Object.keys(r.d).map(Number);
      const max = String(Math.max(...ks));
      return ks.length >= 5 && r.cs[max] === 'align-right' && RE_CANT.test(r.d[max]);
    };

    function onClickTexto(t) { ultimoClick = (t || '').trim(); }

    function onRequest(body) {
      let q; try { q = JSON.parse(body); } catch (e) { return; }
      (q.rpc || []).forEach(r => {
        if (!/ButtonServerRpc$/.test(r[1]) || r[2] !== 'click') return;
        const cap = capMap[r[0]] || ultimoClick || '';
        if (/^Albar/i.test(cap)) cerrarDocumento('albaran');
        else if (/^Factura/i.test(cap)) cerrarDocumento('factura');
        else if (/^Cancelar/i.test(cap)) { modo = null; selCaja = null; }
        else if (/Reimprimir/i.test(cap)) modo = 'reimprimir';
      });
      ultimoClick = null;
    }

    function onResponse(text) {
      let arr; try { arr = JSON.parse(String(text).replace(/^for\(;;\);/, '')); } catch (e) { return; }
      if (!Array.isArray(arr)) arr = [arr];
      arr.forEach(j => {
        if (j && typeof j.uidl === 'string') { try { j = JSON.parse(j.uidl); } catch (e) { return; } }
        if (!j) return;
        const st = j.state || {};
        // 1) Captions de botones y diálogos
        Object.entries(st).forEach(([id, s]) => {
          if (s && typeof s.caption === 'string') capMap[id] = s.caption;
          if (s && typeof s.text === 'string') {
            if (s.text === 'Repetir caja') { modo = 'repetir'; selCaja = null; }
            else if (/^Selecci[oó]n de caja$/.test(s.text)) { modo = 'modificar'; selCaja = null; }
            else if (/^Cerrar documento$/.test(s.text)) modo = 'cierre';
          }
          if (s && typeof s.selectedItemCaption === 'string') {
            const m = s.selectedItemCaption.match(/Caja n[ºo°]\s*(\d+)/i);
            if (m) selCaja = +m[1];
          }
        });
        // 2) Impresión (se procesa ANTES de aplicar el reset de la tabla de esta misma respuesta)
        const ch = JSON.stringify(j.changes || []);
        if (/Trabajo enviado a la impresora/.test(ch)) {
          const m = ch.match(/"message":"[^"]*?caja n[ºo°]\s*(\d+)/i);
          if (m) registrarImpresion(+m[1]);
        }
        // 3) Datos de la tabla principal
        (j.rpc || []).forEach(r => {
          if (!/DataCommunicatorClientRpc$/.test(r[1])) return;
          const [id, , metodo, args] = r;
          if (metodo === 'setData' || metodo === 'updateData') {
            const rows = metodo === 'setData' ? args[1] : args[0];
            if (!gridId && rows.some(esFilaPrincipal)) gridId = id;
            if (id !== gridId) return;
            if (metodo === 'setData') rows.forEach((row, i) => { filas[args[0] + i] = fila(row); });
            else rows.forEach(row => { const f = fila(row); const i = filas.findIndex(x => x && x._k === f._k); if (i >= 0) filas[i] = f; });
          } else if (metodo === 'reset' && id === gridId) {
            filas = filas.slice(0, args[0]);
          }
        });
      });
    }

    function nuevoDoc(cli) {
      const t = ahora();
      const id = sanitizarClaveFirebase(`${fechaLocalISO(t).replace(/[-:]/g, '').replace('T', '_')}_C${cli.codigo}`);
      S.docs[id] = { cliente: cli, abierto: fechaLocalISO(t), estado: 'abierto', cajas: {}, puesto: PUESTO };
      S.docAbierto = id;
      return id;
    }

    function registrarImpresion(n) {
      const t = fechaLocalISO(ahora());
      const cli = leerCliente() || { codigo: '?', nombre: '?' };
      let id = S.docAbierto;
      if (!id || !S.docs[id] || S.docs[id].cliente.codigo !== cli.codigo) id = nuevoDoc(cli);
      const doc = S.docs[id];
      const previa = doc.cajas[n];
      const lineas = filas.filter(Boolean).map(({ codigo, descripcion, cantidad }) => ({ codigo, descripcion, cantidad }));
      let caja, tipo;

      if (modo === 'repetir') {
        const origen = selCaja != null ? doc.cajas[selCaja] : null;
        tipo = 'repetida';
        caja = { lineas: origen ? origen.lineas : null, origen: `repetida de caja ${selCaja}`, impresiones: 1, primera: t, ultima: t };
        if (!origen) caja.aviso = 'Contenido de la caja origen desconocido (impresa antes de instalar el script o tras recargar)';
      } else if (lineas.length && modo !== 'reimprimir') {
        tipo = previa ? 'modificada' : 'nueva';
        caja = { lineas, origen: tipo, impresiones: (previa ? previa.impresiones : 0) + 1, primera: previa ? previa.primera : t, ultima: t };
      } else {
        tipo = 'reimpresion';
        caja = previa ? { ...previa, impresiones: previa.impresiones + 1, ultima: t }
                      : { lineas: null, origen: 'reimpresion', impresiones: 1, primera: t, ultima: t, aviso: 'Reimpresión de una caja no registrada' };
      }
      doc.cajas[n] = caja;
      doc.actualizado = t;
      modo = null; selCaja = null;
      guardar(S);
      enviar('PATCH', `${RAIZ}/documentos/${id}`, { cliente: doc.cliente, abierto: doc.abierto, estado: doc.estado, puesto: PUESTO, actualizado: t, [`cajas/${n}`]: caja });
      enviar('POST', `${RAIZ}/eventos`, { t, doc: id, caja: n, tipo, cliente: cli.codigo, lineas: caja.lineas });
    }

    function cerrarDocumento(tipo) {
      const t = fechaLocalISO(ahora());
      modo = null;
      const id = S.docAbierto || S.ultimoDoc;
      if (!id || !S.docs[id]) { enviar('POST', `${RAIZ}/eventos`, { t, tipo: 'cierre-sin-cajas', cierre: tipo }); return; }
      const doc = S.docs[id];
      const yaCerrado = doc.estado !== 'abierto';
      doc.cierres = doc.cierres || {};
      doc.cierres[tipo] = t;
      if (!yaCerrado) doc.estado = tipo;
      const patch = { estado: doc.estado, [`cierres/${tipo}`]: t, actualizado: t };
      if (yaCerrado) patch.alerta = `Documento cerrado más de una vez (${Object.keys(doc.cierres).join(' + ')}): revisar duplicado en AmbarX`;
      S.ultimoDoc = id; S.docAbierto = null;
      guardar(S);
      enviar('PATCH', `${RAIZ}/documentos/${id}`, patch);
      enviar('POST', `${RAIZ}/eventos`, { t, doc: id, tipo: 'cierre', cierre: tipo, duplicado: yaCerrado });
    }

    return { onRequest, onResponse, onClickTexto, estado: () => S, filas: () => filas };
  }

  // Exponer el motor para pruebas
  window.__bfCrearMotor = crearMotor;
  if (window.__bfNoInstalar) return;

  // ---------------- Instalación en la página ----------------
  let estado = null;
  try { estado = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) {}
  // Limpia documentos de más de 7 días del estado local
  if (estado && estado.docs) {
    const lim = fechaLocalISO(new Date(Date.now() - 7 * 864e5));
    Object.keys(estado.docs).forEach(k => { if ((estado.docs[k].actualizado || estado.docs[k].abierto) < lim) delete estado.docs[k]; });
  }

  const fetchOrig = window.fetch.bind(window);
  let cola = []; try { cola = JSON.parse(localStorage.getItem(LS + '_cola') || '[]'); } catch (e) {}
  let ok = 0, err = 0, enviando = false;
  const guardarCola = () => { try { localStorage.setItem(LS + '_cola', JSON.stringify(cola)); } catch (e) {} };

  async function vaciarCola() {
    if (enviando) return; enviando = true;
    while (cola.length) {
      const w = cola[0];
      try {
        const r = await fetchOrig(`${DB}/${w.ruta}.json`, { method: w.metodo, body: JSON.stringify(w.datos), headers: { 'Content-Type': 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        cola.shift(); ok++; guardarCola();
      } catch (e) { err++; console.warn('[bf-etiquetas] envío fallido, se reintentará', e); break; }
    }
    enviando = false; pintar();
  }
  setInterval(vaciarCola, 30000);

  const motor = crearMotor({
    leerCliente: () => {
      const inp = [...document.querySelectorAll('input.v-textfield-readonly')];
      if (inp.length < 2 || inp[0].value === '') return null;
      return { codigo: inp[0].value.trim(), nombre: inp[1].value.trim() };
    },
    enviar: (metodo, ruta, datos) => { cola.push({ metodo, ruta, datos }); guardarCola(); vaciarCola(); },
    guardar: S => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) {} },
    estadoInicial: estado
  });

  // Interceptar las peticiones UIDL de Vaadin
  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__bfUrl = String(u); return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const x = this;
    if (/\/UIDL\/|v-browserDetails|\?v-\d+/.test(x.__bfUrl || '') || (typeof body === 'string' && /v-browserDetails/.test(body))) {
      try { if (typeof body === 'string') motor.onRequest(body); } catch (e) { console.error('[bf-etiquetas]', e); }
      x.addEventListener('load', () => { try { motor.onResponse(x.responseText); pintar(); } catch (e) { console.error('[bf-etiquetas]', e); } });
    }
    return oSend.apply(this, arguments);
  };
  // Texto del botón pulsado (respaldo por si el caption no vino en la UIDL)
  document.addEventListener('mousedown', e => { const b = e.target.closest && e.target.closest('.v-button'); if (b) motor.onClickTexto(b.innerText); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = document.activeElement && document.activeElement.closest && document.activeElement.closest('.v-button'); if (b) motor.onClickTexto(b.innerText); } }, true);

  // Indicador discreto
  let badge;
  function pintar() {
    if (!document.body) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.3 Arial,sans-serif;padding:4px 8px;border-radius:4px;color:#fff;opacity:.85;pointer-events:none';
      document.body.appendChild(badge);
    }
    const S = motor.estado();
    const doc = S.docAbierto && S.docs[S.docAbierto];
    const n = doc ? Object.keys(doc.cajas).length : 0;
    badge.style.background = cola.length ? '#c0392b' : '#2e7d32';
    badge.textContent = `Registro cajas: ${doc ? n + ' caja(s) en doc. abierto' : 'sin documento abierto'} · ${cola.length ? cola.length + ' pendiente(s) de enviar' : 'Firebase OK'}`;
  }
  document.addEventListener('DOMContentLoaded', () => { pintar(); vaciarCola(); });
})();
