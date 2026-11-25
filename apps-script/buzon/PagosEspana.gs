/**
 * Buzón Buscaflor · Transferencias a proveedores españoles (25-11-2026)
 *
 * Suelta los justificantes tal cual los da el banco en
 *   "04 Gastos España / _Subir pagos aquí"
 * La IA lee fecha, beneficiario, importe y concepto; el archivo se renombra como
 *   2026-11-25_PAGO_Vallinoto_EUR 1234,56.pdf
 * y se mueve a "04 Gastos España / Pagos / AÑO / <Proveedor>".
 * Queda apuntado en la pestaña "Pagos España" del registro.
 * Si no se puede leer, o es un duplicado, va a "04 Gastos España / Pagos / _Revisar".
 *
 * Se ejecuta solo dentro de procesarBuzon(); también puedes lanzar procesarPagosEspana() a mano.
 */

const SUBIR_PAGOS_ES = '_Subir pagos aquí';
const PAGOS_ES = 'Pagos';

// Nombre corto del proveedor según lo que ponga el beneficiario o el concepto.
// Añade aquí los que quieras; el resto se guarda con el nombre del beneficiario tal cual.
const PROVEEDORES_PAGO_ES = [
  [/vallinoto/i, 'Vallinoto'],
  [/miras/i, 'Miras'],
  [/coflores/i, 'Coflores'],
  [/verdnatura/i, 'Verdnatura'],
  [/cecotrans/i, 'Cecotrans'],
];

function procesarPagosEspana() { procesarPagosEspana_(Date.now()); }

function procesarPagosEspana_(t0, limiteMs) {
  const tope = limiteMs || (CONFIG.MAX_RUNTIME_MS + 60 * 1000);
  const entrada = getOrCreatePath_([FOLDERS.GASTOS_ES, SUBIR_PAGOS_ES]);
  const files = entrada.getFiles();
  if (!files.hasNext()) return;
  if (!iaDisponible_()) { Logger.log('Falta CLAUDE_API_KEY o GEMINI_API_KEY: no se pueden leer los justificantes de España.'); return; }

  const ss = getRegistro_();
  let sh = ss.getSheetByName('Pagos España');
  if (!sh) {
    sh = ss.insertSheet('Pagos España');
    sh.appendRow(['Fecha', 'Proveedor', 'Beneficiario', 'Importe', 'Moneda', 'Concepto', 'Archivo', 'Enlace', 'MD5', 'Registrado']);
    sh.setFrozenRows(1);
  }
  const md5s = {}, yaPagados = {};
  const clave = (f, imp, prov) => [f, Number(imp).toFixed(2), String(prov || '').toLowerCase().replace(/[^a-z0-9]/g, '')].join('|');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues().forEach(r => {
    if (r[8]) md5s[r[8]] = true;
    if (r[0] && r[3]) {
      const f = r[0] instanceof Date ? Utilities.formatDate(r[0], ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(r[0]).slice(0, 10);
      yaPagados[clave(f, r[3], r[1])] = true;
    }
  });
  const revisar = () => getOrCreatePath_([FOLDERS.GASTOS_ES, PAGOS_ES, '_Revisar']);

  const filas = [];
  while (files.hasNext()) {
    if (Date.now() - t0 > tope) break;
    const file = files.next();
    try {
      const mime = file.getMimeType();
      if (['application/pdf', 'image/jpeg', 'image/png'].indexOf(mime) < 0) { file.moveTo(revisar()); continue; }
      const blob = file.getBlob();
      const md5 = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, blob.getBytes()));
      if (md5s[md5]) { file.setName('DUPLICADO_' + file.getName()); file.moveTo(revisar()); continue; }

      const d = leerPagoEspana_(blob, mime);
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.fecha || '') || !d.importe) { file.moveTo(revisar()); continue; }

      const benef = String(d.beneficiario || '').trim();
      const texto = benef + ' ' + String(d.concepto || '');
      const conocido = PROVEEDORES_PAGO_ES.find(p => p[0].test(texto));
      const prov = conocido ? conocido[1] : (limpiar_(benef) || 'DESCONOCIDO');
      const importe = Number(d.importe), moneda = d.moneda || 'EUR';

      if (yaPagados[clave(d.fecha, importe, prov)]) {
        file.setName('DUPLICADO_' + file.getName()); file.moveTo(revisar()); continue;
      }
      const impTxt = importe % 1 === 0 ? String(importe) : importe.toFixed(2).replace('.', ',');
      const ext = mime === 'application/pdf' ? '.pdf' : (mime === 'image/png' ? '.png' : '.jpg');
      const destino = getOrCreatePath_([FOLDERS.GASTOS_ES, PAGOS_ES, d.fecha.slice(0, 4), prov]);
      file.moveTo(destino);
      file.setName(nombreUnico_(destino, limpiar_(d.fecha + '_PAGO_' + prov + '_' + moneda + ' ' + impTxt) + ext));

      md5s[md5] = true; yaPagados[clave(d.fecha, importe, prov)] = true;
      filas.push([d.fecha, prov, benef, importe, moneda, String(d.concepto || ''), file.getName(), file.getUrl(), md5, new Date()]);
      Logger.log('Pago España: ' + file.getName() + '  →  ' + [FOLDERS.GASTOS_ES, PAGOS_ES, d.fecha.slice(0, 4), prov].join(' / '));
    } catch (e) { Logger.log('Pago España ' + file.getName() + ': ' + e); }
  }
  if (filas.length) sh.getRange(sh.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);
}

function leerPagoEspana_(blob, mime) {
  const prompt =
    'Este documento es un justificante bancario (transferencia, recibo o adeudo) de una empresa española ' +
    'que paga a un proveedor español. Extrae los datos y responde SOLO con JSON:\n' +
    '{"fecha": "AAAA-MM-DD" (fecha de la operación), ' +
    '"beneficiario": "nombre del beneficiario tal como aparece", ' +
    '"importe": número sin separador de miles y con punto decimal, ' +
    '"moneda": "EUR" u otra, ' +
    '"concepto": "el concepto de la transferencia copiado tal cual"}';
  return iaJson_(prompt, blob, mime, 500);
}
