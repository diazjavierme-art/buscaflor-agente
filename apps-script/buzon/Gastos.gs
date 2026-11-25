/**
 * BUZÓN BUSCAFLOR — Excel global de GASTOS (facturas españolas)
 * Archivo aparte dentro del mismo proyecto (usa CONFIG, FOLDERS, iaJson_ y fmt_ de Código.gs).
 *
 * Cada DÍA 10 de mes a las 8:00 (así da tiempo a que lleguen las facturas del mes anterior, que muchas llegan tarde):
 *  1. Busca las facturas nuevas guardadas por el buzón en 04 Gastos España / AÑO / Otros gastos / Tn / AAAA-MM
 *     (no mira la subcarpeta "Albaranes" ni Vallinoto, que tiene su propio Excel).
 *  2. Las lee con Claude: nº, fecha, proveedor, CIF, categoría, concepto, base, IVA, total y forma de pago.
 *  3. Las añade al final de "Registro Proveedores" en Facturas_Proveedores_global_AÑO_CIF.xlsx
 *     (mismo archivo, mismo formato, sigue siendo .xlsx; antes guarda una copia en Otros gastos / _Copias).
 *  4. Lo dudoso lo apunta en la hoja "Revisar" y te manda un email con el resumen.
 *
 * Nunca añade: albaranes, facturas de VENTA de Buscaflor, facturas a nombre de otra empresa o persona,
 * documentos que no son factura, ni facturas que ya estén en el Excel (mismo nº y proveedor).
 * Cada archivo se lee UNA sola vez (queda anotado en la pestaña "Gastos IA" de la hoja de registro).
 *
 * PUESTA EN MARCHA (una sola vez):
 *   - Necesita el servicio avanzado "Drive" (v3), el mismo que ya usa vallinoto.gs.
 *   - Ejecuta setupGastos()  → crea el disparador del día 10 y marca "desde ahora" (no reprocesa lo antiguo).
 *   - Para probarlo sin esperar al día 10: gastosManual().
 */

const GASTOS = {
  EXCEL: año => 'Facturas_Proveedores_global_' + año + '_CIF.xlsx',
  HOJA: 'Registro Proveedores',
  DIA: 10,                        // día del mes
  HORA: 8,
  MAX_MS: 5 * 60 * 1000,
  N_COLS: 13,                      // A (Nº Factura) … M (Forma de Pago)
  CIF_PROPIO: 'B91821579',
  CATEGORIAS: ['🌸 Flores / Producto', '⛽ Combustible', '⚖️ Asesoría / Gestoría', '🚚 Transporte / Mensajería',
    '💡 Suministros (Luz/Gas)', '🔩 Material / Suministros', '🔧 Reparación / Taller', '🔧 Mantenimiento / ERP',
    '🚗 Renting / Vehículo', '🏠 Seguros / Inmobiliario', '📋 Servicios Profesionales', '⚠️ Multas / Sanciones']
};

// ─────────────────────────── DISPARADOR ───────────────────────────

function setupGastos() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'gastosMensual')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('gastosMensual').timeBased().onMonthDay(GASTOS.DIA).atHour(GASTOS.HORA)
    .inTimezone(CONFIG.TIMEZONE).create();
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('GASTOS_DESDE')) p.setProperty('GASTOS_DESDE', new Date().toISOString());
  gHojaControl_();
  Logger.log('Listo: el día ' + GASTOS.DIA + ' de cada mes a las ' + GASTOS.HORA + ':00. Facturas guardadas desde: ' + p.getProperty('GASTOS_DESDE'));
}

function gastosMensual() { gastosProcesar_(); }
function gastosManual() { gastosProcesar_(); }

// ─────────────────────────── PROCESO ───────────────────────────

function gastosProcesar_() {
  const t0 = Date.now();
  const r = { anadidas: [], saltadas: [], noAnadidas: [], dudas: [], errores: [], excelUrl: '' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const desdeTxt = PropertiesService.getScriptProperties().getProperty('GASTOS_DESDE');
    const desde = desdeTxt ? new Date(desdeTxt) : new Date();
    const control = gCargarControl_();
    const candidatos = gCandidatos_(desde, control);
    if (!candidatos.length) { r.saltadas.push('No hay facturas nuevas desde la última revisión.'); return gResumen_(r); }

    // Agrupa por año (cada año tiene su Excel)
    const porAño = {};
    candidatos.forEach(c => (porAño[c.año] = porAño[c.año] || []).push(c));

    Object.keys(porAño).forEach(año => {
      const base = gBuscarRuta_([FOLDERS.GASTOS_ES, año, 'Otros gastos']);
      const itx = base ? base.getFilesByName(GASTOS.EXCEL(año)) : null;
      if (!itx || !itx.hasNext()) { r.errores.push('No encuentro ' + GASTOS.EXCEL(año) + ' en 04 Gastos España / ' + año + ' / Otros gastos'); return; }
      const excel = itx.next();
      r.excelUrl = excel.getUrl();

      const tmp = Drive.Files.copy({ name: '_tmp_gastos_' + año, mimeType: MimeType.GOOGLE_SHEETS, parents: [base.getId()] }, excel.getId());
      try {
        const ss = SpreadsheetApp.openById(tmp.id);
        const sh = ss.getSheetByName(GASTOS.HOJA) || ss.getSheets()[0];
        const ex = gExistentes_(sh);
        const filas = [], revisar = [];

        for (const c of porAño[año]) {
          if (Date.now() - t0 > GASTOS.MAX_MS) { r.errores.push('Tiempo agotado: quedan facturas sin leer. Vuelve a ejecutar gastosManual().'); break; }
          const d = gLeer_(c.file);
          if (!d) { gMarcar_(c.file, 'ERROR', ''); r.dudas.push(c.file.getName() + ': no se ha podido leer (se reintentará).'); continue; }

          const motivo = gMotivoNoAnadir_(d);
          if (motivo) { gMarcar_(c.file, motivo, d.numero || ''); r.noAnadidas.push(c.file.getName() + ' — ' + motivo); continue; }

          const clave = gClave_(d.numero, d.cif, d.proveedor), clave2 = gClave_(d.numero, '', d.proveedor);
          if (ex[clave] || ex[clave2] || filas.some(f => gClave_(f[0], f[3], f[2]) === clave || gClave_(f[0], '', f[2]) === clave2)) {
            gMarcar_(c.file, 'YA ESTABA', d.numero); r.saltadas.push((d.numero || c.file.getName()) + ' (' + (d.proveedor || '') + '): ya estaba en el Excel'); continue;
          }

          const res = gFila_(d, c.file.getName());
          filas.push(res.fila);
          res.dudas.forEach(x => { r.dudas.push(x); revisar.push([c.file.getName(), (d.numero || '') + ' · ' + (d.proveedor || ''), x]); });
          gMarcar_(c.file, 'AÑADIDA', d.numero);
        }

        if (filas.length) {
          gInsertar_(sh, filas);
          gActualizarFecha_(sh);
          if (revisar.length) gRevisar_(ss, revisar);
          SpreadsheetApp.flush();
          gGuardarXlsx_(tmp.id, excel, base);
          r.anadidas = r.anadidas.concat(filas);
        }
      } finally {
        DriveApp.getFileById(tmp.id).setTrashed(true);
      }
    });
  } catch (e) {
    r.errores.push(String((e && e.message) || e));
  } finally {
    lock.releaseLock();
  }
  return gResumen_(r);
}

// Facturas guardadas por el buzón en Otros gastos / AÑO / Tn / AAAA-MM (sin Albaranes), nuevas y no leídas
function gCandidatos_(desde, control) {
  const out = [];
  const años = [String(new Date().getFullYear())];
  if (new Date().getMonth() === 0) años.push(String(new Date().getFullYear() - 1));   // en enero, también el año anterior
  años.forEach(año => {
    const og = gBuscarRuta_([FOLDERS.GASTOS_ES, año, 'Otros gastos']);
    if (!og) return;
    ['T1', 'T2', 'T3', 'T4'].forEach(t => {
      const tri = gHijo_(og, t); if (!tri) return;
      const meses = tri.getFolders();
      while (meses.hasNext()) {
        const mes = meses.next();
        if (!/^\d{4}-\d{2}$/.test(mes.getName())) continue;
        const fs = mes.getFiles();
        while (fs.hasNext()) {
          const f = fs.next();
          if (control[f.getId()] && control[f.getId()] !== 'ERROR') continue;
          if (f.getDateCreated() < desde) continue;
          if (!/application\/pdf|image\/(jpeg|png)/.test(f.getMimeType())) continue;
          out.push({ file: f, año: año });
        }
      }
    });
  });
  return out.sort((a, b) => a.file.getDateCreated() - b.file.getDateCreated());
}

// ─────────────────────────── LECTURA ───────────────────────────

function gLeer_(file) {
  const prompt =
    'Documento recibido por ROSAS DE BUSCAFLOR LAMEJOR S.L. (CIF B91821579), empresa española de flor cortada. ' +
    'Responde SOLO con JSON:\n{"tipo":"FACTURA|ABONO|ALBARAN|TICKET|OTRO","emisor_es_buscaflor":true|false,' +
    '"cliente":"nombre del cliente/destinatario","cif_cliente":"","numero":"nº de factura tal cual","fecha":"AAAA-MM-DD",' +
    '"proveedor":"razón social del emisor","cif":"CIF/NIF del emisor","categoria":"una de: ' + GASTOS.CATEGORIAS.join(' | ') + '",' +
    '"concepto":"resumen corto (máx. 80 caracteres)","base":n,"iva_pct":n,"cuota":n,"iva2_pct":n,"cuota2":n,' +
    '"otros":n,"total":n,"forma_pago":"Transferencia | Recibo domiciliado | Tarjeta | Pagado en caja | Pendiente | …"}\n' +
    'Reglas: base = suma de bases imponibles. Si hay un único tipo de IVA, iva2_pct y cuota2 = 0. Porcentajes como número (21, 10, 4, 0). ' +
    '"otros" = importes del total que no son base ni IVA (tasas, suplidos, recargos). Números con punto decimal, sin separador de miles. ' +
    'En un ABONO los importes van en negativo. TICKET = ticket simplificado sin datos del cliente. ' +
    'emisor_es_buscaflor = true si la factura la EMITE Rosas de Buscaflor (es una venta).';
  const mime = file.getMimeType();
  const d = iaJson_(prompt, file.getBlob(), mime === 'application/pdf' ? 'application/pdf' : mime, 800);
  if (!d || !d.tipo) return null;
  d.tipo = String(d.tipo).toUpperCase();
  return d;
}

function gMotivoNoAnadir_(d) {
  if (d.emisor_es_buscaflor) return 'FACTURA DE VENTA (la emite Buscaflor)';
  if (d.tipo === 'ALBARAN') return 'ALBARÁN';
  if (d.tipo === 'OTRO') return 'NO ES FACTURA';
  const cifCli = String(d.cif_cliente || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cli = String(d.cliente || '').toUpperCase();
  if (d.tipo !== 'TICKET' && cifCli && cifCli.indexOf(GASTOS.CIF_PROPIO) < 0 && !/BUSCAFLOR/.test(cli))
    return 'A NOMBRE DE OTRO (' + (d.cliente || cifCli) + ')';
  if (!String(d.numero || '').trim()) return 'SIN Nº DE FACTURA';
  return '';
}

function gFila_(d, nombre) {
  const n = x => { const v = Number(x); return isFinite(v) ? Math.round(v * 100) / 100 : 0; };
  const dudas = [];
  const num = String(d.numero || '').trim();
  const f = String(d.fecha || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const fecha = f ? f[3] + '/' + f[2] + '/' + f[1] : '';
  if (!fecha) dudas.push(num + ': fecha ilegible.');
  const cat = GASTOS.CATEGORIAS.indexOf(d.categoria) >= 0 ? d.categoria : '🔩 Material / Suministros';
  if (cat !== d.categoria) dudas.push(num + ': categoría "' + (d.categoria || '') + '" no reconocida; puesta como Material / Suministros.');
  const base = n(d.base), p1 = n(d.iva_pct) / 100, c1 = n(d.cuota), p2 = n(d.iva2_pct) / 100, c2 = n(d.cuota2), otros = n(d.otros), tot = n(d.total);
  if (!String(d.cif || '').trim()) dudas.push(num + ': falta el CIF del proveedor.');
  if (Math.abs(base + c1 + c2 + otros - tot) > 0.02) dudas.push(num + ': base + IVA (' + gEur_(base + c1 + c2 + otros) + ') no cuadra con el total (' + gEur_(tot) + ').');
  if (p1 && Math.abs(Math.round(base * p1 * 100) / 100 - c1) > 0.05 && !p2) dudas.push(num + ': el IVA ' + gEur_(c1) + ' no es el ' + Math.round(p1 * 100) + ' % de la base.');
  if (d.tipo === 'TICKET') dudas.push(num + ': es un ticket simplificado (sin datos de Buscaflor): el IVA puede no ser deducible.');
  if (d.tipo === 'ABONO') dudas.push(num + ': es un abono/rectificativa.');
  if (otros) dudas.push(num + ': incluye ' + gEur_(otros) + ' de tasas/suplidos fuera de la base.');
  const fila = [num, fecha, d.proveedor || '', String(d.cif || '').toUpperCase(), cat, String(d.concepto || '').slice(0, 120),
    base, p1, c1, p2 ? p2 : '', p2 ? c2 : '', tot, d.forma_pago || 'Pendiente'];
  return { fila: fila, dudas: dudas };
}

// ─────────────────────────── ESCRITURA ───────────────────────────

function gClave_(num, cif, prov) {
  const nn = String(num || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const id = String(cif || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || String(prov || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return nn + '|' + id;
}

function gExistentes_(sh) {
  const out = {};
  const last = sh.getLastRow();
  if (last < 4) return out;
  sh.getRange(4, 1, last - 3, 4).getValues().forEach(r => {
    if (!r[0] || /TOTALES/i.test(String(r[0]))) return;
    out[gClave_(r[0], r[3], r[2])] = true;
    out[gClave_(r[0], '', r[2])] = true;              // por si en el Excel falta el CIF
  });
  return out;
}

/** Añade las filas justo encima de "▶ TOTALES", con el formato de la última fila de su misma categoría, y rehace los totales. */
function gInsertar_(sh, filas) {
  const N = GASTOS.N_COLS;
  const colA = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(x => String(x[0]));
  let filaTot = colA.findIndex(x => /TOTALES/i.test(x)) + 1;
  if (!filaTot) throw new Error('No encuentro la fila ▶ TOTALES en ' + GASTOS.HOJA);
  const cats = sh.getRange(4, 5, filaTot - 4, 1).getValues().map(x => String(x[0]));
  sh.insertRowsBefore(filaTot, filas.length);
  filas.forEach((f, i) => {
    const destino = filaTot + i;
    let modelo = 0;
    for (let k = cats.length - 1; k >= 0; k--) if (cats[k] === f[4]) { modelo = 4 + k; break; }
    if (!modelo) modelo = filaTot - 1;
    sh.getRange(modelo, 1, 1, N).copyTo(sh.getRange(destino, 1, 1, N), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sh.getRange(destino, 2).setNumberFormat('@');           // la fecha se guarda como texto dd/mm/aaaa, como las demás
  });
  sh.getRange(filaTot, 1, filas.length, N).setValues(filas);
  filaTot += filas.length;
  const ult = filaTot - 1;
  sh.getRange(filaTot, 7).setFormula('=SUM(G4:G' + ult + ')');
  sh.getRange(filaTot, 9).setFormula('=SUM(I4:I' + ult + ')');
  sh.getRange(filaTot, 11).setFormula('=SUM(K4:K' + ult + ')');
  sh.getRange(filaTot, 12).setFormula('=SUM(L4:L' + ult + ')');
}

function gActualizarFecha_(sh) {
  const c = sh.getRange(2, 1), v = String(c.getValue());
  if (/Actualizado:/i.test(v)) c.setValue(v.replace(/Actualizado:\s*[\d\/]+/i, 'Actualizado: ' + fmt_(new Date(), 'dd/MM/yyyy')));
}

function gRevisar_(ss, filas) {
  let sh = ss.getSheetByName('Revisar');
  if (!sh) { sh = ss.insertSheet('Revisar'); sh.appendRow(['Archivo', 'Documento', 'Qué pasa']); sh.getRange(1, 1, 1, 3).setFontWeight('bold'); }
  sh.getRange(sh.getLastRow() + 1, 1, filas.length, 3).setValues(filas).setFontFamily('Arial').setFontSize(9).setWrap(true);
}

function gGuardarXlsx_(sheetId, excel, base) {
  const res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=xlsx', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('No se pudo exportar a .xlsx (' + res.getResponseCode() + ')');
  const copias = gHijo_(base, '_Copias') || base.createFolder('_Copias');
  excel.makeCopy(excel.getName().replace(/\.xlsx$/i, '') + ' (antes ' + fmt_(new Date(), 'yyyy-MM-dd HHmm') + ').xlsx', copias);
  Drive.Files.update({}, excel.getId(), res.getBlob().setContentType(MimeType.MICROSOFT_EXCEL));
}

// ─────────────────────────── CONTROL (pestaña "Gastos IA") ───────────────────────────

function gHojaControl_() {
  const ss = getRegistro_();
  let sh = ss.getSheetByName('Gastos IA');
  if (!sh) {
    sh = ss.insertSheet('Gastos IA');
    sh.appendRow(['FileId', 'Archivo', 'Estado', 'Nº factura', 'Fecha']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold'); sh.setFrozenRows(1);
  }
  return sh;
}
function gCargarControl_() {
  const sh = gHojaControl_(), out = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => { if (r[0]) out[r[0]] = String(r[2]); });
  return out;
}
function gMarcar_(file, estado, numero) {
  gHojaControl_().appendRow([file.getId(), file.getName(), estado, numero || '', new Date()]);
}

// ─────────────────────────── EMAIL ───────────────────────────

function gResumen_(r) {
  const tot = r.anadidas.reduce((a, f) => a + Number(f[11] || 0), 0);
  const iva = r.anadidas.reduce((a, f) => a + Number(f[8] || 0) + Number(f[10] || 0), 0);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lista = (t, arr) => arr.length ? '<p><b>' + t + ' (' + arr.length + ')</b></p><ul>' + arr.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '';
  const td = 'style="padding:2px 8px;border-bottom:1px solid #ccc"';
  const tabla = r.anadidas.length
    ? '<table style="border-collapse:collapse;font-size:13px"><tr>' + ['Nº', 'Fecha', 'Proveedor', 'Base', 'IVA', 'Total']
        .map(h => '<th align="left" ' + td + '>' + h + '</th>').join('') + '</tr>' +
      r.anadidas.map(f => '<tr><td ' + td + '>' + esc(f[0]) + '</td><td ' + td + '>' + esc(f[1]) + '</td><td ' + td + '>' + esc(f[2]) +
        '</td><td align="right" ' + td + '>' + gEur_(f[6]) + '</td><td align="right" ' + td + '>' + gEur_(Number(f[8] || 0) + Number(f[10] || 0)) +
        '</td><td align="right" ' + td + '>' + gEur_(f[11]) + '</td></tr>').join('') +
      '<tr><td colspan="4" ' + td + '><b>Total</b></td><td align="right" ' + td + '><b>' + gEur_(iva) + '</b></td><td align="right" ' + td + '><b>' + gEur_(tot) + '</b></td></tr></table>'
    : '<p>No se ha añadido ninguna factura.</p>';
  const asunto = '[Gastos] ' + (r.errores.length ? 'ERROR · ' : '') + r.anadidas.length + ' facturas añadidas' +
    (r.anadidas.length ? ' · ' + gEur_(tot) : '') + (r.dudas.length ? ' · ' + r.dudas.length + ' dudas' : '');
  MailApp.sendEmail({
    to: CONFIG.ALERT_EMAIL, subject: asunto,
    htmlBody: lista('Errores', r.errores) + lista('Dudas (también en la hoja "Revisar")', r.dudas) +
      '<p><b>Facturas añadidas al Excel global</b></p>' + tabla +
      lista('No añadidas', r.noAnadidas) + lista('Saltadas (ya estaban)', r.saltadas) +
      (r.excelUrl ? '<p><a href="' + r.excelUrl + '">Abrir el Excel</a> · copia anterior en Otros gastos / _Copias</p>' : '')
  });
  return r;
}

// ─────────────────────────── UTILIDADES ───────────────────────────

function gBuscarRuta_(parts) {
  let f = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  for (const p of parts) { f = gHijo_(f, String(p)); if (!f) return null; }
  return f;
}
function gHijo_(folder, name) {
  const it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function gEur_(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const p = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1] + ' €';
}