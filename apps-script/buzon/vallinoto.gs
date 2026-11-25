/**
 * BUZÓN BUSCAFLOR — Excel mensual de VALLINOTO
 * Archivo aparte dentro del mismo proyecto (usa CONFIG, FOLDERS, iaJson_ y fmt_ de Código.gs).
 *
 * Cada día 5 a las 8:00 lee las facturas de Vallinoto del mes anterior
 * (04 Gastos España / AÑO / Vallinoto / MM), las añade a Facturas_Vallinoto_AÑO.xlsx
 * (mismo archivo, mismo formato, sigue siendo .xlsx) y te manda un email con el resumen y las dudas.
 *
 * PUESTA EN MARCHA (una sola vez):
 *   1. Editor > Servicios (+) > "Drive API" (v3), identificador "Drive" > Añadir.
 *   2. Ejecuta setupVallinoto()  → crea el disparador mensual.
 *   3. (Opcional) Ejecuta vallinotoManual() para procesar ya el mes de VALLINOTO.MES_MANUAL.
 *
 * Seguridad: antes de sobrescribir el Excel guarda una copia en Vallinoto / _Copias.
 * Se puede ejecutar varias veces sobre el mismo mes: las facturas que ya están en el Excel se saltan.
 */

const VALLINOTO = {
  EXCEL_PREFIX: 'Facturas_Vallinoto_',   // + AÑO + '.xlsx'
  DIA: 5,
  HORA: 8,
  MES_MANUAL: '2026-09',                 // solo para vallinotoManual()
  MAX_MS: 5 * 60 * 1000,
  MESES: ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO',
    'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'],
  N_COLS: 29,          // A (Nº Factura) … AC (PAGADO)
  COL_SUMA_INI: 10,    // J (Bultos)
  COL_SUMA_FIN: 28     // AB (TOTAL FACTURA)
};

// Columnas M..W (11 conceptos). Lo que no encaje va a "Otros Conceptos".
// Transportes (líneas "ENTREGA dd/mm") → Entrega Import. y pallets → Paletización, como en julio y agosto.
const VALLINOTO_CONCEPTOS = [
  [/PL[AÁ]STICO|ENVASES/i, 0],
  [/IVA\s+ADUANA/i, 1],
  [/COMISI[OÓ]N\s+OFICIAL/i, 2],
  [/ENTREGA\s+IMPORT|^ENTREGA\s+\d/i, 3],
  [/^THC/i, 4],
  [/FITO/i, 5],
  [/PALETIZ|^PALLETS?\b/i, 6],
  [/HANDLING/i, 7],
  [/MANIP/i, 8],
  [/MANTENIMIENTO|MANT\.?\s*SERV/i, 9]
];
const VALLINOTO_OTROS_CONOCIDOS = /PRECINTO/i;

// ─────────────────────────── DISPARADOR ───────────────────────────

function setupVallinoto() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'vallinotoMensual')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('vallinotoMensual').timeBased()
    .onMonthDay(VALLINOTO.DIA).atHour(VALLINOTO.HORA).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log('Disparador creado: día ' + VALLINOTO.DIA + ' de cada mes a las ' + VALLINOTO.HORA + ':00');
}

/** Lo lanza el disparador: procesa el mes anterior. */
function vallinotoMensual() {
  const hoy = new Date();
  const mesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1, 12);
  vallinotoMes(fmt_(mesAnterior, 'yyyy-MM'));
}

/** Para lanzarlo a mano desde el editor (el botón Ejecutar no admite parámetros). */
function vallinotoManual() { vallinotoMes(VALLINOTO.MES_MANUAL); }

// ─────────────────────────── PROCESO ───────────────────────────

function vallinotoMes(ym) {
  const t0 = Date.now();
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const mm = ('0' + m).slice(-2);
  const r = { ym: ym, y: y, m: m, mes: VALLINOTO.MESES[m - 1], anadidas: [], saltadas: [], noFactura: [], dudas: [], errores: [], excelUrl: '' };

  try {
    const base = vBuscarRuta_([FOLDERS.GASTOS_ES, String(y), 'Vallinoto']);
    if (!base) throw new Error('No existe la carpeta ' + FOLDERS.GASTOS_ES + ' / ' + y + ' / Vallinoto');
    const nombreExcel = VALLINOTO.EXCEL_PREFIX + y + '.xlsx';
    const itx = base.getFilesByName(nombreExcel);
    if (!itx.hasNext()) throw new Error('No encuentro ' + nombreExcel + ' en la carpeta Vallinoto');
    const excel = itx.next();
    r.excelUrl = excel.getUrl();

    const carpetaMes = vHijo_(base, mm);
    if (!carpetaMes) { r.dudas.push('No existe la carpeta Vallinoto / ' + mm + ': no hay nada que añadir.'); return vResumen_(r); }

    // PDFs del mes, ordenados por nombre
    const pdfs = [];
    const it = carpetaMes.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (f.getMimeType() === 'application/pdf') pdfs.push(f);
      else r.noFactura.push(f.getName() + ' (no es PDF)');
    }
    pdfs.sort((a, b) => a.getName().localeCompare(b.getName()));

    // El .xlsx se abre como Hoja de cálculo temporal para poder editarlo conservando su formato
    const tmp = Drive.Files.copy({ name: '_tmp_vallinoto_' + ym, mimeType: MimeType.GOOGLE_SHEETS, parents: [base.getId()] }, excel.getId());
    try {
      const ss = SpreadsheetApp.openById(tmp.id);
      const sh = ss.getSheets()[0];
      const ex = vLeerExistentes_(sh);
      const filas = [];

      for (const f of pdfs) {
        if (Date.now() - t0 > VALLINOTO.MAX_MS) {
          r.errores.push('Tiempo agotado: quedan PDFs sin leer. Vuelve a ejecutar vallinotoManual() con MES_MANUAL = ' + ym + ' (lo ya añadido se salta).');
          break;
        }
        const nom = f.getName();
        // Atajo sin IA: archivos que ya se llaman "2612051.pdf" y ya están en el Excel
        const n7 = (nom.match(/^(2\d{6})\.pdf$/i) || [])[1];
        if (n7 && (ex.numeros['V ' + n7] || ex.numeros['C ' + n7])) { r.saltadas.push(nom + ': ya estaba en el Excel'); continue; }

        const d = vLeerFactura_(f);
        if (!d) { r.dudas.push(nom + ': no se ha podido leer. Añádela a mano.'); continue; }
        if (d.tipo === 'DUA' || d.tipo === 'OTRO') { r.noFactura.push(nom + ' (' + d.tipo + ')'); continue; }

        const fila = vFila_(d, nom, r);
        if (!fila) continue;
        if (ex.numeros[fila[0]]) { r.saltadas.push(fila[0] + ': ya estaba en el Excel'); continue; }
        if (filas.some(x => x[0] === fila[0])) { r.saltadas.push(fila[0] + ': repetida en la carpeta (' + nom + ')'); continue; }
        if (fila[5] && !/^C /.test(fila[0])) {
          const previa = ex.declaraciones[fila[5]] || (filas.find(x => x[5] === fila[5]) || [])[0];
          if (previa) r.dudas.push(fila[0] + ': el Nº de declaración ' + fila[5] + ' ya figura en ' + previa + '. ¿Duplicada?');
        }
        filas.push(fila);
      }

      if (filas.length) {
        filas.sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])));
        vInsertarMes_(sh, r.mes + ' ' + y, filas);
        vActualizarTitulo_(sh, r.mes, y);
        SpreadsheetApp.flush();
        vGuardarXlsx_(tmp.id, excel, base);
        r.anadidas = filas;
      }
    } finally {
      DriveApp.getFileById(tmp.id).setTrashed(true);
    }
  } catch (e) {
    r.errores.push(String((e && e.message) || e));
  }
  return vResumen_(r);
}

// ─────────────────────────── LECTURA DE FACTURAS ───────────────────────────

function vLeerFactura_(file) {
  const prompt =
    'Documento de VALLINOTO CARGO (agente de aduanas de Madrid) dirigido a Rosas de Buscaflor. ' +
    'Si NO es una factura ni un abono (por ejemplo un DUA o certificado de importación), responde {"tipo":"DUA"} o {"tipo":"OTRO"}. ' +
    'Si es factura o abono, responde SOLO con JSON: {"tipo":"FACTURA","numero":"con su letra, ej. V 2611142 o C 2690149",' +
    '"fecha":"AAAA-MM-DD","fecha_llegada":"AAAA-MM-DD o vacío","expediente":"","s_referencia":"","declaracion":"Nº DECLARACION",' +
    '"manifiesto":"","proveedor":"","transporte":"","bultos":0,"peso_bruto":0,"peso_neto":0,' +
    '"conceptos":[{"texto":"literal de la línea","importe":0}],"importe":0,"base_exenta":0,"base_iva":0,"iva":0,"total":0}. ' +
    'Números con punto decimal y sin separador de miles (1.079,91 → 1079.91). En los abonos los importes son negativos. ' +
    'Copia cada línea de CONCEPTOS por separado, sin sumarlas ni omitir ninguna. Campos vacíos como "".';
  const d = iaJson_(prompt, file.getBlob(), 'application/pdf', 1500);
  if (!d || !d.tipo) return null;
  d.tipo = String(d.tipo).toUpperCase();
  return d;
}

/** Convierte la lectura en una fila de 29 columnas y apunta las dudas. */
function vFila_(d, nom, r) {
  const num = String(d.numero || '').trim().toUpperCase().replace(/^([VC])\s*-?\s*(\d+)$/, '$1 $2');
  if (!/^[VC] \d{7}$/.test(num)) { r.dudas.push(nom + ': nº de factura no reconocido ("' + d.numero + '"). No se ha añadido.'); return null; }
  const fecha = vFecha_(d.fecha);
  if (!fecha) { r.dudas.push(num + ': fecha ilegible. No se ha añadido.'); return null; }
  if (fecha.getMonth() + 1 !== r.m || fecha.getFullYear() !== r.y) {
    r.dudas.push(num + ': fecha de factura ' + fmt_(fecha, 'dd/MM/yyyy') + ', fuera de ' + r.mes.toLowerCase() + '. La he puesto en ' + r.mes.toLowerCase() + ' igualmente; muévela si procede.');
  }
  const n = x => { const v = Number(x); return isFinite(v) ? Math.round(v * 100) / 100 : 0; };
  const c = new Array(11).fill(0);
  (d.conceptos || []).forEach(k => {
    const texto = String(k.texto || '').trim();
    const hit = VALLINOTO_CONCEPTOS.find(p => p[0].test(texto));
    const i = hit ? hit[1] : 10;
    if (i === 10 && !VALLINOTO_OTROS_CONOCIDOS.test(texto)) r.dudas.push(num + ': concepto "' + texto + '" llevado a Otros Conceptos.');
    c[i] = Math.round((c[i] + n(k.importe)) * 100) / 100;
  });
  const imp = n(d.importe), exe = n(d.base_exenta), biv = n(d.base_iva), iva = n(d.iva), tot = n(d.total);
  const suma = c.reduce((a, b) => a + b, 0);
  const dif = (a, b) => Math.abs(a - b) > 0.011;
  if (dif(suma, imp)) r.dudas.push(num + ': los conceptos suman ' + eur_(suma) + ' y el importe es ' + eur_(imp) + '. Revisa la fila.');
  if (dif(c[0] + c[1] + c[5], exe)) r.dudas.push(num + ': base exenta ' + eur_(exe) + ' no cuadra con plástico + IVA aduana + fito (' + eur_(c[0] + c[1] + c[5]) + ').');
  if (dif(imp - exe, biv)) r.dudas.push(num + ': base IVA ' + eur_(biv) + ' ≠ importe − exenta (' + eur_(imp - exe) + ').');
  if (dif(Math.round(biv * 21) / 100, iva)) r.dudas.push(num + ': IVA ' + eur_(iva) + ' ≠ 21 % de ' + eur_(biv) + '.');
  if (dif(imp + iva, tot)) r.dudas.push(num + ': total ' + eur_(tot) + ' ≠ importe + IVA (' + eur_(imp + iva) + ').');
  const pb = n(d.peso_bruto), pn = n(d.peso_neto);
  if (pb && (pn > pb || pn < pb * 0.7)) r.dudas.push(num + ': peso neto ' + pn + ' kg frente a bruto ' + pb + ' kg. ¿Correcto?');
  if (/^C /.test(num)) r.dudas.push(num + ': es un abono/rectificativa (' + (d.s_referencia || d.expediente || '') + ').');

  const llegada = vFecha_(d.fecha_llegada);
  return [num, fecha, llegada || '', d.expediente || '', d.s_referencia || '', d.declaracion || '', d.manifiesto || '',
    d.proveedor || '', d.transporte || '', n(d.bultos), pb, pn].concat(c).concat([imp, exe, biv, iva, tot, '']);
}

function vFecha_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
}

// ─────────────────────────── ESCRITURA EN LA HOJA ───────────────────────────

function vLeerExistentes_(sh) {
  const vals = sh.getDataRange().getValues();
  const out = { numeros: {}, declaraciones: {} };
  vals.forEach(row => {
    const a = String(row[0]).trim();
    if (!/^[VC] \d{7}$/.test(a)) return;
    out.numeros[a] = true;
    if (row[5] && !out.declaraciones[row[5]]) out.declaraciones[String(row[5]).trim()] = a;
  });
  return out;
}

/**
 * Inserta las filas en la sección "▶ MES AÑO". Si no existe, la crea antes de TOTAL GENERAL
 * copiando el formato de la última cabecera, factura y subtotal. Rehace subtotal y TOTAL GENERAL.
 */
function vInsertarMes_(sh, etiquetaMes, filas) {
  const N = VALLINOTO.N_COLS;
  const colA = () => sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(x => String(x[0]).trim());
  let A = colA();
  const ultimo = re => { for (let i = A.length - 1; i >= 0; i--) if (re.test(A[i])) return i + 1; return 0; };
  const primero = (re, desde) => { for (let i = desde || 0; i < A.length; i++) if (re.test(A[i])) return i + 1; return 0; };

  if (!primero(/^TOTAL GENERAL/i)) throw new Error('No encuentro la fila TOTAL GENERAL en el Excel');
  const cab = '▶ ' + etiquetaMes;
  let filaCab = A.indexOf(cab) + 1;
  let filaIni, filaSub;

  if (filaCab) {
    // El mes ya existe: se añaden filas justo encima de su SUBTOTAL
    filaSub = primero(/^SUBTOTAL /i, filaCab);
    const modelo = filaSub - 1;
    sh.insertRowsBefore(filaSub, filas.length);
    sh.getRange(modelo, 1, 1, N).copyTo(sh.getRange(filaSub, 1, filas.length, N), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sh.getRange(filaSub, 1, filas.length, N).setValues(filas);
    filaIni = filaCab + 1;
    filaSub += filas.length;
  } else {
    // Mes nuevo: misma separación que entre los meses anteriores
    const cabModelo = ultimo(/^▶ /);
    const subModelo = ultimo(/^SUBTOTAL /i);
    const factModelo = ultimo(/^[VC] \d{7}$/);
    let subAnterior = 0;
    for (let i = cabModelo - 2; i >= 0; i--) if (/^SUBTOTAL /i.test(A[i])) { subAnterior = i + 1; break; }
    const hueco = subAnterior ? Math.max(0, cabModelo - subAnterior - 1) : 1;
    const total = hueco + 1 + filas.length + 1;
    const donde = subModelo + 1;
    sh.insertRowsAfter(subModelo, total);
    const fmt = (origen, destino, n) => sh.getRange(origen, 1, 1, N)
      .copyTo(sh.getRange(destino, 1, n || 1, N), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    if (hueco) sh.getRange(donde, 1, hueco, N).clearFormat();
    filaCab = donde + hueco;
    fmt(cabModelo, filaCab);
    sh.getRange(filaCab, 1, 1, N).clearContent();
    sh.getRange(filaCab, 1).setValue(cab);
    filaIni = filaCab + 1;
    fmt(factModelo, filaIni, filas.length);
    sh.getRange(filaIni, 1, filas.length, N).setValues(filas);
    filaSub = filaIni + filas.length;
    fmt(subModelo, filaSub);
  }

  // Subtotal del mes
  const L = c => vCol_(c);
  sh.getRange(filaSub, 1, 1, N).clearContent();
  sh.getRange(filaSub, 1).setValue('SUBTOTAL ' + etiquetaMes.split(' ')[0]);
  const fSub = [];
  for (let c = VALLINOTO.COL_SUMA_INI; c <= VALLINOTO.COL_SUMA_FIN; c++) fSub.push('=SUM(' + L(c) + filaIni + ':' + L(c) + (filaSub - 1) + ')');
  sh.getRange(filaSub, VALLINOTO.COL_SUMA_INI, 1, fSub.length).setFormulas([fSub]);

  // TOTAL GENERAL = suma de todos los SUBTOTAL (no depende de cuántos meses haya)
  A = colA();
  const filaTot = primero(/^TOTAL GENERAL/i);
  const fTot = [];
  for (let c = VALLINOTO.COL_SUMA_INI; c <= VALLINOTO.COL_SUMA_FIN; c++) {
    fTot.push('=SUMIF($A$1:$A$' + (filaTot - 1) + ',"SUBTOTAL*",' + L(c) + '1:' + L(c) + (filaTot - 1) + ')');
  }
  sh.getRange(filaTot, VALLINOTO.COL_SUMA_INI, 1, fTot.length).setFormulas([fTot]);
}

/** "… | Enero–Agosto 2026" → "… | Enero–Septiembre 2026" */
function vActualizarTitulo_(sh, mes, y) {
  const rg = sh.getRange(1, 1, 2, 3);
  const v = rg.getValues();
  const mesTxt = mes.charAt(0) + mes.slice(1).toLowerCase();
  for (let i = 0; i < v.length; i++) for (let j = 0; j < v[i].length; j++) {
    const s = String(v[i][j]);
    if (/VALLINOTO/i.test(s) && /Enero\s*[–-]\s*\S+\s+\d{4}/.test(s)) {
      sh.getRange(i + 1, j + 1).setValue(s.replace(/Enero\s*[–-]\s*\S+\s+\d{4}/, 'Enero–' + mesTxt + ' ' + y));
      return;
    }
  }
}

/** Exporta la hoja temporal a .xlsx y sustituye el contenido del Excel (mismo archivo y enlace). */
function vGuardarXlsx_(sheetId, excel, base) {
  const res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=xlsx', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('No se pudo exportar a .xlsx (' + res.getResponseCode() + ')');
  const copias = vHijo_(base, '_Copias') || base.createFolder('_Copias');
  excel.makeCopy(excel.getName().replace(/\.xlsx$/i, '') + ' (antes ' + fmt_(new Date(), 'yyyy-MM-dd HHmm') + ').xlsx', copias);
  Drive.Files.update({}, excel.getId(), res.getBlob().setContentType(MimeType.MICROSOFT_EXCEL));
}

// ─────────────────────────── EMAIL ───────────────────────────

function vResumen_(r) {
  const mesTxt = r.mes.charAt(0) + r.mes.slice(1).toLowerCase() + ' ' + r.y;
  const totalMes = r.anadidas.reduce((a, f) => a + Number(f[27] || 0), 0);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lista = (t, arr) => arr.length ? '<p><b>' + t + ' (' + arr.length + ')</b></p><ul>' + arr.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '';
  const td = 'style="padding:2px 8px;border-bottom:1px solid #ccc"';
  const tabla = r.anadidas.length
    ? '<table style="border-collapse:collapse;font-size:13px"><tr>' +
      ['Nº', 'Fecha', 'Expediente / Ref.', 'Proveedor', 'Total'].map(h => '<th align="left" ' + td + '>' + h + '</th>').join('') + '</tr>' +
      r.anadidas.map(f => '<tr><td ' + td + '>' + esc(f[0]) + '</td><td ' + td + '>' + fmt_(f[1], 'dd/MM') + '</td><td ' + td + '>' +
        esc(f[4] || f[3]) + '</td><td ' + td + '>' + esc(f[7]) + '</td><td align="right" ' + td + '>' + eur_(f[27]) + '</td></tr>').join('') +
      '<tr><td colspan="4" ' + td + '><b>Total ' + mesTxt.toLowerCase() + '</b></td><td align="right" ' + td + '><b>' + eur_(totalMes) + '</b></td></tr></table>'
    : '<p>No se ha añadido ninguna factura.</p>';

  const asunto = '[Vallinoto] ' + mesTxt + ': ' +
    (r.errores.length ? 'ERROR · ' : '') +
    r.anadidas.length + ' facturas añadidas' + (r.anadidas.length ? ' · ' + eur_(totalMes) : '') +
    (r.dudas.length ? ' · ' + r.dudas.length + ' dudas' : '');

  MailApp.sendEmail({
    to: CONFIG.ALERT_EMAIL,
    subject: asunto,
    htmlBody:
      lista('Errores', r.errores) +
      lista('Dudas a revisar', r.dudas) +
      '<p><b>Facturas añadidas</b></p>' + tabla +
      lista('Saltadas (ya estaban)', r.saltadas) +
      lista('Archivos que no son factura', r.noFactura) +
      (r.excelUrl ? '<p><a href="' + r.excelUrl + '">Abrir el Excel</a> · copia anterior en Vallinoto / _Copias</p>' : '')
  });
  return r;
}

// ─────────────────────────── UTILIDADES ───────────────────────────

function vBuscarRuta_(parts) {
  let f = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  for (const p of parts) { f = vHijo_(f, p); if (!f) return null; }
  return f;
}

function vHijo_(folder, name) {
  const it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

function vCol_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function eur_(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const p = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1] + ' €';
}