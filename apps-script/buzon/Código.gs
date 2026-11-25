/**
 * BUZÓN BUSCAFLOR — Fase 1
 * Clasifica el correo que llega a facturasbuscaflor@gmail.com (redirigido desde Outlook),
 * guarda los adjuntos en la estructura de carpetas nueva y avisa cuando algo requiere atención.
 *
 * PUESTA EN MARCHA (una sola vez):
 *   1. Revisa CONFIG (sobre todo ALERT_EMAIL).
 *   2. Proyecto > Configuración > Propiedades del script > añade CLAUDE_API_KEY (o GEMINI_API_KEY).
 *   3. Ejecuta  setup()               → crea carpetas, hoja de registro, etiquetas y el disparador.
 *   4. Ejecuta  aprenderRemitentes()  → lista los remitentes de los últimos 90 días en la hoja "Remitentes".
 *   5. En la hoja "Remitentes", pon Tipo y Proveedor a cada remitente.
 * A partir de ahí se ejecuta solo cada 10 minutos (procesarBuzon).
 */

const CONFIG = {
  ROOT_FOLDER_ID: '1tAwUT9pAYGddPMWWFcbIswyVPfy2tzcr', // carpeta "Buscaflor" actual de Drive
  ALERT_EMAIL: 'diazjavierme@gmail.com',              // dónde te llegan los avisos
  // Direcciones propias desde las que puedes enviar documentación en "modo vuelo"
  PROPIOS: ['diazjavierme@gmail.com', 'expansion@rosasdebuscaflor.com', 'facturasbuscaflor@gmail.com'],
  TIMEZONE: 'Europe/Madrid',
  SEARCH_QUERY: 'newer_than:3d -in:sent -in:chats',
  MAX_THREADS: 100,
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,
  MAX_GEMINI_CALLS: 20,
  GEMINI_MODEL: 'gemini-flash-latest',
  CLAUDE_MODEL: 'claude-haiku-5-5',
  MIN_IMAGE_BYTES: 40 * 1024, // imágenes más pequeñas = logos de firma, se ignoran
  REGISTRO_NAME: 'Buzón Buscaflor - Registro'
};

const FOLDERS = {
  REGISTRO: '00 Registro',
  IMPORTACION: '01 Importación',
  PAGOS: '02 Pagos exterior',
  EECC_FINCAS: '03 Estados de cuenta fincas',
  GASTOS_ES: '04 Gastos España',
  VENTAS: '05 Ventas y clientes',
  PERSONAL: '06 Personal',
  EMPRESA: '07 Empresa',
  PENDIENTE: '_Pendiente de clasificar',
  SIN_VUELO: '_Sin vuelo asignado',
  SUBIR_PAGOS: '_Subir aquí',
  REVISAR_PAGOS: '_Revisar'
};

// Fincas y transitarios tal como los llama Javier + razones sociales que aparecen en el papel
const FINCAS = ['Benchmark Growers', 'Floricola Rosalinda', 'Floranrosa', 'Monterosas', 'Grupo Cantiza',
  'Cantiza Flores', 'Cantiza Growers', 'Valthomig',
  'Plazoleta Bazzani', 'Much Flowers', 'Luz of Roses', 'Rosaprima', 'Native', 'The Farm Direct', 'El Milagro',
  'Valleverde', 'Solpacific', 'Verdes la Estación', 'C.I. Andean Fields', 'Agrinag', 'Yanez Chancusig',
  'Surandina', 'Kaizen', 'Inorflowers', 'Ilusiones', 'Quimbiamba', 'Natuflor',
  'Kuehne+Nagel', 'Saftec', 'Logike', 'INVOS', 'Ecuador Cargo', 'Vallinoto Cargo'];
const ALIAS_INICIALES = [
  ['Zipp Growers', 'Plazoleta Bazzani'],
  ['Comercializadora AMN Almanti', 'Much Flowers'],
  ['Almanti', 'Much Flowers'],
  ['Cantiza Flores', 'Grupo Cantiza'],
  ['Valthomig', 'Grupo Cantiza'],
  ['Natuflor', 'Agrinag'],
  ['Calinama', 'Native']
];

// Beneficiarios de transferencias cuyo nombre no coincide con la finca
const ALIAS_PAGOS = [
  ['Yanez Chicaiza', 'Luz of Roses'],
  ['Servicios Aereos Ecuatorianos', 'Saftec'],
  ['Logike Cargo', 'Logike'],
  ['Invos Flowers', 'INVOS'],
  ['Ermesplutarco Lara', 'Rosalinda'],                 // titular de la cuenta de Floricola Rosalinda
  ['Solpacific', 'Valleverde'],                        // cuenta de cobro de Valleverde Farms
  ['International Flower Holding', 'Much Flowers']     // cuenta de cobro de Much Flowers (Tumbaco, Ecuador)
];

const TIPOS = ['ESPAÑA', 'FINCA', 'TRANSITARIO', 'TPV', 'OTROS', 'PUBLICIDAD', 'IGNORAR', 'PENDIENTE'];

const LABELS = {
  'ESPAÑA': 'Buzón/Facturas España',
  'FINCA': 'Buzón/Fincas',
  'TRANSITARIO': 'Buzón/Transitarios',
  'TPV': 'Buzón/Tickets TPV',
  'OTROS': 'Buzón/Otros',
  'PUBLICIDAD': 'Buzón/Publicidad',
  'PENDIENTE': 'Buzón/Pendiente',
  'ATENCION': 'Buzón/Atención',
  'REVISAR': 'Buzón/Revisar'
};

const ALERTA_REGEX = new RegExp([
  'requerimiento', 'notificaci[oó]n (electr[oó]nica|administrativa|oficial)', 'nueva notificaci[oó]n', 'agencia tributaria', '\\baeat\\b', 'hacienda',
  'seguridad social', '\\btgss\\b', 'juzgado', 'tribunal', 'embargo', 'impago', 'apremio',
  'reclamaci[oó]n', 'sanci[oó]n', 'providencia', 'dehu', 'burofax', 'demanda',
  'overdue', 'past due', 'payment reminder', 'final notice'
].join('|'), 'i');

const EECC_REGEX = /statement|estados? de cuenta|estado de cartera|account balance|saldo pendiente|situaci[oó]n de facturas|facturas pendientes|relaci[oó]n de facturas|extracto de cuenta|cartera pendiente|recordatorio de pago|payment reminder/i;
// Nombres de archivo que ya dicen que son factura: no hace falta preguntar a la IA
const FACTURA_NOMBRE = /fac|invoice|\bfra\b|fv|^f\d|\bf\d|ticket|recibo|abono|albar/i;

/**
 * Lector de un PDF con IA, UNA sola vez por documento (se pide solo si hace falta):
 * devuelve {tipo: FACTURA|ESTADO_CUENTA|OTRO, fecha: 'AAAA-MM-DD' de emisión} o null.
 */
function lectorDoc_(blobFn, ctx) {
  let r;
  return () => {
    if (r !== undefined) return r;
    if (ctx && ctx.llamadasGemini >= CONFIG.MAX_GEMINI_CALLS) return (r = null);
    if (ctx) ctx.llamadasGemini++;
    const blob = blobFn();
    const mime = String(blob.getContentType() || '').toLowerCase();
    const mimeIA = /pdf/.test(mime) ? 'application/pdf' : /jpe?g/.test(mime) ? 'image/jpeg' : /png/.test(mime) ? 'image/png' : '';
    if (!mimeIA) return (r = null);                             // HEIC, Excel…: la IA no lo puede leer
    r = iaJson_('Documento (PDF o foto) recibido por una empresa española. Responde SOLO JSON: ' +
      '{"tipo":"FACTURA|ESTADO_CUENTA|JUSTIFICANTE|OTRO","fecha":"AAAA-MM-DD","emisor":"","cliente":"","para_buscaflor":true|false,"de_buscaflor":true|false,"inmueble":""}. ' +
      'JUSTIFICANTE = justificante o detalle de UN pago o cargo bancario concreto (transferencia, recibo domiciliado, pago de tributos o impuestos, ' +
      '"detalle del movimiento" del banco); no es un extracto con muchos movimientos. ' +
      'inmueble = si el documento es de un inmueble concreto (IBI, comunidad de propietarios, agua, luz, basura, seguro de hogar, alquiler, notaría…), ' +
      'su dirección completa y su referencia catastral si aparece (ej. "AV DE LA MUSICA 8 BL 2 CHIPIONA · 0749102QA3604H0028SJ"); vacío si no es de un inmueble. ' +
      'emisor = quien EMITE el documento; cliente = a nombre de quién va. para_buscaflor = true solo si el cliente/destinatario es ' +
      'ROSAS DE BUSCAFLOR LA MEJOR (CIF B91821579); de_buscaflor = true si quien la emite es ROSAS DE BUSCAFLOR (una factura de venta nuestra). ' +
      'ESTADO_CUENTA = estado de cuenta, extracto, listado o relación de facturas pendientes de pago, recordatorio de saldo. ' +
      'FACTURA = una factura, abono o ticket concreto. fecha = fecha de EMISIÓN de la factura (no la de vencimiento ni la de los albaranes); ' +
      'vacío si no es una factura o no se ve.', blob, mimeIA, 400) || null;
    return r;
  };
}

/**
 * Remitentes de tipo OTROS (gestoría, bancos, clientes…) que a veces mandan una FACTURA a nombre de Buscaflor:
 * esa factura es un gasto y se archiva como las de proveedores españoles (04 Gastos España, por fecha de factura).
 * No cuenta si va a nombre de otra empresa (p. ej. Casana House) ni si es una factura de venta nuestra que nos reenvían.
 */
function tipoDeArchivo_(tipo, nombre, asunto, esEecc, leer) {
  if (tipo !== 'OTROS' || esEecc || !/\.pdf$/i.test(nombre) || NOMINA_REGEX.test(nombre + ' ' + asunto)) return tipo;
  const r = leer();
  return (r && r.tipo === 'FACTURA' && r.para_buscaflor === true && r.de_buscaflor !== true) ? 'ESPAÑA' : tipo;
}

/**
 * ¿Es un estado de cuenta / listado de facturas pendientes y no una factura?
 * Por el nombre o el asunto; si el PDF de un proveedor no tiene nombre de factura (p. ej. "listfa21.pdf"), lo mira la IA.
 */
function esEstadoCuenta_(nombre, asunto, tipo, leer) {
  if (EECC_REGEX.test(nombre) || EECC_REGEX.test(asunto)) return true;
  if (['ESPAÑA', 'FINCA', 'TRANSITARIO'].indexOf(tipo) < 0 || !/\.pdf$/i.test(nombre) || FACTURA_NOMBRE.test(nombre)) return false;
  const r = leer();
  return !!(r && r.tipo === 'ESTADO_CUENTA');
}

/**
 * Fecha con la que se ARCHIVA una factura de proveedor español: la de la factura, no la del correo.
 * (La factura de septiembre que llega el 1 de octubre va al T3 / 2026-09, que es donde la busca la gestoría.)
 * 1º una fecha en el nombre del archivo; 2º la lee la IA en el PDF. Si no es fiable, la fecha del correo.
 */
function fechaFactura_(nombre, fechaCorreo, tipo, leer) {
  if (tipo !== 'ESPAÑA') return fechaCorreo;
  const valida = d => d && !isNaN(d) && d.getTime() <= fechaCorreo.getTime() + 864e5 && fechaCorreo.getTime() - d.getTime() <= 400 * 864e5;
  const m = String(nombre).match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/);
  if (m) { const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12); if (valida(d)) return d; }
  if (!/\.pdf$/i.test(nombre)) return fechaCorreo;
  const r = leer();
  const f = r && r.tipo === 'FACTURA' && /^\d{4}-\d{2}-\d{2}$/.test(r.fecha || '') ? r.fecha.split('-').map(Number) : null;
  if (f) { const d = new Date(f[0], f[1] - 1, f[2], 12); if (valida(d)) return d; }
  return fechaCorreo;
}
// Correos que llegan desde la cuenta de Casana House: pueden traer facturas de Buscaflor o de Casana.
// Cada factura se archiva según a nombre de quién va (lo lee la IA); si no se puede saber, a 07 Empresa / _Entrada para revisar.
const CASANA = {
  REMITENTES: ['casanahousesl@gmail.com'],
  RX: /casana/i,
  CARPETA: ['09 Casana House', 'Facturas']          // + AAAA / AAAA-MM (fecha de la factura)
};
const AWB_REGEX = /\b(0?75|729)[-\s]?(\d{4})[-\s]?(\d{4})\b/g;  // 075-68080902, 075-6808 0902, 075-6808-0902 · 729-95837276 (K+N por otra aerolínea)
const EXT_OK = /\.(pdf|xml|xlsx?|csv|jpe?g|png)$/i;

// ─────────────────────────────── SETUP ───────────────────────────────

function setup() {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  Object.values(FOLDERS).slice(0, 8).forEach(n => getOrCreateFolder_(root, n));
  getOrCreatePath_([FOLDERS.REGISTRO, FOLDERS.PENDIENTE]);
  getOrCreatePath_([FOLDERS.PAGOS, FOLDERS.SUBIR_PAGOS]);

  const ss = getRegistro_();
  prepararHojas_(ss);

  GmailApp.getUserLabelByName('Buzón') || GmailApp.createLabel('Buzón');
  Object.values(LABELS).forEach(l => GmailApp.getUserLabelByName(l) || GmailApp.createLabel(l));

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'procesarBuzon')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('procesarBuzon').timeBased().everyMinutes(10).create();

  Logger.log('Listo. Registro: ' + ss.getUrl());
}

function prepararHojas_(ss) {
  const defs = {
    'Remitentes': ['Remitente (email o @dominio)', 'Tipo', 'Proveedor', 'Ejemplo de asunto', 'Visto por primera vez', 'Nº correos'],
    'Archivos': ['Fecha correo', 'Remitente', 'Proveedor', 'Tipo', 'AWB', 'Archivo', 'Carpeta', 'Enlace', 'MD5', 'MessageId', 'FileId'],
    'Avisos': ['Fecha', 'Remitente', 'Asunto', 'Motivo', 'Enlace correo'],
    'Procesados': ['MessageId', 'Fecha proceso'],
    'Pagos exterior': ['Fecha pago', 'Tipo', 'Finca', 'Beneficiario (según justificante)', 'Importe', 'Moneda', 'Archivo', 'Enlace', 'MD5', 'Procesado'].concat(PAGOS_COLS),
    'Alias fincas': ['Nombre en el papel / banco', 'Nombre Buscaflor']
  };
  Object.keys(defs).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(defs[name]);
      sh.getRange(1, 1, 1, defs[name].length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  const al = ss.getSheetByName('Alias fincas');
  if (al.getLastRow() === 1) al.getRange(2, 1, ALIAS_INICIALES.length, 2).setValues(ALIAS_INICIALES);
  const rem = ss.getSheetByName('Remitentes');
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(TIPOS, true).build();
  rem.getRange('B2:B2000').setDataValidation(rule);
  const def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
}

// ─────────────────────────── INMUEBLES ───────────────────────────
// Cada inmueble tiene su carpeta en 07 Empresa / Inmuebles y alquileres / <Inmueble> / <año>. Los gastos que son de un inmueble
// (IBI, comunidad, agua, luz, basura, seguro…) se guardan como siempre en 04 Gastos España (para la gestoría) y, además, con un
// ACCESO en la carpeta del año de su inmueble. Así cada nave y el piso tienen todos sus gastos juntos.
// Hoja "Inmuebles" del registro: Inmueble (nombre de la carpeta) | Claves (dirección, referencia catastral, nombre…, separadas por ;)
const INMUEBLES_CARPETA = [FOLDERS.EMPRESA, 'Inmuebles y alquileres'];
const INMUEBLES_INICIALES = [
  ['Piso Costa Ballena', 'AV DE LA MUSICA 8;AVENIDA DE LA MUSICA 8;0749102QA3604H0028SJ;COSTA BALLENA;AMENABAR'],
  ['Nave 22, calle 9', ''],
  ['Nave 7, calle 10 Aluminios', ''],
  ['Casa Bellavista', ''],
  ['Local bermejales', '']
];

function normInm_(t) {
  return String(t || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
}

function hojaInmuebles_() {
  const ss = getRegistro_();
  let sh = ss.getSheetByName('Inmuebles');
  if (!sh) {
    sh = ss.insertSheet('Inmuebles');
    sh.appendRow(['Inmueble (carpeta en 07 Empresa / Inmuebles y alquileres)', 'Claves: dirección, ref. catastral, nombre… (separadas por ;)']);
    sh.getRange(1, 1, 1, 2).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, INMUEBLES_INICIALES.length, 2).setValues(INMUEBLES_INICIALES);
  }
  return sh;
}

/** Inmueble al que pertenece un documento, por su dirección / ref. catastral (leída por la IA) o por el texto del correo. */
let _inmuebles = null;
function inmuebleDe_(textoIA, textoCorreo) {
  if (!_inmuebles) {
    const sh = hojaInmuebles_();
    _inmuebles = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  }
  const filas = _inmuebles;
  const a = normInm_(textoIA), b = normInm_(textoCorreo);
  for (const [nombre, claves] of filas) {
    if (!nombre) continue;
    const ks = String(claves || '').split(';').map(normInm_).filter(k => k.length >= 5);
    if (ks.some(k => (a && a.indexOf(k) >= 0) || (b && b.indexOf(k) >= 0))) return String(nombre).trim();
  }
  return '';
}

function accesoInmueble_(file, leer, textoCorreo, fecha) {
  const r = leer ? leer() : null;
  const inm = inmuebleDe_(r && r.inmueble, textoCorreo);
  if (!inm) return '';
  const carpeta = getOrCreatePath_(INMUEBLES_CARPETA.concat([inm, fmt_(fecha || new Date(), 'yyyy')]));
  if (carpeta.getFilesByName(file.getName()).hasNext()) return inm;
  const sc = DriveApp.createShortcut(file.getId());
  sc.moveTo(carpeta);
  sc.setName(file.getName());
  Logger.log('Inmueble ' + inm + ': ' + file.getName());
  return inm;
}

/** UNA VEZ: pone en la carpeta de su inmueble documentos ya guardados (id de Drive → inmueble). */
const INMUEBLE_MANUAL = [
  ['1eHnFKG13KhmOFlN7HJM0M3p4bNu4G09z', 'Piso Costa Ballena'],    // IBI Chipiona 2026, 667,10 €
  ['1bCX7a1hNI80ZefnPKlhl-xFGJkUE6RyZ', 'Piso Costa Ballena']     // pago del IBI (CaixaBank, 29-10-2026)
];
// Justificantes guardados en un sitio equivocado: [id del pago, id del gasto] → el pago pasa a la carpeta del gasto
const PAGO_JUNTO_A_GASTO = [
  ['1bCX7a1hNI80ZefnPKlhl-xFGJkUE6RyZ', '1eHnFKG13KhmOFlN7HJM0M3p4bNu4G09z']   // pago IBI → junto al IBI (04 Gastos España / 2026-10)
];
function colocarInmuebles() {
  hojaInmuebles_();
  PAGO_JUNTO_A_GASTO.forEach(([idPago, idGasto]) => {
    try {
      const pago = DriveApp.getFileById(idPago);
      const destino = DriveApp.getFileById(idGasto).getParents().next();
      const antes = pago.getParents().hasNext() ? pago.getParents().next() : null;
      if (antes && antes.getId() === destino.getId()) { Logger.log('El pago ya estaba junto al gasto: ' + pago.getName()); return; }
      pago.moveTo(destino);
      Logger.log('Pago movido junto al gasto: ' + pago.getName());
      // la carpeta donde estaba (p. ej. "Estados de cuenta / Reenvío expansion") se borra si se ha quedado vacía
      if (antes && !antes.getFiles().hasNext() && !antes.getFolders().hasNext()) antes.setTrashed(true);
    } catch (e) { Logger.log('Pago ' + idPago + ': ' + e); }
  });
  INMUEBLE_MANUAL.forEach(([id, inm]) => {
    const f = DriveApp.getFileById(id);
    const carpeta = getOrCreatePath_(INMUEBLES_CARPETA.concat([inm, fmt_(f.getDateCreated(), 'yyyy')]));
    if (carpeta.getFilesByName(f.getName()).hasNext()) { Logger.log('Ya estaba: ' + f.getName()); return; }
    const sc = DriveApp.createShortcut(id);
    sc.moveTo(carpeta);
    sc.setName(f.getName());
    Logger.log('Acceso creado en ' + INMUEBLES_CARPETA.concat([inm]).join(' / ') + ': ' + f.getName());
  });
}

// ─────────────────────── ESTADOS DE CUENTA: ¿TENEMOS TODAS LAS FACTURAS? ───────────────────────
// Cuando un proveedor español manda su estado de cuenta / listado de pendientes, la IA saca las facturas que lista
// y se buscan en Drive: 1º por el nombre del archivo (proveedor + número), 2º dentro de los PDF (número + proveedor).
// Te llega un correo con las que NO están, para pedírselas. Si están todas, también te avisa (una línea).
const EECC_PALABRAS_GENERICAS = /^(FLORES?|HNOS|HERMANOS|GRUPO|SOCIEDAD|LIMITADA|DISTRIBUCIONES|COMERCIAL|CORTADA|ESPANA|SEVILLA|SERVICIOS)$/;

/** Palabra que identifica al proveedor en nombres y PDF ("Hnos. Palacios" → PALACIOS, "Flores Caoba" → CAOBA). */
function claveProveedor_(proveedor) {
  const ws = normInm_(proveedor).split(' ').filter(w => w.length >= 4 && !EECC_PALABRAS_GENERICAS.test(w));
  return ws.sort((a, b) => b.length - a.length)[0] || '';
}

/** Número de factura comparable: el grupo de cifras más largo ("2702/26" → 2702, "A26/17301" → 17301). */
function numFactura_(n) {
  const g = String(n || '').match(/\d+/g) || [];
  return g.sort((a, b) => b.length - a.length)[0] || '';
}

/** ¿Algún grupo de cifras del nombre es ese número? (F600002370 vale para 2370; 2370 sola necesita 4+ cifras) */
function nombreTieneNumero_(nombre, num) {
  const n = num.replace(/^0+/, '');
  if (n.length < 3) return false;
  return (String(nombre).match(/\d+/g) || []).some(g => {
    const x = g.replace(/^0+/, '');
    return x === n || (n.length >= 4 && x.length > n.length && x.slice(-n.length) === n);
  });
}

// Resultado de cada revisión de estado de cuenta: pestaña "Estados de cuenta" del registro (una fila por proveedor,
// se sustituye en cada revisión). Por ahora NO manda correo: pon EECC_EMAIL = true cuando esté afinado.
const EECC_EMAIL = false;
function informeEstadoCuenta_(file, asunto, cuerpo) {
  const prov = asunto.replace(/^\[Buzón Buscaflor\] Estado de cuenta /, '').split(':')[0].trim();
  const resumen = asunto.split(':').slice(1).join(':').trim();
  try {
    const ss = getRegistro_();
    let sh = ss.getSheetByName('Estados de cuenta');
    if (!sh) {
      sh = ss.insertSheet('Estados de cuenta');
      sh.appendRow(['Revisado', 'Proveedor', 'Resumen', 'Estado de cuenta', 'Detalle']);
      sh.getRange(1, 1, 1, 5).setFontWeight('bold'); sh.setFrozenRows(1); sh.setColumnWidth(5, 700);
    }
    const fila = [new Date(), prov, resumen, file.getUrl(), cuerpo.slice(0, 45000)];
    const n = sh.getLastRow() - 1;
    const provs = n > 0 ? sh.getRange(2, 2, n, 1).getValues().map(r => String(r[0])) : [];
    const i = provs.indexOf(prov);
    if (i >= 0) sh.getRange(i + 2, 1, 1, 5).setValues([fila]); else sh.appendRow(fila);
    sh.getRange(2, 5, Math.max(1, sh.getLastRow() - 1), 1).setWrap(true);
  } catch (e) { Logger.log('Informe estado de cuenta: ' + e); }
  if (EECC_EMAIL) { try { MailApp.sendEmail(CONFIG.ALERT_EMAIL, asunto, cuerpo); } catch (e) { Logger.log('Aviso estado de cuenta: ' + e); } }
}

/** La IA saca las facturas del estado de cuenta → { proveedor, facturas: [{numero, fecha, importe, pendiente}] } */
function leerEstadoCuenta_(file) {
  const d = iaJson_('Estado de cuenta o listado de facturas de un proveedor a ROSAS DE BUSCAFLOR LA MEJOR. ' +
    'Responde SOLO JSON: {"proveedor":"","moneda":"USD|EUR","facturas":[{"numero":"tal como aparece","fecha":"AAAA-MM-DD","importe":0,"pendiente":0}]}. ' +
    'Incluye TODAS las facturas listadas (no los pagos, abonos de pago ni totales). importe = el importe de ESA factura sola ' +
    '(columna "INVOICE", "Importe", "Amount"), NUNCA la columna acumulada ("CUMULATIVE", "Saldo", "Balance") que va sumando las anteriores; ' +
    'pendiente = lo que queda por pagar de esa factura si el documento lo dice (si no, igual que importe). Números con punto decimal.',
    file.getBlob(), file.getMimeType(), 4000);
  if (d && Array.isArray(d.facturas)) d.facturas = d.facturas.filter(f => numFactura_(f.numero));
  return d && d.facturas && d.facturas.length ? d : null;
}

/** Guía del vuelo por las carpetas donde está el archivo ("AWB 075-68079546 · Logike" → 075-68079546); '' si no. */
function awbDeCarpetas_(f) {
  let it = f.getParents();
  for (let nivel = 0; nivel < 5 && it.hasNext(); nivel++) {
    const c = it.next(), m = c.getName().match(/AWB\s+(\d{3}-\d{8})/);
    if (m) return m[1];
    it = c.getParents();
  }
  const m = f.getName().match(/(\d{3})[-\s]?(\d{4})[-\s]?(\d{4})/);
  return m && /^(075|729)$/.test(m[1]) ? m[1] + '-' + m[2] + m[3] : '';
}

/** Mismo número de factura ("001001-FAC17636" = "FAC17636" = "17636"; "001038405" = "1038405") */
function mismoNumero_(a, b) {
  const x = numFactura_(a).replace(/^0+/, ''), y = numFactura_(b).replace(/^0+/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const [c, l] = x.length < y.length ? [x, y] : [y, x];
  return c.length >= 4 && l.slice(-c.length) === c;
}

/**
 * Estado de cuenta de una FINCA o TRANSITARIO del exterior: se compara con "01 Importación / Por proveedor / <proveedor>"
 * (Pendientes de pago y Pagadas; en Grupo Cantiza, las tres empresas). Te llega un correo con:
 *   · las facturas del estado de cuenta que NO tenemos  → pedírselas
 *   · las que tenemos en "Pagadas" y el proveedor aún da como pendientes → revisar el pago
 *   · las que tenemos en "Pendientes de pago" y el proveedor ya no lista → quizá ya están pagadas
 *   · las que no cuadran de importe
 */
function comprobarEstadoCuentaExterior_(file, proveedor, tipo) {
  const d = leerEstadoCuenta_(file);
  if (!d) { Logger.log('Estado de cuenta sin facturas legibles: ' + file.getName()); return null; }
  const nombreProv = tipo === 'TRANSITARIO' ? nombreTransitario_(d.proveedor || proveedor) : nombreProveedor_(d.proveedor || proveedor);
  const carpeta = carpetaProveedorPago_(nombreProv, proveedor);
  if (!carpeta) { Logger.log('Estado de cuenta: ' + proveedor + ' no tiene carpeta en Por proveedor'); return null; }
  const sub = (c, n) => { const it = c.getFoldersByName(n); return it.hasNext() ? it.next() : null; };
  const bases = [carpeta];
  if (typeof GRUPOS_EMPRESAS !== 'undefined' && GRUPOS_EMPRESAS[carpeta.getName()])
    GRUPOS_EMPRESAS[carpeta.getName()].forEach(e => { const c = sub(carpeta, e.nombre); if (c) bases.push(c); });
  let nuestras = [];
  bases.forEach(b => {
    const p = sub(b, 'Pendientes de pago'), g = sub(b, 'Pagadas');
    nuestras = nuestras.concat(p ? facturasDeCarpeta_(p, false) : [], g ? facturasDeCarpeta_(g, true) : []);
  });
  nuestras = nuestras.filter(x => x.num);

  const faltan = [], pagadasPendientes = [], difImporte = [], usadas = [], movidasPagadas = [];
  const pendDe = fa => Number(fa.pendiente != null && fa.pendiente !== '' ? fa.pendiente : fa.importe) || 0;
  // pagada según el proveedor: pendiente 0, o un resto mínimo (comisión bancaria: ≤ 1 % de la factura y ≤ 25)
  const pagadaSegunProv = fa => fa.pendiente != null && fa.pendiente !== '' &&
    Number(fa.pendiente) <= Math.max(0.5, Math.min(25, 0.01 * (Number(fa.importe) || 0)));
  d.facturas.forEach(fa => {
    let m = nuestras.find(x => usadas.indexOf(x) < 0 && mismoNumero_(x.num, fa.numero));
    // otra numeración en el estado de cuenta (p. ej. Monterosas): misma fecha y mismo importe, si solo hay una así
    if (!m && fa.fecha && Number(fa.importe)) {
      const c = nuestras.filter(x => usadas.indexOf(x) < 0 && x.fecha === fa.fecha && Math.abs(x.importe - Number(fa.importe)) <= 0.5);
      if (c.length === 1) m = c[0];
    }
    if (!m) { faltan.push(fa); return; }
    usadas.push(m);
    if (m.pagada && pendDe(fa) > 0.5) pagadasPendientes.push({ fa: fa, m: m });
    // el proveedor la da como PAGADA y la teníamos en "Pendientes de pago": pasa a "Pagadas"
    if (!m.pagada && pagadaSegunProv(fa)) {
      try {
        const base = m.file.getParents().next().getParents().next();
        const it = base.getFoldersByName('Pagadas');
        m.file.moveTo(it.hasNext() ? it.next() : base.createFolder('Pagadas'));
        m.pagada = true; movidasPagadas.push({ fa: fa, m: m });
      } catch (e) { Logger.log('No se pudo pasar a Pagadas ' + m.file.getName() + ': ' + e); }
    }
    if (Number(fa.importe) && Math.abs(Number(fa.importe) - m.importe) > 0.5) difImporte.push({ fa: fa, m: m });
  });
  // pendientes nuestras que el proveedor no lista (solo de fechas que el estado de cuenta cubre)
  const fechas = d.facturas.map(f => String(f.fecha || '')).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
  const desde = fechas[0] || '', hasta = fechas[fechas.length - 1] || '';
  const noLista = nuestras.filter(x => !x.pagada && usadas.indexOf(x) < 0 && desde && x.fecha >= desde && x.fecha <= hasta);

  // Las que no están en "Por proveedor" se buscan en todo Drive (facturas de vuelos anteriores a "Por proveedor"):
  // si aparecen, se les crea su acceso en "Pendientes de pago" y ya no se piden.
  //  · la FACTURA tiene el número en su nombre; si el número solo aparece DENTRO de otro PDF, ese PDF no es la factura:
  //      - si es un justificante nuestro ("pago …", "PAGO_…", transferencia) → según nosotros está PAGADA
  //      - si no (otro estado de cuenta, un listado…) → la factura sigue faltando
  const recuperadas = [], sinAcceso = [], enPago = [];
  let docs = null;
  const esPagoNombre = n => /(^|[_\s-])pago|transfer|justificante|swift|remesa/i.test(n);
  const tieneAcceso = num => {
    try {
      const q = DriveApp.searchFiles('title contains "' + num + '" and mimeType = "application/vnd.google-apps.shortcut" and trashed = false');
      while (q.hasNext()) { if (/· Fra /.test(q.next().getName())) return true; }
    } catch (e) {}
    return false;
  };
  const todas = faltan.splice(0);
  todas.forEach(fa => {
    const num = numFactura_(fa.numero);
    let f = null, pago = null;
    try {
      const q = DriveApp.searchFiles('(title contains "' + num + '" or fullText contains "' + num + '") and mimeType = "application/pdf" and trashed = false');
      while (q.hasNext()) {
        const x = q.next(), n = x.getName();
        if (x.getId() === file.getId() || EECC_REGEX.test(n) || /listfa|listado|eecc|statement/i.test(n)) continue;
        if (nombreTieneNumero_(n, num)) { f = x; break; }               // la factura
        if (!pago && esPagoNombre(n)) pago = x;                         // un justificante que la menciona
      }
    } catch (e) {}
    if (!f) { if (pago) enPago.push({ fa: fa, f: pago }); else faltan.push(fa); return; }
    try {
      if (!docs && typeof cargarDocs_ === 'function') docs = cargarDocs_();
      let doc = docs && docs[f.getId()];
      const util = x => x && x.awb && (x.tipo === 'FINCA' || x.tipo === 'FLETE') && x.data && (x.data.finca || x.data.transitario) && x.data.numero;
      if (!util(doc)) {
        const r = typeof leerFacturaLigera_ === 'function' ? leerFacturaLigera_(f) : null;
        // si la IA no ve la guía en el PDF, se saca de la carpeta del vuelo donde está ("AWB 075-xxxxxxxx …")
        const awb = (r && r.awb) || awbDeCarpetas_(f);
        if (awb) {
          const esFlete = tipo === 'TRANSITARIO' || (r && r._tipo === 'FLETE');
          const data = (r && (r._tipo === 'FINCA' || r._tipo === 'FLETE')) ? r
            : (esFlete ? { _tipo: 'FLETE', transitario: carpeta.getName(), numero: fa.numero, fecha: fa.fecha, flete_usd: Number(fa.importe) || 0 }
                       : { _tipo: 'FINCA', finca: d.proveedor || proveedor, numero: fa.numero, fecha: fa.fecha, total_usd: Number(fa.importe) || 0 });
          if (!data.numero) data.numero = num;
          if (!data.finca && !esFlete) data.finca = d.proveedor || proveedor;
          data.awb = awb;
          doc = { awb: awb, tipo: esFlete ? 'FLETE' : 'FINCA', data: data, nombre: f.getName() };
          if (typeof guardarDoc_ === 'function') guardarDoc_(f, awb, doc);
        }
      }
      // si el proveedor ya la da como pagada, el acceso va directo a "Pagadas"
      if (util(doc) && typeof crearAccesoPago_ === 'function') crearAccesoPago_(f, doc, pagadaSegunProv(fa) ? 'Pagadas' : '');
      if (tieneAcceso(num)) recuperadas.push({ fa: fa, f: f, pagada: pagadaSegunProv(fa) });   // solo si el acceso existe de verdad
      else sinAcceso.push({ fa: fa, f: f });
    } catch (e) { Logger.log('Acceso de ' + f.getName() + ': ' + e); sinAcceso.push({ fa: fa, f: f }); }
  });

  const mon = d.moneda || 'USD';
  const imp = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' ' + mon;
  const linea = f => '  · ' + f.numero + ' · ' + (f.fecha || '') + ' · ' + imp(f.importe);
  let cuerpo = 'Estado de cuenta: ' + file.getName() + '\n' + file.getUrl() + '\n' +
    'Comparado con: 01 Importación / Por proveedor / ' + carpeta.getName() + '\n\n';
  if (faltan.length) cuerpo += 'NO TENEMOS estas facturas (pídeselas):\n' + faltan.map(linea).join('\n') +
    '\n  Total: ' + imp(faltan.reduce((a, f) => a + (Number(f.importe) || 0), 0)) + '\n\n';
  if (recuperadas.length) cuerpo += 'Estaban en Drive pero sin acceso en "Por proveedor" (ya lo he creado):\n' +
    recuperadas.map(x => linea(x.fa) + ' → ' + x.f.getName() + (x.pagada ? '  [en Pagadas: el proveedor la da como pagada]' : '  [en Pendientes de pago]')).join('\n') + '\n\n';
  if (movidasPagadas.length) cuerpo += 'El proveedor las da como PAGADAS y las teníamos en Pendientes de pago (ya las he pasado a Pagadas):\n' +
    movidasPagadas.map(x => linea(x.fa)).join('\n') + '\n\n';
  if (sinAcceso.length) cuerpo += 'Están en Drive pero no he podido leer su guía para crearles el acceso (míralas tú):\n' +
    sinAcceso.map(x => linea(x.fa) + ' → ' + x.f.getName() + ' · ' + x.f.getUrl()).join('\n') + '\n\n';
  if (enPago.length) cuerpo += 'No tenemos la factura, pero SÍ un justificante de pago nuestro que la incluye (el proveedor aún la da como pendiente):\n' +
    enPago.map(x => linea(x.fa) + ' → ' + x.f.getName()).join('\n') + '\n\n';
  if (pagadasPendientes.length) cuerpo += 'Las tenemos en PAGADAS pero el proveedor las da como pendientes (revisa el pago):\n' +
    pagadasPendientes.map(x => linea(x.fa)).join('\n') + '\n\n';
  if (difImporte.length) cuerpo += 'Importe distinto (estado de cuenta → nuestra factura):\n' +
    difImporte.map(x => '  · ' + x.fa.numero + ': ' + imp(x.fa.importe) + ' → ' + imp(x.m.importe)).join('\n') + '\n\n';
  if (noLista.length) cuerpo += 'Las tenemos en PENDIENTES DE PAGO pero el proveedor no las lista (¿ya pagadas?):\n' +
    noLista.map(x => '  · ' + x.num + ' · ' + x.fecha + ' · ' + imp(x.importe)).join('\n') + '\n\n';
  const todoBien = !faltan.length && !sinAcceso.length && !enPago.length && !pagadasPendientes.length && !difImporte.length && !noLista.length;
  if (todoBien) cuerpo += 'Todo cuadra: tenemos las ' + d.facturas.length + ' facturas que lista y con el mismo importe.\n';
  const asunto = '[Buzón Buscaflor] Estado de cuenta ' + carpeta.getName() + ': ' + (todoBien ? 'cuadra' + (recuperadas.length || movidasPagadas.length ? ' (' + (recuperadas.length + movidasPagadas.length) + ' accesos colocados)' : '') :
    [faltan.length ? 'faltan ' + faltan.length : '', recuperadas.length ? recuperadas.length + ' accesos creados' : '', movidasPagadas.length ? movidasPagadas.length + ' pasadas a Pagadas' : '',
     sinAcceso.length ? sinAcceso.length + ' sin acceso' : '', enPago.length ? enPago.length + ' pagadas según nuestro justificante' : '', pagadasPendientes.length ? pagadasPendientes.length + ' pagadas que da pendientes' : '',
     difImporte.length ? difImporte.length + ' con otro importe' : '', noLista.length ? noLista.length + ' que no lista' : '']
      .filter(Boolean).join(' · '));
  informeEstadoCuenta_(file, asunto, cuerpo);
  // Mensaje para el comercial (email y WhatsApp) en "Pendientes de pago" del proveedor
  if (faltan.length || enPago.length || pagadasPendientes.length) {
    try {
      redactarPeticionFacturas_(sub(carpeta, 'Pendientes de pago') || carpeta, carpeta.getName(), file, mon,
        faltan, enPago.map(x => x.fa), pagadasPendientes.map(x => x.fa));
    } catch (e) { Logger.log('Mensaje al proveedor: ' + e); }
  }
  Logger.log(asunto);
  return { faltan: faltan, recuperadas: recuperadas, sinAcceso: sinAcceso, enPago: enPago, pagadasPendientes: pagadasPendientes, difImporte: difImporte, noLista: noLista };
}

function comprobarEstadoCuenta_(file, proveedor) {
  const d = leerEstadoCuenta_(file);
  const lista = d ? d.facturas : [];
  if (!lista.length) { Logger.log('Estado de cuenta sin facturas legibles: ' + file.getName()); return null; }
  const clave = claveProveedor_(proveedor) || claveProveedor_(d.proveedor);
  if (!clave) { Logger.log('Estado de cuenta: no sé qué proveedor es (' + file.getName() + ')'); return null; }

  // archivos de ese proveedor por el nombre (fuera de las carpetas de estados de cuenta)
  const nombres = [];
  const it = DriveApp.searchFiles('title contains "' + clave.toLowerCase() + '" and trashed = false');
  while (it.hasNext()) {
    const f = it.next();
    if (f.getId() === file.getId() || EECC_REGEX.test(f.getName()) || /listfa|listado|eecc/i.test(f.getName())) continue;
    nombres.push(f.getName());
  }
  const faltan = [], tenemos = [];
  lista.forEach(fa => {
    const num = numFactura_(fa.numero);
    let ok = nombres.some(n => nombreTieneNumero_(n, num));
    if (!ok) {   // archivos antiguos sin el proveedor en el nombre (p. ej. "F600002370.PDF"): se busca dentro del PDF
      try {
        const q = DriveApp.searchFiles('fullText contains "' + num + '" and fullText contains "' + clave.toLowerCase() + '" and trashed = false');
        while (q.hasNext()) { const f = q.next(); if (f.getId() !== file.getId() && !EECC_REGEX.test(f.getName()) && !/listfa|listado|eecc/i.test(f.getName())) { ok = true; break; } }
      } catch (e) {}
    }
    (ok ? tenemos : faltan).push(fa);
  });

  const eur = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
  const suma = faltan.reduce((a, f) => a + (Number(f.importe) || 0), 0);
  const asunto = '[Buzón Buscaflor] Estado de cuenta ' + (d.proveedor || proveedor) + ': ' +
    (faltan.length ? 'faltan ' + faltan.length + ' de ' + lista.length + ' facturas' : 'están las ' + lista.length + ' facturas');
  const cuerpo = 'Estado de cuenta: ' + file.getName() + '\n' + file.getUrl() + '\n\n' +
    (faltan.length
      ? 'Estas facturas NO están en Drive (pídeselas al proveedor):\n' +
        faltan.map(f => '  · ' + f.numero + ' · ' + (f.fecha || '') + ' · ' + eur(f.importe)).join('\n') +
        '\n  Total: ' + eur(suma) + '\n\n'
      : 'Tenemos todas las facturas que lista.\n\n') +
    'Encontradas: ' + tenemos.length + ' de ' + lista.length + '.';
  informeEstadoCuenta_(file, asunto, cuerpo);
  if (faltan.length) {
    try {
      const p = file.getParents();
      redactarPeticionFacturas_(p.hasNext() ? p.next() : DriveApp.getRootFolder(), proveedor || d.proveedor, file, 'EUR', faltan, [], []);
    } catch (e) { Logger.log('Mensaje al proveedor: ' + e); }
  }
  Logger.log(asunto);
  return { faltan: faltan, tenemos: tenemos };
}

/**
 * Deja en la carpeta del proveedor un texto listo para copiar y mandar al comercial (email y WhatsApp):
 *   "AAAA-MM-DD · Pedir facturas a <proveedor>.txt"
 * faltan = facturas que no tenemos · pagadas = las que pagamos (tenemos justificante o están en Pagadas)
 * y el proveedor aún da como pendientes. Si ya había uno del mismo día, se sustituye.
 */
function redactarPeticionFacturas_(carpeta, proveedor, eecc, moneda, faltan, enPago, pagadasPend) {
  const imp = n => (Number(n) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (moneda === 'EUR' ? ' €' : ' ' + moneda);
  const fec = f => /^\d{4}-\d{2}-\d{2}$/.test(String(f || '')) ? String(f).slice(8, 10) + '/' + String(f).slice(5, 7) + '/' + String(f).slice(0, 4) : (f || '');
  const linea = f => '- Factura ' + f.numero + (f.fecha ? ' del ' + fec(f.fecha) : '') + ' · ' + imp(f.importe);
  const total = l => imp(l.reduce((a, f) => a + (Number(f.importe) || 0), 0));
  const pagadas = enPago.concat(pagadasPend);
  const hoy = fmt_(new Date(), 'yyyy-MM-dd');
  const fEecc = fmt_(eecc.getDateCreated(), 'dd/MM/yyyy');

  let email = 'Asunto: Rosas de Buscaflor · Facturas pendientes de recibir' + (pagadas.length ? ' y pagos' : '') + '\n\n' +
    'Hola,\n\nGracias por el estado de cuenta del ' + fEecc + '. Al revisarlo con nuestra contabilidad hemos visto lo siguiente:\n\n';
  if (faltan.length) email += 'No hemos recibido estas facturas. ¿Nos las podéis reenviar, por favor?\n' +
    faltan.map(linea).join('\n') + '\nTotal: ' + total(faltan) + '\n\n';
  if (pagadas.length) email += 'Estas facturas nos aparecen como pagadas, pero en vuestro estado de cuenta siguen pendientes. ' +
    'Os adjuntamos los justificantes para que podáis aplicar el pago:\n' + pagadas.map(linea).join('\n') + '\nTotal: ' + total(pagadas) + '\n\n';
  email += 'Muchas gracias.\nUn saludo,\n\nRosas de Buscaflor La Mejor, S.L.';

  let wa = 'Hola, buenas. Revisando vuestro estado de cuenta del ' + fEecc + ':';
  if (faltan.length) wa += '\n\n📄 Nos faltan estas facturas, ¿nos las podéis reenviar?\n' +
    faltan.map(f => '• ' + f.numero + (f.fecha ? ' (' + fec(f.fecha) + ')' : '') + ' ' + imp(f.importe)).join('\n');
  if (pagadas.length) wa += '\n\n✅ Estas ya están pagadas, os mando los justificantes:\n' +
    pagadas.map(f => '• ' + f.numero + ' ' + imp(f.importe)).join('\n');
  wa += '\n\n¡Gracias!';

  const texto = 'PARA ' + String(proveedor).toUpperCase() + ' · estado de cuenta del ' + fEecc + '\n' + eecc.getUrl() + '\n\n' +
    '==================== EMAIL ====================\n\n' + email + '\n\n' +
    '=================== WHATSAPP ===================\n\n' + wa + '\n';
  const nombre = hoy + ' · Pedir facturas a ' + limpiar_(proveedor) + '.txt';
  const viejos = carpeta.getFilesByName(nombre);
  while (viejos.hasNext()) viejos.next().setTrashed(true);
  const f = carpeta.createFile(Utilities.newBlob(texto, 'text/plain', nombre));
  Logger.log('Mensaje para ' + proveedor + ': ' + f.getUrl());
  return f;
}

/** A MANO: comprueba un estado de cuenta que ya está en Drive. Pon su id (de la URL) y el proveedor, y ejecuta. */
// tipo: 'FINCA' o 'TRANSITARIO' (exterior, contra "Por proveedor") o 'ESPAÑA' (contra 04 Gastos España)
const EECC_A_REVISAR = { id: '1tCbxfEEM_NbFmooIQegxM6-_KSK0WjNm', proveedor: 'Benchmark Growers', tipo: 'FINCA' };   // Statement Benchmark (31-10)
function revisarEstadoCuenta() {
  if (!EECC_A_REVISAR.id) { Logger.log('Rellena EECC_A_REVISAR con el id del PDF, el proveedor y el tipo.'); return; }
  const f = DriveApp.getFileById(EECC_A_REVISAR.id);
  const r = EECC_A_REVISAR.tipo === 'ESPAÑA' ? comprobarEstadoCuenta_(f, EECC_A_REVISAR.proveedor)
    : comprobarEstadoCuentaExterior_(f, EECC_A_REVISAR.proveedor, EECC_A_REVISAR.tipo);
  if (r) Logger.log('Faltan: ' + (r.faltan.map(x => x.numero).join(', ') || 'ninguna') + ' · detalle en la pestaña Estados de cuenta del registro.');
}

/**
 * UNA VEZ: revisa TODOS los estados de cuenta ya guardados, solo el MÁS RECIENTE de cada proveedor:
 *   · exterior: 01 Importación / Por proveedor / <proveedor> / (Pendientes de pago | Estados de cuenta)
 *   · España:   04 Gastos España / Estados de cuenta / <proveedor>
 * Te llega un correo por proveedor. Si se corta por tiempo, ejecútala otra vez: sigue por donde iba.
 * Para empezar de cero: ejecuta reiniciarRevisionEstadosCuenta.
 */
function revisarTodosEstadosCuenta() {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const hechos = JSON.parse(props.getProperty('EECC_REVISADOS') || '{}');
  const esEecc = n => EECC_REGEX.test(n) || /listfa|listado|eecc|statement/i.test(n);
  const ultimo = c => {                         // estado de cuenta más reciente de una carpeta
    let mejor = null; const it = c.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (f.getMimeType() === 'application/vnd.google-apps.shortcut' || !/\.(pdf|jpe?g|png)$/i.test(f.getName()) || !esEecc(f.getName())) continue;
      if (!mejor || f.getDateCreated() > mejor.getDateCreated()) mejor = f;
    }
    return mejor;
  };
  const tareas = [];
  // exterior
  const raiz = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor']);
  const provs = raiz.getFolders();
  while (provs.hasNext()) {
    const c = provs.next(), nombre = c.getName();
    const tipo = ['Kuehne+Nagel', 'Saftec', 'Logike'].indexOf(nombre) >= 0 ? 'TRANSITARIO' : 'FINCA';
    let mejor = null;
    ['Pendientes de pago', 'Estados de cuenta'].forEach(s => {
      const it = c.getFoldersByName(s);
      if (it.hasNext()) { const f = ultimo(it.next()); if (f && (!mejor || f.getDateCreated() > mejor.getDateCreated())) mejor = f; }
    });
    if (mejor) tareas.push({ f: mejor, prov: nombre, tipo: tipo });
  }
  // España
  try {
    const es = getOrCreatePath_([FOLDERS.GASTOS_ES, 'Estados de cuenta']).getFolders();
    while (es.hasNext()) { const c = es.next(), f = ultimo(c); if (f) tareas.push({ f: f, prov: c.getName(), tipo: 'ESPAÑA' }); }
  } catch (e) { Logger.log('Estados de cuenta España: ' + e); }

  Logger.log('Estados de cuenta encontrados: ' + tareas.length + ' (ya revisados antes: ' + tareas.filter(t => hechos[t.f.getId()]).length + ')');
  let n = 0;
  for (const t of tareas) {
    if (hechos[t.f.getId()]) continue;
    if (Date.now() - t0 > 4.5 * 60 * 1000) { Logger.log('Se acabó el tiempo: ejecútala otra vez para seguir.'); return; }
    try {
      const r = t.tipo === 'ESPAÑA' ? comprobarEstadoCuenta_(t.f, t.prov) : comprobarEstadoCuentaExterior_(t.f, t.prov, t.tipo);
      Logger.log(t.prov + ' (' + t.f.getName() + '): ' + (r ? 'faltan ' + r.faltan.length : 'no se pudo leer'));
    } catch (e) { Logger.log(t.prov + ': ' + e); }
    hechos[t.f.getId()] = 1; n++;
    props.setProperty('EECC_REVISADOS', JSON.stringify(hechos));
  }
  Logger.log('Hecho: ' + n + ' estados de cuenta revisados ahora. Resultado en la pestaña Estados de cuenta del registro.');
}
function reiniciarRevisionEstadosCuenta() { PropertiesService.getScriptProperties().deleteProperty('EECC_REVISADOS'); }

// ─────────────────────────── PROCESO PRINCIPAL ───────────────────────────

function procesarBuzon() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  const t0 = Date.now();
  try {
    const ctx = cargarContexto_();
    // Justificantes de pago primero: son pocos y rápidos, y así no se quedan sin tiempo
    try { procesarPagosExterior_(t0, 90 * 1000); } catch (e) { Logger.log('Pagos exterior: ' + e); }
    try { recruzarPagos_(false); } catch (e) { Logger.log('Cruce de pagos: ' + e); }
    reprocesarPendientes_(ctx, t0);
    recolocarSinVuelo_(ctx, t0);
    ctx.promos = {};
    GmailApp.search('category:promotions ' + CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS)
      .forEach(th => ctx.promos[th.getId()] = true);

    const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS);
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        if (Date.now() - t0 > CONFIG.MAX_RUNTIME_MS) return guardarContexto_(ctx);
        const id = msg.getId();
        if (ctx.procesados[id]) continue;
        procesarMensaje_(msg, thread, ctx);
        ctx.procesados[id] = true;
        ctx.nuevosProcesados.push([id, new Date()]);
      }
    }
    guardarContexto_(ctx);
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────── JUSTIFICANTES DE PAGO AL EXTERIOR ───────────────────────
/**
 * Suelta los justificantes tal cual los da el banco en "02 Pagos exterior / _Subir aquí".
 * Gemini lee fecha, beneficiario, importe y moneda; el archivo se renombra y se mueve a
 * "02 Pagos exterior / AÑO" como  2026-09-16_PAGO_Monterosas_USD 12450.pdf
 * Si no puede leerlo, lo deja en "02 Pagos exterior / _Revisar".
 * Se ejecuta solo con el disparador; también puedes lanzar procesarPagosExterior() a mano.
 */
/**
 * UNA VEZ (o cuando quieras): repasa las facturas de proveedores españoles archivadas en los últimos 20 días
 * y las pasa al mes/trimestre de la FECHA DE FACTURA (p. ej. la de Verdnatura del 30-09 que llegó el 1-10 → T3 / 2026-09).
 */
function recolocarFacturasPorFecha() {
  const ctx = cargarContexto_();
  ctx.llamadasGemini = -1000;                               // función manual: sin el tope de lecturas de una pasada normal
  const sh = ctx.ss.getSheetByName('Archivos');
  const vals = sh.getDataRange().getValues();
  const desde = Date.now() - 20 * 864e5;
  let movidas = 0;
  for (let i = 1; i < vals.length; i++) {
    const row = vals[i];
    const esEsp = row[3] === 'ESPAÑA', esOtrosEntrada = row[3] === 'OTROS' && /_Entrada/i.test(String(row[6]));
    if ((!esEsp && !esOtrosEntrada) || !row[10] || new Date(row[0]).getTime() < desde) continue;
    if (/Albaranes|Estados de cuenta|N[oó]minas|Vallinoto/i.test(String(row[6]))) continue;
    try {
      const file = DriveApp.getFileById(row[10]);
      if (file.isTrashed() || file.getMimeType() !== 'application/pdf') continue;
      const fecha = new Date(row[0]);
      const original = String(row[5]).replace(/^\d{4}-\d{2}-\d{2}_[^_]+_/, '');
      const leer = lectorDoc_(() => file.getBlob(), ctx);
      // Proveedor: el que tenga ahora el remitente en la hoja (por si lo has rellenado después), si no el de la fila
      const rem = buscarRemitente_(String(row[1]), ctx);
      const prov = (rem && rem.proveedor) || row[2];
      if (esOtrosEntrada) {
        // Factura a nombre de Buscaflor que quedó en "07 Empresa / _Entrada" (remitente de tipo OTROS, p. ej. la gestoría)
        const r = leer();
        if (!r || r.tipo !== 'FACTURA' || r.de_buscaflor === true) continue;
        if (r.para_buscaflor !== true) {
          Logger.log('SE DEJA en _Entrada (factura a nombre de ' + (r.cliente || 'otra empresa') + ', no de Buscaflor): ' + row[5]);
          continue;
        }
      }
      const fd = fechaFactura_(original, fecha, 'ESPAÑA', leer);
      if (esEsp && fmt_(fd, 'yyyy-MM') === fmt_(fecha, 'yyyy-MM')) continue;
      nombreActual_ = original; asuntoActual_ = '';
      const ruta = rutaDestino_('ESPAÑA', prov, fd, '', false);
      const carpeta = getOrCreatePath_(ruta);
      file.moveTo(carpeta);
      file.setName(nombreUnico_(carpeta, fmt_(fd, 'yyyy-MM-dd') + '_' + limpiar_(prov) + '_' + original));
      sh.getRange(i + 1, 3, 1, 5).setValues([[prov, 'ESPAÑA', row[4], file.getName(), ruta.join(' / ')]]);
      Logger.log(file.getName() + '  →  ' + ruta.join(' / '));
      movidas++;
    } catch (e) { Logger.log('No se pudo recolocar ' + row[5] + ': ' + e); }
  }
  Logger.log('Facturas recolocadas: ' + movidas);
}

function procesarPagosExterior() { procesarPagosExterior_(Date.now()); }

function procesarPagosExterior_(t0, limiteMs) {
  const tope = limiteMs || (CONFIG.MAX_RUNTIME_MS + 60 * 1000);
  const key = iaDisponible_();
  const entrada = getOrCreatePath_([FOLDERS.PAGOS, FOLDERS.SUBIR_PAGOS]);
  const files = entrada.getFiles();
  if (!files.hasNext()) return;
  if (!key) { Logger.log('Falta CLAUDE_API_KEY o GEMINI_API_KEY: no se pueden leer los justificantes.'); return; }

  const ss = getRegistro_();
  const sh = ss.getSheetByName('Pagos exterior');
  const md5s = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 9, sh.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0]) md5s[r[0]] = true; });
  // Mismo pago escaneado dos veces: el MD5 cambia, así que también se compara fecha + moneda + importe + beneficiario.
  const soloLetras = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const clavePago = (fecha, moneda, importe, quien) => [fecha, moneda || 'USD', Number(importe).toFixed(2), soloLetras(quien)].join('|');
  const yaPagados = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(r => {
    if (!r[0] || !r[4]) return;
    const f = r[0] instanceof Date ? Utilities.formatDate(r[0], ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(r[0]).slice(0, 10);
    yaPagados[clavePago(f, r[5], r[4], r[2])] = true;
    yaPagados[clavePago(f, r[5], r[4], r[3])] = true;
  });
  const alias = {};
  ALIAS_INICIALES.concat(ALIAS_PAGOS).forEach(r => { alias[r[0].toLowerCase()] = r[1]; });
  const al = ss.getSheetByName('Alias fincas');
  if (al.getLastRow() > 1) al.getRange(2, 1, al.getLastRow() - 1, 2).getValues()
    .forEach(r => { if (r[0]) alias[String(r[0]).trim().toLowerCase()] = String(r[1]).trim(); });

  const filas = [];
  while (files.hasNext()) {
    if (Date.now() - t0 > tope) break;
    const file = files.next();
    try {
    const mime = file.getMimeType();
    if (['application/pdf', 'image/jpeg', 'image/png'].indexOf(mime) < 0) {
      file.moveTo(getOrCreatePath_([FOLDERS.PAGOS, FOLDERS.REVISAR_PAGOS]));
      continue;
    }
    const blob = file.getBlob();
    const md5 = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, blob.getBytes()));
    if (md5s[md5]) { file.setName('DUPLICADO_' + file.getName()); file.moveTo(getOrCreatePath_([FOLDERS.PAGOS, FOLDERS.REVISAR_PAGOS])); continue; }

    const d = geminiLeerPago_(key, blob, mime);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.fecha || '') || !d.importe) {
      file.moveTo(getOrCreatePath_([FOLDERS.PAGOS, FOLDERS.REVISAR_PAGOS]));
      continue;
    }
    let finca = d.finca || '';
    const benef = String(d.beneficiario || '').trim();
    const porAlias = Object.keys(alias).find(k => benef.toLowerCase().indexOf(k) >= 0);
    if (porAlias) finca = alias[porAlias];
    if (!finca) finca = benef || 'DESCONOCIDO';
    // Justificante sin beneficiario (p. ej. el "detalle del movimiento" de CaixaBank: solo "TRANSF.DIVISAS" y el importe):
    // se busca la ÚNICA combinación de facturas pendientes de un proveedor que suma el importe exacto.
    if (!benef && (d.moneda || 'USD') !== 'EUR') {
      try {
        const r = pagoPorImporte_(Number(d.importe), d.moneda || 'USD');
        if (r.unica) {
          finca = r.unica.proveedor;
          d.tipo = 'PAGO';
          const toks = r.unica.items.map(it => it.num ? it.num.replace(/\D/g, '') : String(it.awb).replace(/\D/g, ''));
          d.facturas = toks;
          d.concepto = 'Cruce por importe (justificante sin concepto): ' + toks.join(' ');
          Logger.log('Pago ' + d.importe + ' sin beneficiario → ' + finca + ': ' + r.unica.items.map(it => it.num || ('Guía ' + it.awb)).join(', '));
        } else if (r.varias.length) {
          MailApp.sendEmail(CONFIG.ALERT_EMAIL, '[Buzón Buscaflor] Pago de ' + d.importe + ' ' + (d.moneda || 'USD') + ' sin beneficiario: revisa a quién es',
            'El justificante ' + file.getName() + ' no dice el beneficiario ni el concepto, y su importe cuadra con varias combinaciones de facturas pendientes:\n\n' +
            r.varias.map(v => '· ' + v.proveedor + ': ' + v.items.map(it => (it.num || 'Guía ' + it.awb) + ' (' + it.importe + ')').join(' + ')).join('\n') +
            '\n\nNo he movido nada. Sube el justificante completo (con beneficiario y concepto) o pásalas tú a "Pagadas".');
        }
      } catch (e) { Logger.log('Cruce por importe: ' + e); }
    }

    const tipo = d.tipo === 'DIVISA' ? 'COMPRA DIVISA' : 'PAGO';
    const importe = Number(d.importe);
    const claves = [clavePago(d.fecha, d.moneda, importe, finca), clavePago(d.fecha, d.moneda, importe, benef)];
    if (claves.some(k => yaPagados[k])) {
      file.setName('DUPLICADO_' + limpiar_(d.fecha + '_' + finca + '_' + (d.moneda || 'USD') + ' ' + importe.toFixed(2).replace('.', ',')) + (mime === 'application/pdf' ? '.pdf' : (mime === 'image/png' ? '.png' : '.jpg')));
      file.moveTo(getOrCreatePath_([FOLDERS.PAGOS, FOLDERS.REVISAR_PAGOS]));
      continue;
    }
    claves.forEach(k => { yaPagados[k] = true; });
    const impTxt = (importe % 1 === 0 ? String(importe) : importe.toFixed(2).replace('.', ','));
    const ext = mime === 'application/pdf' ? '.pdf' : (mime === 'image/png' ? '.png' : '.jpg');
    const nombre = limpiar_(d.fecha + '_' + tipo + '_' + finca + '_' + (d.moneda || 'USD') + ' ' + impTxt) + ext;
    // Pagos: el justificante va a "Por proveedor / <finca o transitario> / Pagadas / Transferencias".
    // Si el proveedor no tiene carpeta (o es una compra de divisa), a "02 Pagos exterior / AÑO".
    let destino = null;
    if (tipo === 'PAGO') { try { destino = carpetaTransferencias_(finca, benef); } catch (e) { Logger.log('Transferencias: ' + e); } }
    if (!destino) destino = getOrCreatePath_([FOLDERS.PAGOS, d.fecha.slice(0, 4)]);
    file.moveTo(destino);
    file.setName(nombreUnico_(destino, nombre));

    md5s[md5] = true;
    // Cruce con las facturas: las que el concepto dice que se pagan pasan de "Pendientes de pago" a "Pagadas"
    let cruce = ['', '', '', '', tipo === 'PAGO' ? '' : 'NO APLICA'];
    if (tipo === 'PAGO') {
      try { cruce = filaCruce_(d, { finca: finca, benef: benef, importe: importe, moneda: d.moneda || 'USD', fecha: d.fecha }); }
      catch (e) { Logger.log('Cruce ' + file.getName() + ': ' + e); }
    }
    filas.push([d.fecha, tipo, finca, benef, importe, d.moneda || 'USD', file.getName(), file.getUrl(), md5, new Date()].concat(cruce));
    } catch (e) { Logger.log('Pago ' + file.getName() + ': ' + e); }
  }
  if (filas.length) { cabeceraCruce_(sh); sh.getRange(sh.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas); }
}

function geminiLeerPago_(key, blob, mime) {
  const prompt =
    'Este documento es un justificante bancario de una empresa española importadora de flores. ' +
    'Puede ser una transferencia internacional a un proveedor (finca de flores o transitario de carga) ' +
    'o una compra de divisas. Extrae los datos y responde SOLO con JSON:\n' +
    '{"tipo": "PAGO" o "DIVISA", "fecha": "AAAA-MM-DD" (fecha de la operación), ' +
    '"beneficiario": "nombre del beneficiario tal como aparece", ' +
    '"finca": "el nombre de esta lista que corresponda al beneficiario, o vacío si ninguno encaja", ' +
    '"importe": número sin separador de miles y con punto decimal (el importe enviado en la moneda de destino), ' +
    '"moneda": "USD" o "EUR" u otra, ' +
    '"concepto": "el concepto de la transferencia copiado tal cual, con todos sus números", ' +
    '"facturas": ["cada número de factura o de guía aérea que el concepto dice que se paga, uno por elemento; [] si no da números"], ' +
    '"desde": "si el concepto da un rango (desde X a Y), el primer número; si no, vacío", "hasta": "el último número del rango", ' +
    '"mes": "AAAA-MM si el concepto dice que se pagan las facturas de un mes; si no, vacío"}\n' +
    'Lista de proveedores: ' + FINCAS.join(', ') + '.';
  return iaJson_(prompt, blob, mime, 900);
}

// ─────────────────────────── cruce de pagos con facturas ───────────────────────────
// Cuando entra un justificante en "02 Pagos exterior / _Subir aquí", el concepto dice qué se paga:
//   · números sueltos  ("pago facturas 1840 1878 1949 y 0328")  → esas facturas (o esas guías, si el número es de AWB)
//   · un rango         ("pago desde 108308 a 108819")            → todas las facturas con número entre los dos
//   · un mes           ("pago factura septiembre 2026")          → todas las facturas con fecha de ese mes
// Las que estén en "01 Importación / Por proveedor / <proveedor> / Pendientes de pago" pasan a "Pagadas".
// El resultado queda en la hoja "Pagos exterior" (columnas K–O). No se manda ningún correo.
// Si la factura llega DESPUÉS del pago, el repaso de cada hora la pasa a "Pagadas" cuando aparezca.
const PAGOS_COLS = ['Concepto', 'Referencias', 'Facturas pagadas', 'Suma facturas', 'Cruce'];
const COL_CRUCE = 11;                 // columna K
const CRUCE_REINTENTAR_DIAS = 60;     // cuánto tiempo se siguen buscando las facturas que faltan de un pago

function cabeceraCruce_(sh) {
  const r = sh.getRange(1, COL_CRUCE, 1, PAGOS_COLS.length);
  if (r.getValues()[0].join('') === '') r.setValues([PAGOS_COLS]).setFontWeight('bold');
}

// Qué dice el concepto que se paga → { f: [números], d: desde, h: hasta, m: 'AAAA-MM' }
function refsDePago_(d, fechaPago) {
  const soloDig = s => String(s || '').replace(/\D/g, '');
  const ref = { f: [], d: '', h: '', m: '', hf: '' };
  let c = String(d.concepto || '');

  // fecha de corte: "pago hasta el 14 10 2026", "hasta el 30/09/2026", "hasta 30-09" → todo lo pendiente con fecha ≤ esa
  const hf = c.match(/hasta\s+(?:el\s+(?:d[ií]a\s+)?)?(\d{1,2})[\s\/.\-]+(\d{1,2})(?:[\s\/.\-]+(\d{2,4}))?(?!\d)/i);
  if (hf && Number(hf[2]) >= 1 && Number(hf[2]) <= 12 && Number(hf[1]) >= 1 && Number(hf[1]) <= 31) {
    let anio = Number(hf[3]) || 0;
    if (anio && anio < 100) anio += 2000;
    if (!anio) {
      const fp = /^\d{4}-\d{2}/.test(String(fechaPago || '')) ? String(fechaPago) : fmt_(new Date(), 'yyyy-MM-dd');
      anio = Number(fp.slice(0, 4)) - (Number(hf[2]) > Number(fp.slice(5, 7)) ? 1 : 0);
    }
    ref.hf = anio + '-' + ('0' + hf[2]).slice(-2) + '-' + ('0' + hf[1]).slice(-2);
    c = c.replace(hf[0], ' ');
  }

  // rango: "desde 108308 a 108819", "de la 100 a la 120", "100 hasta 120", "pago 6691 a 9642" (también guías)
  const rg = c.match(/(?:desde|del?)\s+(?:la\s+|el\s+)?(\d{3,})\s*(?:a|al|hasta)\s+(?:la\s+|el\s+)?(\d{3,})|(\d{3,})\s+hasta\s+(?:la\s+|el\s+)?(\d{3,})|(\d{4,})\s+(?:a|al)\s+(?:la\s+|el\s+)?(\d{4,})/i);
  if (rg) { ref.d = rg[1] || rg[3] || rg[5]; ref.h = rg[2] || rg[4] || rg[6]; c = c.replace(rg[0], ' '); }
  else if (!c && soloDig(d.desde).length >= 3 && soloDig(d.hasta).length >= 3) { ref.d = soloDig(d.desde); ref.h = soloDig(d.hasta); }

  // mes: "septiembre 2026", "agosto de 2026", "septiembre" (sin año: el último que ya ha empezado antes del pago)
  const MES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  const mm = c.match(/\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b(?:\s+(?:de\s+|del\s+)?(20\d{2}))?/i);
  if (mm) {
    const mes = MES[mm[1].toLowerCase()];
    let anio = Number(mm[2]) || 0;
    if (!anio) {
      const fp = /^\d{4}-\d{2}/.test(String(fechaPago || '')) ? String(fechaPago) : fmt_(new Date(), 'yyyy-MM-dd');
      anio = Number(fp.slice(0, 4)) - (mes > Number(fp.slice(5, 7)) ? 1 : 0);
    }
    ref.m = anio + '-' + ('0' + mes).slice(-2);
    c = c.replace(mm[0], ' ');
  } else if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(d.mes || ''))) ref.m = d.mes;

  // números sueltos: los que quedan en el concepto y que la IA también ha dado como factura
  const ia = (Array.isArray(d.facturas) ? d.facturas : []).map(soloDig).filter(x => x.length >= 3);
  const enTexto = (c.match(/\d{3,}/g) || []);
  const casan = (a, b) => a === b || (a.length > b.length ? a.slice(-b.length) === b : b.slice(-a.length) === a);
  if (String(d.concepto || '')) ref.f = enTexto.filter(t => !ia.length || ia.some(a => casan(a, t)));
  else ref.f = ia.filter(a => a !== soloDig(ref.d) && a !== soloDig(ref.h));
  ref.f = ref.f.filter((t, i, arr) => arr.indexOf(t) === i);
  return ref;
}

// Empareja las referencias del pago con las facturas de la carpeta del proveedor (sin tocar Drive).
// items: [{ num, awb, fecha, importe, moneda, pagada }]
function emparejarPago_(items, ref, pago) {
  const dig = s => String(s || '').replace(/\D/g, '');
  const sin0 = s => dig(s).replace(/^0+/, '');
  const hall = [], faltan = [];
  const add = it => { if (hall.indexOf(it) < 0) hall.push(it); };
  const lista = ref.f || [];

  lista.forEach(tok => {
    const t = sin0(tok);
    if (t.length < 3) return;
    let ms = items.filter(it => it.num && sin0(it.num) === t);                 // número de factura exacto
    if (!ms.length && t.length >= 4) {                                           // o sus últimas cifras, si solo casa una factura
      const suf = items.filter(it => it.num && sin0(it.num).length > t.length && sin0(it.num).slice(-t.length) === t);
      const distintos = {}; suf.forEach(it => { distintos[sin0(it.num)] = 1; });
      if (Object.keys(distintos).length === 1) ms = suf;
    }
    if (!ms.length && dig(tok).length >= 4) ms = items.filter(it => dig(it.awb).slice(-dig(tok).length) === dig(tok));  // o la guía
    if (ms.length) ms.forEach(add); else faltan.push(String(tok));
  });

  const hayRango = !!(ref.d && ref.h);
  if (hayRango) {
    let lo = Number(sin0(ref.d)), hi = Number(sin0(ref.h));
    if (lo > hi) { const x = lo; lo = hi; hi = x; }
    const antes = hall.length;
    if (hi - lo <= 20000) items.forEach(it => { const n = sin0(it.num); if (n && Number(n) >= lo && Number(n) <= hi) add(it); });
    // rango de GUÍAS ("pago 6691 a 9642", transitarios): todas las guías con fecha entre la primera y la última
    if (hall.length === antes) {
      const porAwb = t => items.filter(it => dig(it.awb).length > dig(t).length && dig(it.awb).slice(-dig(t).length) === dig(t));
      const a = porAwb(ref.d), b = porAwb(ref.h);
      if (a.length && b.length) {
        const fs = a.concat(b).map(it => String(it.fecha)).sort();
        items.forEach(it => { if (String(it.fecha) >= fs[0] && String(it.fecha) <= fs[fs.length - 1]) add(it); });
      }
    }
  }
  const porMes = !lista.length && !hayRango && !!ref.m;
  if (porMes) items.forEach(it => { if (String(it.fecha).slice(0, 7) === ref.m) add(it); });

  // fecha de corte ("pago hasta el 14 10 2026"): lo PENDIENTE con fecha ≤ corte. Si la suma no cuadra con el pago,
  // se busca la única combinación de esas facturas que cuadre (p. ej. queda fuera una factura en disputa).
  // Si no hay ninguna o hay varias, no se mueve nada y se avisa en la hoja.
  let notaCorte = '', yaPagadas = false;
  const porCorte = !lista.length && !hayRango && !!ref.hf;
  if (porCorte) {
    const cand = items.filter(it => !it.pagada && String(it.fecha) <= ref.hf && it.moneda === (pago.moneda || 'USD'));
    yaPagadas = !cand.length && items.some(it => it.pagada && String(it.fecha) <= ref.hf);
    const objetivo = Math.round(Number(pago.importe) * 100);
    const tol = Math.max(100, Math.min(2500, Math.round(objetivo * 0.01)));   // 1 % del pago, entre 1 y 25
    const tot = cand.reduce((s, it) => s + Math.round(it.importe * 100), 0);
    let elegidas = null;
    if (yaPagadas) { /* nada pendiente antes del corte: ya se pasó todo a Pagadas (a mano o en otra pasada) */ }
    else if (Math.abs(tot - objetivo) <= tol) elegidas = cand;
    else if (tot > objetivo) {
      const sol = combinacionUnica_(cand, objetivo, tol);
      if (sol) { elegidas = sol; notaCorte = ' · ' + (cand.length - sol.length) + ' de antes del corte siguen pendientes'; }
      else notaCorte = ' · NO MOVIDAS: lo pendiente hasta ' + ref.hf + ' suma ' + (tot / 100).toFixed(2).replace('.', ',') + ' y ninguna combinación única cuadra';
    } else notaCorte = ' · NO MOVIDAS: lo pendiente hasta ' + ref.hf + ' suma ' + (tot / 100).toFixed(2).replace('.', ',') + ' (menos que el pago)';
    if (elegidas) elegidas.forEach(add);
  }

  const es = n => Number(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const suma = Math.round(hall.reduce((a, it) => a + (Number(it.importe) || 0), 0) * 100) / 100;
  const moneda = pago.moneda || 'USD';
  const mismaMoneda = hall.every(it => it.moneda === moneda);
  const dif = Math.round((Number(pago.importe) - suma) * 100) / 100;
  let estado;
  if (!lista.length && !hayRango && !ref.m && !ref.hf) estado = 'SIN REFERENCIA';
  else if (yaPagadas) estado = 'CUADRA · ya estaba en Pagadas · hasta ' + ref.hf;
  else if (!hall.length) estado = 'SIN FACTURAS' + (faltan.length ? ' · faltan ' + faltan.join(', ') : '') + notaCorte;
  else if (porCorte) estado = (Math.abs(dif) <= Math.max(1, Math.min(25, Math.abs(Number(pago.importe)) * 0.01)) ? 'CUADRA' : 'DIFERENCIA ' + es(dif) + ' ' + moneda) + ' · hasta ' + ref.hf + notaCorte;
  else if (!mismaMoneda) estado = (faltan.length ? 'PARCIAL · faltan ' + faltan.join(', ') + ' · ' : 'MOVIDAS · ') + 'otra moneda, importe sin comprobar';
  else if (faltan.length) estado = 'PARCIAL · faltan ' + faltan.join(', ') + ' · diferencia ' + es(dif) + ' ' + moneda;
  else if (Math.abs(dif) <= 1) estado = 'CUADRA';
  else estado = 'DIFERENCIA ' + es(dif) + ' ' + moneda;
  return { hallados: hall, faltan: faltan, suma: suma, estado: estado };
}

// La única combinación de items cuya suma (céntimos) está a ±tol del objetivo; null si no hay ninguna o hay varias.
function combinacionUnica_(items, objetivo, tol) {
  const xs = items.map(it => ({ it: it, c: Math.round(it.importe * 100) })).sort((a, b) => b.c - a.c);
  const resto = []; let acc = 0;
  for (let i = xs.length - 1; i >= 0; i--) { acc += xs[i].c; resto[i] = acc; }
  const sols = []; let pasos = 0;
  (function buscar(i, suma, el) {
    if (sols.length >= 2 || ++pasos > 300000) return;
    if (Math.abs(suma - objetivo) <= tol && el.length) { sols.push(el.slice()); return; }
    if (i >= xs.length || suma > objetivo + tol || suma + resto[i] < objetivo - tol) return;
    el.push(xs[i].it); buscar(i + 1, suma + xs[i].c, el); el.pop();
    buscar(i + 1, suma, el);
  })(0, 0, []);
  return sols.length === 1 && pasos <= 300000 ? sols[0] : null;
}

// Facturas (PDF o accesos directos) de una carpeta con el nombre estándar:
//   "2026-09-12 · AWB 075-68009756 · Fra FC01878 · 536,00 USD"   |   "… · Guía · 2407,94 USD"
function facturasDeCarpeta_(carpeta, pagada) {
  const out = [], it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    // "… · Fra 123 · 45,00 USD", "… · Guía · 2407,94 USD" o "… · Guía · Fra LC-17636 · 3502,80 USD" (transitarios)
    const m = String(f.getName()).match(/^(\d{4}-\d{2}-\d{2})\s*·\s*AWB\s+([\d-]+)\s*·\s*(?:Gu[ií]a(?:\s*·\s*Fra\s+(.+?))?|Fra\s+(.+?))\s*·\s*([\d.,]+)\s*(USD|EUR)(?:\.\w{2,4})?$/i);
    if (!m) continue;
    out.push({ file: f, fecha: m[1], awb: m[2], num: m[3] || m[4] || '', pagada: !!pagada,
      importe: Number(m[5].replace(/\./g, '').replace(',', '.')) || 0, moneda: m[6].toUpperCase() });
  }
  return out;
}

// Carpeta del proveedor en "Por proveedor" (no crea ninguna: si no existe, no hay nada que mover)
function carpetaProveedorPago_(finca, benef) {
  const raiz = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor']);
  const cands = [];
  [finca, benef].forEach(x => {
    if (!x) return;
    const t = nombreTransitario_(x);
    if (['Kuehne+Nagel', 'Saftec', 'Logike'].indexOf(t) >= 0) cands.push(t);
    cands.push(nombreProveedor_(x));
    cands.push(String(x).trim());
  });
  for (const c of cands) {
    if (!c) continue;
    const it = raiz.getFoldersByName(c);
    if (it.hasNext()) return it.next();
  }
  // último recurso: una carpeta cuyo nombre aparece dentro del nombre del beneficiario ("QUITO INORFLOWERS TRADE" → Inorflowers)
  const letras = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const quien = letras(finca) + ' ' + letras(benef);
  const todas = raiz.getFolders();
  while (todas.hasNext()) {
    const c = todas.next(), n = letras(c.getName());
    if (n.length >= 5 && quien.indexOf(n) >= 0) return c;
  }
  return null;
}

/**
 * Pago sin beneficiario: busca en "Pendientes de pago" de cada proveedor las combinaciones de facturas que suman
 * exactamente el importe (±0,01). → { unica: {proveedor, items} | null, varias: [{proveedor, items}, …] }
 * Solo hay "unica" si en TODOS los proveedores juntos hay una sola combinación que cuadra.
 */
function pagoPorImporte_(importe, moneda) {
  const objetivo = Math.round(importe * 100);
  const raiz = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor']);
  const sub = (c, n) => { const it = c.getFoldersByName(n); return it.hasNext() ? it.next() : null; };
  const halladas = [];
  const provs = raiz.getFolders();
  while (provs.hasNext() && halladas.length < 2) {
    const c = provs.next();
    const bases = [c];
    if (typeof GRUPOS_EMPRESAS !== 'undefined' && GRUPOS_EMPRESAS[c.getName()])
      GRUPOS_EMPRESAS[c.getName()].forEach(e => { const s = sub(c, e.nombre); if (s) bases.push(s); });
    let items = [];
    bases.forEach(b => { const p = sub(b, 'Pendientes de pago'); if (p) items = items.concat(facturasDeCarpeta_(p, false)); });
    items = items.filter(it => it.moneda === moneda && it.importe > 0)
      .map(it => Object.assign(it, { c: Math.round(it.importe * 100) }))
      .sort((a, b) => b.c - a.c);
    if (!items.length || items.reduce((a, it) => a + it.c, 0) < objetivo - 1) continue;
    // suma de subconjuntos con poda (como mucho 2 soluciones por proveedor y un tope de pasos)
    const sols = [];
    let pasos = 0;
    const resto = []; let acc = 0;
    for (let i = items.length - 1; i >= 0; i--) { acc += items[i].c; resto[i] = acc; }
    (function buscar(i, suma, elegidos) {
      if (sols.length >= 2 || ++pasos > 300000) return;
      if (Math.abs(suma - objetivo) <= 1 && elegidos.length) { sols.push(elegidos.slice()); return; }
      if (i >= items.length || suma > objetivo + 1 || suma + resto[i] < objetivo - 1) return;
      elegidos.push(items[i]); buscar(i + 1, suma + items[i].c, elegidos); elegidos.pop();
      buscar(i + 1, suma, elegidos);
    })(0, 0, []);
    sols.forEach(s => halladas.push({ proveedor: c.getName(), items: s }));
  }
  return { unica: halladas.length === 1 ? halladas[0] : null, varias: halladas.length > 1 ? halladas : [] };
}

/** Carpeta "Por proveedor / <proveedor> / Pagadas / Transferencias" (la crea si hace falta); null si el proveedor no tiene carpeta. */
function carpetaTransferencias_(finca, benef) {
  const carpeta = carpetaProveedorPago_(finca, benef);
  if (!carpeta) return null;
  // Grupos con varias empresas (Grupo Cantiza): el pago es del grupo → "Grupo Cantiza / Transferencias"
  if (typeof GRUPOS_EMPRESAS !== 'undefined' && GRUPOS_EMPRESAS[carpeta.getName()]) {
    const t = carpeta.getFoldersByName('Transferencias');
    return t.hasNext() ? t.next() : carpeta.createFolder('Transferencias');
  }
  const it = carpeta.getFoldersByName('Pagadas');
  const pag = it.hasNext() ? it.next() : carpeta.createFolder('Pagadas');
  const it2 = pag.getFoldersByName('Transferencias');
  return it2.hasNext() ? it2.next() : pag.createFolder('Transferencias');
}

/** UNA VEZ: mueve los justificantes ya registrados de "02 Pagos exterior / AÑO" a "Pagadas / Transferencias" de su proveedor. */
function transferenciasAnteriores() {
  const sh = getRegistro_().getSheetByName('Pagos exterior');
  if (!sh || sh.getLastRow() < 2) return;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  let n = 0;
  const sin = [];
  v.forEach(r => {
    if (r[1] !== 'PAGO') return;
    const id = (String(r[7] || '').match(/\/d\/([\w-]+)/) || [])[1];
    if (!id) return;
    try {
      const f = DriveApp.getFileById(id);
      if (f.isTrashed()) return;
      const destino = carpetaTransferencias_(r[2], r[3]);
      if (!destino) { sin.push(r[2]); return; }
      const p = f.getParents();
      if (p.hasNext() && p.next().getId() === destino.getId()) return;     // ya está
      f.moveTo(destino); n++;
    } catch (e) { Logger.log('Pago ' + r[6] + ': ' + e); }
  });
  Logger.log('Justificantes movidos: ' + n + (sin.length ? ' · Sin carpeta de proveedor (se quedan en 02 Pagos exterior): ' + sin.join(', ') : ''));
}

// Cruza un pago: mueve a "Pagadas" lo que el concepto dice que se paga. → { pagadas, suma, estado }
function cruzarPago_(pago, ref) {
  if (!(ref.f && ref.f.length) && !(ref.d && ref.h) && !ref.m && !ref.hf) return { pagadas: '', suma: '', estado: 'SIN REFERENCIA' };
  const carpeta = carpetaProveedorPago_(pago.finca, pago.benef);
  if (!carpeta) return { pagadas: '', suma: '', estado: 'SIN CARPETA de proveedor' };
  const sub = (c, n) => { const it = c.getFoldersByName(n); return it.hasNext() ? it.next() : null; };
  // Grupo Cantiza: un pago cubre facturas de sus tres empresas → se buscan en todas (y en el propio grupo)
  const bases = [carpeta];
  if (typeof GRUPOS_EMPRESAS !== 'undefined' && GRUPOS_EMPRESAS[carpeta.getName()])
    GRUPOS_EMPRESAS[carpeta.getName()].forEach(e => { const c = sub(carpeta, e.nombre); if (c) bases.push(c); });
  let items = [];
  bases.forEach(b => {
    const pend = sub(b, 'Pendientes de pago'), pag = sub(b, 'Pagadas');
    items = items.concat((pend ? facturasDeCarpeta_(pend, false) : []).concat(pag ? facturasDeCarpeta_(pag, true) : [])
      .map(x => Object.assign(x, { base: b })));
  });
  const r = emparejarPago_(items, ref, pago);
  let fallos = 0;
  r.hallados.filter(it => !it.pagada).forEach(it => {
    try { it.file.moveTo(sub(it.base, 'Pagadas') || it.base.createFolder('Pagadas')); }
    catch (e) { fallos++; Logger.log('No se pudo mover ' + it.file.getName() + ': ' + e); }
  });
  return {
    pagadas: r.hallados.map(it => it.num || ('Guía ' + it.awb)).join(', '),
    suma: r.hallados.length ? r.suma : '',
    estado: r.estado + (fallos ? ' · ' + fallos + ' sin mover (mira el registro)' : '')
  };
}

// Las cinco celdas K–O de un pago
function filaCruce_(d, pago) {
  const ref = refsDePago_(d, pago.fecha);
  const r = cruzarPago_(pago, ref);
  return [String(d.concepto || ''), JSON.stringify(ref), r.pagadas, r.suma, r.estado];
}

// Repaso: pagos recientes a los que aún les faltan facturas (llegaron después del pago). No usa la IA.
// Lo llama el buzón solo una vez por hora; a mano: recruzarPagos().
function recruzarPagos() { recruzarPagos_(true); }
function recruzarPagos_(forzar) {
  const props = PropertiesService.getScriptProperties();
  if (!forzar && Date.now() - Number(props.getProperty('CRUCE_PAGOS_TS') || 0) < 55 * 60 * 1000) return;
  props.setProperty('CRUCE_PAGOS_TS', String(Date.now()));
  const sh = getRegistro_().getSheetByName('Pagos exterior');
  if (!sh || sh.getLastRow() < 2) return;
  const n = sh.getLastRow() - 1;
  const v = sh.getRange(2, 1, n, COL_CRUCE - 1 + PAGOS_COLS.length).getValues();
  const desde = Date.now() - CRUCE_REINTENTAR_DIAS * 86400000;
  const t0 = Date.now();
  v.forEach((row, i) => {
    if (Date.now() - t0 > 60 * 1000) return;                            // como mucho un minuto por pasada
    const estado = String(row[COL_CRUCE + 3] || '');
    if (!row[COL_CRUCE] || !estado || /^(CUADRA|SIN REFERENCIA|NO APLICA)/.test(estado)) return;
    if (row[0] instanceof Date && row[0].getTime() < desde) return;
    let ref; try { ref = JSON.parse(row[COL_CRUCE]); } catch (e) { return; }
    try {
      const r = cruzarPago_({ finca: row[2], benef: row[3], importe: Number(row[4]), moneda: row[5] || 'USD' }, ref);
      if (r.estado !== estado || String(r.pagadas) !== String(row[COL_CRUCE + 1] || ''))
        sh.getRange(i + 2, COL_CRUCE + 2, 1, 3).setValues([[r.pagadas, r.suma, r.estado]]);
    } catch (e) { Logger.log('Recruce fila ' + (i + 2) + ': ' + e); }
  });
}

/**
 * UNA VEZ tras actualizar: vuelve a sacar las referencias del CONCEPTO ya guardado (columna K) de los pagos que no
 * cuadraron (p. ej. "pago hasta el 30 09 2026" de Kuehne+Nagel) y los cruza otra vez. No usa la IA.
 */
function rehacerCrucesPagos() {
  const ss = getRegistro_();
  const sh = ss.getSheetByName('Pagos exterior');
  if (!sh || sh.getLastRow() < 2) return;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, COL_CRUCE - 1 + PAGOS_COLS.length).getValues();
  let n = 0;
  v.forEach((row, i) => {
    if (row[1] !== 'PAGO') return;
    const concepto = String(row[COL_CRUCE - 1] || '');
    const estado = String(row[COL_CRUCE + 3] || '');
    if (!concepto || /^(CUADRA|NO APLICA)/.test(estado)) return;
    const fecha = row[0] instanceof Date ? Utilities.formatDate(row[0], ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(row[0]).slice(0, 10);
    try {
      const pago = { finca: row[2], benef: row[3], importe: Number(row[4]), moneda: row[5] || 'USD', fecha: fecha };
      const ref = refsDePago_({ concepto: concepto }, fecha);
      const r = cruzarPago_(pago, ref);
      sh.getRange(i + 2, COL_CRUCE + 1, 1, 4).setValues([[JSON.stringify(ref), r.pagadas, r.suma, r.estado]]);
      n++;
      Logger.log(row[2] + ' ' + row[4] + ' ' + row[5] + ' «' + concepto + '» → ' + r.estado + (r.pagadas ? ' [' + r.pagadas + ']' : ''));
    } catch (e) { Logger.log('Fila ' + (i + 2) + ': ' + e); }
  });
  Logger.log('Pagos recruzados: ' + n);
}

/**
 * UNA VEZ (y siempre que quieras): cruza los pagos que ya estaban anotados antes de este cambio.
 * Vuelve a leer cada justificante para sacar el concepto, mueve sus facturas a "Pagadas" y rellena las columnas K–O.
 * Si se queda sin tiempo, ejecútalo otra vez: sigue por donde iba.
 */
function cruzarPagosAnteriores() {
  const key = iaDisponible_();
  if (!key) { Logger.log('Falta CLAUDE_API_KEY o GEMINI_API_KEY.'); return; }
  const t0 = Date.now();
  const ss = getRegistro_();
  const sh = ss.getSheetByName('Pagos exterior');
  if (sh.getLastRow() < 2) return;
  cabeceraCruce_(sh);
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, COL_CRUCE - 1 + PAGOS_COLS.length).getValues();
  for (let i = 0; i < v.length; i++) {
    const row = v[i];
    if (String(row[COL_CRUCE + 3] || '')) continue;                     // ya cruzado
    if (Date.now() - t0 > 4.5 * 60 * 1000) { Logger.log('Se acabó el tiempo: ejecútalo otra vez para seguir.'); break; }
    let celdas;
    if (row[1] !== 'PAGO') celdas = ['', '', '', '', 'NO APLICA'];
    else {
      const id = (String(row[7] || '').match(/\/d\/([\w-]+)/) || [])[1];
      if (!id) continue;
      try {
        const file = DriveApp.getFileById(id);
        const d = geminiLeerPago_(key, file.getBlob(), file.getMimeType());
        if (!d) { Logger.log('Fila ' + (i + 2) + ': no se pudo leer el justificante.'); continue; }
        const fecha = row[0] instanceof Date ? Utilities.formatDate(row[0], ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(row[0]).slice(0, 10);
        celdas = filaCruce_(d, { finca: row[2], benef: row[3], importe: Number(row[4]), moneda: row[5] || 'USD', fecha: fecha });
      } catch (e) { Logger.log('Fila ' + (i + 2) + ': ' + e); continue; }
    }
    sh.getRange(i + 2, COL_CRUCE, 1, PAGOS_COLS.length).setValues([celdas]);
    Logger.log(row[2] + ' ' + row[4] + ' ' + row[5] + ' → ' + celdas[4] + (celdas[2] ? ' [' + celdas[2] + ']' : ''));
  }
}

function procesarMensaje_(msg, thread, ctx) {
  const from = extraerEmail_(msg.getFrom());
  if (from === Session.getActiveUser().getEmail().toLowerCase()) return;

  const asunto = msg.getSubject() || '';
  const cuerpo = (msg.getPlainBody() || '').slice(0, 4000);
  const fecha = msg.getDate();

  // MODO VUELO: correo tuyo con asunto "VUELO 075-xxxx xxxx" → todo a la carpeta de ese AWB
  // (basta con que lo envíes desde una dirección tuya y el asunto contenga un AWB)
  if (CONFIG.PROPIOS.indexOf(from) >= 0) {
    const awbs = extraerAwbs_(asunto);
    if (awbs.length === 1) { procesarVuelo_(msg, thread, awbs[0], from, fecha, ctx); return; }
  }

  const rem = buscarRemitente_(from, ctx);
  let tipo = rem ? rem.tipo : 'PENDIENTE';
  const proveedor = (rem && rem.proveedor) || from.split('@')[0];

  if (!rem) {
    if (esPublicidad_(msg, thread, ctx)) tipo = 'PUBLICIDAD';
    registrarRemitenteNuevo_(from, asunto, ctx, tipo);
  }
  else if (rem.fila) ctx.contadores[rem.fila] = (ctx.contadores[rem.fila] || 0) + 1;

  if (tipo === 'IGNORAR') { msg.markRead(); return; }

  // Publicidad de un proveedor ya conocido (finca, transitario o proveedor español)
  if (['FINCA', 'TRANSITARIO', 'ESPAÑA'].indexOf(tipo) >= 0 && esPromoDeConocido_(msg, thread, asunto, ctx)) {
    thread.addLabel(label_(LABELS.PUBLICIDAD));
    msg.markRead();
    thread.moveToArchive();
    return;
  }

  // Ofertas y disponibilidades de fincas y proveedores ("Valleverde-Farms Offer October 6th"): no son facturas ni piden nada
  // que haya que archivar. Se tratan como publicidad: sin aviso, sin guardar adjuntos, leído y archivado.
  if (['FINCA', 'TRANSITARIO', 'ESPAÑA'].indexOf(tipo) >= 0 && esOferta_(msg, asunto)) {
    thread.addLabel(label_(LABELS.PUBLICIDAD));
    msg.markRead();
    thread.moveToArchive();
    return;
  }

  if (LABELS[tipo]) thread.addLabel(label_(LABELS[tipo]));
  if (tipo === 'PUBLICIDAD') { msg.markRead(); thread.moveToArchive(); return; }

  const guardados = guardarAdjuntos_(msg, tipo, proveedor, from, asunto, cuerpo, fecha, ctx);
  const motivo = revisarAlertas_(msg, thread, tipo, from, asunto, cuerpo, guardados, ctx);

  // LEÍDO = el buzón lo ha resuelto solo (adjuntos archivados en su sitio definitivo).
  // NO LEÍDO + etiqueta "Buzón/Revisar" = necesita que lo mires: remitente sin clasificar,
  // sin adjuntos (p. ej. factura por enlace o correo para contestar), sin vuelo asignado o con aviso.
  const resuelto = !motivo && tipo !== 'PENDIENTE' && !guardados.revisar && guardados.validos > 0;
  if (resuelto) {
    msg.markRead();
  } else {
    msg.markUnread();
    thread.addLabel(label_(LABELS.REVISAR));
  }
}

// ─────────────────────────── ADJUNTOS Y CARPETAS ───────────────────────────

function guardarAdjuntos_(msg, tipo, proveedor, from, asunto, cuerpo, fecha, ctx) {
  const guardados = [];
  guardados.validos = 0;      // adjuntos útiles (guardados o ya existentes)
  guardados.revisar = false;  // algo ha quedado en _Pendiente / _Sin vuelo / sin adjuntos
  const esCasana = CASANA.REMITENTES.indexOf(String(from || '').toLowerCase()) >= 0;
  // Desde Casana a veces llegan fotos de tickets pegadas en el cuerpo o en formato del móvil (HEIC): también cuentan
  const adjuntos = msg.getAttachments({ includeInlineImages: esCasana, includeAttachments: true });
  const awbsTexto = extraerAwbs_(asunto + ' ' + cuerpo);
  fechaVueloActual_ = tipo === 'TRANSITARIO' ? extraerFechaVuelo_(asunto) : null;
  asuntoActual_ = asunto;
  transitarioActual_ = tipo === 'TRANSITARIO' ? transitarioCorto_(proveedor) : '';

  const justificantes = [];   // justificantes de pago de gastos: se guardan al final, junto al gasto del mismo correo
  const gastosCorreo = [];    // gastos guardados de este correo (para poner su justificante al lado)
  for (const att of adjuntos) {
    const nombre = att.getName() || 'adjunto';
    if (!EXT_OK.test(nombre) && !(esCasana && /\.(heic|heif|webp|gif|tiff?)$/i.test(nombre))) continue;
    if (/\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i.test(nombre) && att.getSize() < CONFIG.MIN_IMAGE_BYTES) continue;

    guardados.validos++;
    // Documentos que no se guardan nunca (p. ej. historiales de venta de Verdnatura): el correo se da por resuelto
    if (DESCARTAR_REGEX.test(nombre) || DESCARTAR_REGEX.test(asunto)) continue;
    const bytes = att.getBytes();
    const md5 = huella_(bytes, nombre);
    if (ctx.md5[md5] || ctx.md5[hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes))]) continue; // ya guardado antes (duplicado)

    const awbsNombre = extraerAwbs_(nombre);
    let awb = awbsNombre.length === 1 ? awbsNombre[0] : (awbsTexto.length === 1 ? awbsTexto[0] : '');
    // Kuehne+Nagel: de los documentos de un vuelo solo se guardan la guía (AWB), el Consolidation Report (CR) y el recibo de bodega
    const esKN = tipo === 'TRANSITARIO' && awb && transitarioActual_ === 'Kuehne+Nagel';
    const esReciboKN = esKN && KN_RECIBO.test(nombre) && /\.pdf$/i.test(nombre);
    if (esKN && !esReciboKN && !KN_UTIL.test(nombre) && !KN_FACTURA.test(nombre)) continue;
    const leer = lectorDoc_(() => att.copyBlob(), ctx);
    // Justificante de pago de un gasto (p. ej. el "detalle del movimiento" de CaixaBank del IBI): no es un estado de cuenta;
    // se guarda al final junto al gasto que paga (mismo correo).
    if (!awb && !esCasana && (tipo === 'ESPAÑA' || tipo === 'OTROS') && /\.(pdf|jpe?g|png)$/i.test(nombre) && !FACTURA_NOMBRE.test(nombre)) {
      const r = leer();
      if (r && r.tipo === 'JUSTIFICANTE') { justificantes.push({ att: att, nombre: nombre, md5: md5, leer: leer }); continue; }
    }
    const esEecc = !awb && esEstadoCuenta_(nombre, asunto, tipo, leer);
    // Proveedores españoles: se archiva (carpeta y nombre) con la fecha de la FACTURA, no la del correo
    const tipoArch = tipoDeArchivo_(tipo, nombre, asunto, esEecc, leer);     // OTROS con factura a nombre de Buscaflor → gasto España
    const fechaDoc = (esEecc || esAlbaran_(nombre, asunto)) ? fecha : fechaFactura_(nombre, fecha, tipoArch, leer);
    if (!awb && !esEecc && (tipo === 'FINCA' || tipo === 'TRANSITARIO') && /\.pdf$/i.test(nombre) && ctx.llamadasGemini < CONFIG.MAX_GEMINI_CALLS) {
      ctx.llamadasGemini++;
      awb = geminiAwbDeFactura_(att.copyBlob(), 'application/pdf');
    }

    nombreActual_ = nombre;
    // Factura o documento ATRASADO (llega semanas después del vuelo): no crea un vuelo nuevo en la semana del correo.
    //  · vuelo anterior a la instalación (sin carpeta "AWB …"): va junto a los demás documentos de ese vuelo
    //  · vuelo que el sistema no conoce: su carpeta se crea en la semana de la FACTURA, no en la del correo
    const deVuelo = !!awb && !esEecc && (tipoArch === 'FINCA' || tipoArch === 'TRANSITARIO');
    const antigua = deVuelo ? carpetaVueloAntiguo_(awb, tipoArch) : null;
    let fechaRuta = fechaDoc;
    if (deVuelo && !antigua && tipoArch === 'FINCA' && !fechaVueloActual_ && /\.pdf$/i.test(nombre) && !buscarCarpetaAwb_(awb)) {
      fechaRuta = fechaFacturaAtrasada_(fecha, leer) || fechaDoc;
    }
    let ruta = antigua ? antigua.ruta.slice() : rutaDestino_(tipoArch, proveedor, fechaRuta, awb, esEecc);
    // Casana: la factura va a Buscaflor (04 Gastos España) o a Casana según a nombre de quién está
    let destinoCasana = '', emisorCasana = '';
    if (esCasana && !esEecc && !awb && !esRutaNominas_(ruta)) {
      const r = leer();
      emisorCasana = r && r.emisor ? String(r.emisor) : '';
      if (r && r.tipo === 'FACTURA' && r.para_buscaflor === true) destinoCasana = 'BUSCAFLOR';
      else if (r && r.tipo === 'FACTURA' && CASANA.RX.test(String(r.cliente || ''))) destinoCasana = 'CASANA';
      else destinoCasana = 'REVISAR';
      if (destinoCasana === 'CASANA') ruta = CASANA.CARPETA.concat([fmt_(fechaDoc, 'yyyy'), fmt_(fechaDoc, 'yyyy-MM')]);
      if (destinoCasana === 'REVISAR') { ruta = [FOLDERS.EMPRESA, '_Entrada', fmt_(fecha, 'yyyy-MM')]; guardados.revisar = true; }
    }
    // Albaranes de proveedores españoles: subcarpeta "Albaranes" dentro del mes, separados de las facturas
    if (tipoArch === 'ESPAÑA' && tipo === 'ESPAÑA' && !esEecc && esAlbaran_(nombre, asunto)) ruta = ruta.concat(['Albaranes']);
    if (esRutaNominas_(ruta) && /\.pdf$/i.test(nombre)) ruta = ruta.concat(carpetaTrabajador_(att.copyBlob()));
    if (ruta.indexOf(FOLDERS.SIN_VUELO) >= 0 || ruta.indexOf(FOLDERS.PENDIENTE) >= 0) guardados.revisar = true;
    const carpeta = antigua ? antigua.carpeta : getOrCreatePath_(ruta);
    const base = /vallinoto/i.test(proveedor)
      ? nombreVallinoto_(nombre, att)                                         // Vallinoto: solo el nº de factura
      : fmt_(fechaDoc, 'yyyy-MM-dd') + '_' + limpiar_(destinoCasana ? (emisorCasana.slice(0, 40) || 'Casana') : proveedor) + '_' +
        (esReciboKN ? 'Recibo bodega_' + awb + '.pdf' : limpiar_(nombre));
    if (base === null) continue;                                              // documento que no se guarda (DUA)
    const nuevoNombre = nombreUnico_(carpeta, base);
    const file = carpeta.createFile(att.copyBlob().setName(nuevoNombre));
    // La revisión de vuelos solo mira las últimas semanas: lo que cae en una semana más antigua se lee aquí mismo
    // (lectura ligera) para que su acceso aparezca ya en "Por proveedor / … / Pendientes de pago".
    if (deVuelo && /\.pdf$/i.test(nombre) && (antigua || semanaFueraDeRevision_(ruta))) accesoPagoAtrasado_(file, awb);

    // Gastos de un inmueble (IBI, comunidad, suministros…): además del gasto, un acceso en su carpeta de Inmuebles y alquileres
    if (!awb && destinoCasana !== 'CASANA' && (tipoArch === 'ESPAÑA' || tipoArch === 'OTROS') && /\.(pdf|jpe?g|png)$/i.test(nombre)) {
      try { accesoInmueble_(file, leer, asunto + ' ' + nombre + ' ' + proveedor, fechaDoc); } catch (e) { Logger.log('Inmueble: ' + e); }
    }
    // Estado de cuenta de un proveedor español: se comprueba que tenemos todas las facturas que lista
    if (esEecc && !awb && (tipoArch === 'ESPAÑA' || tipoArch === 'OTROS') && /\.(pdf|jpe?g|png)$/i.test(nombre) &&
        ctx.llamadasGemini < CONFIG.MAX_GEMINI_CALLS) {
      ctx.llamadasGemini++;
      try { comprobarEstadoCuenta_(file, proveedor); } catch (e) { Logger.log('Check estado de cuenta: ' + e); }
    }
    // Estado de cuenta de una finca o transitario del exterior: contra sus facturas de "Por proveedor"
    if (esEecc && !awb && (tipoArch === 'FINCA' || tipoArch === 'TRANSITARIO') && /\.(pdf|jpe?g|png)$/i.test(nombre) &&
        ctx.llamadasGemini < CONFIG.MAX_GEMINI_CALLS) {
      ctx.llamadasGemini++;
      try { comprobarEstadoCuentaExterior_(file, proveedor, tipoArch); } catch (e) { Logger.log('Check estado de cuenta exterior: ' + e); }
    }
    if (!awb && !esEecc && destinoCasana !== 'CASANA' && (tipoArch === 'ESPAÑA' || tipoArch === 'OTROS'))
      gastosCorreo.push({ file: file, carpeta: carpeta, ruta: ruta, leer: leer, texto: asunto + ' ' + nombre + ' ' + proveedor });
    ctx.md5[md5] = true;
    ctx.nuevosArchivos.push([fecha, from, proveedor, destinoCasana === 'CASANA' ? 'CASANA' : tipoArch, awb, nuevoNombre, ruta.join(' / '),
      file.getUrl(), md5, msg.getId(), file.getId()]);
    guardados.push({ nombre: nuevoNombre, url: file.getUrl() });
  }

  // Justificantes de pago de gastos: en la MISMA carpeta que el gasto del correo, como "AAAA-MM-DD_Pago <nombre del gasto>",
  // y también en la carpeta de su inmueble si el gasto es de uno (IBI, comunidad…).
  // Si el correo no trae el gasto, van a "04 Gastos España / AÑO / Otros gastos / T / mes / Justificantes de pago".
  justificantes.forEach(j => {
    try {
      const r = j.leer() || {};
      const fPago = /^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha || '')) ? new Date(r.fecha + 'T12:00:00') : fecha;
      const gasto = gastosCorreo[0];
      let carpeta, ruta, base;
      if (gasto) {
        carpeta = gasto.carpeta; ruta = gasto.ruta;
        base = fmt_(fPago, 'yyyy-MM-dd') + '_Pago ' + gasto.file.getName().replace(/^\d{4}-\d{2}-\d{2}_/, '');
      } else {
        const t = 'T' + (Math.floor((Number(fmt_(fPago, 'M')) - 1) / 3) + 1);
        ruta = [FOLDERS.GASTOS_ES, fmt_(fPago, 'yyyy'), 'Otros gastos', t, fmt_(fPago, 'yyyy-MM'), 'Justificantes de pago'];
        carpeta = getOrCreatePath_(ruta);
        base = fmt_(fPago, 'yyyy-MM-dd') + '_Pago_' + limpiar_(proveedor) + '_' + limpiar_(j.nombre);
      }
      const file = carpeta.createFile(j.att.copyBlob().setName(nombreUnico_(carpeta, base)));
      try {
        if (gasto) accesoInmueble_(file, gasto.leer, gasto.texto, fPago);
        else accesoInmueble_(file, j.leer, asunto + ' ' + j.nombre, fPago);
      } catch (e) { Logger.log('Inmueble (pago): ' + e); }
      ctx.md5[j.md5] = true;
      ctx.nuevosArchivos.push([fecha, from, proveedor, 'PAGO GASTO', '', file.getName(), ruta.join(' / '), file.getUrl(), j.md5, msg.getId(), file.getId()]);
      guardados.push({ nombre: file.getName(), url: file.getUrl() });
    } catch (e) { Logger.log('Justificante ' + j.nombre + ': ' + e); }
  });

  // Documentos que los transitarios mandan como ENLACE: se descargan solos
  //  · Kuehne+Nagel (KNFresh): AWB, CR, recibo de bodega, EXR, facturas de fincas
  //  · Saftec (pre-alert): "Download Farm Invoices" = Commercial Master Invoice del vuelo
  if (tipo === 'TRANSITARIO' && awbsTexto.length === 1) {
    if (!guardados.length) descargarEnlacesKN_(msg, awbsTexto[0], from, proveedor, fecha, ctx, guardados);
    descargarMasterSaftec_(msg, awbsTexto[0], from, proveedor, fecha, ctx, guardados);
  }

  // Correos de transitario/finca con AWB pero sin adjuntos (solo enlaces):
  // se crea la carpeta del vuelo para que dejes ahí los documentos a mano, y queda anotado.
  if (!guardados.length && !guardados.validos && (tipo === 'TRANSITARIO' || tipo === 'FINCA') && awbsTexto.length === 1) {
    nombreActual_ = 'awb';
    const ruta = rutaDestino_(tipo, proveedor, fecha, awbsTexto[0], false);
    const carpeta = getOrCreatePath_(ruta);
    ctx.nuevosArchivos.push([fecha, from, proveedor, tipo, awbsTexto[0],
      '(sin adjuntos: descargar a mano desde los enlaces del correo)', ruta.join(' / '),
      carpeta.getUrl(), '', msg.getId(), '']);
    guardados.revisar = true; // hay que descargar los documentos a mano
  }
  // Correo de Casana sin nada guardado: queda anotado qué traía, para saber por qué
  if (esCasana && !guardados.length && !guardados.validos) {
    let todos = [];
    try { todos = msg.getAttachments({ includeInlineImages: true, includeAttachments: true }); } catch (e) {}
    ctx.nuevosArchivos.push([fecha, from, proveedor, tipo, '', '(nada guardado · adjuntos: ' +
      (todos.length ? todos.map(a => (a.getName() || '?') + ' ' + Math.round(a.getSize() / 1024) + ' KB').join(', ') : 'ninguno') + ')',
      '', '', '', msg.getId(), '']);
  }
  fechaVueloActual_ = null;
  asuntoActual_ = '';
  transitarioActual_ = '';
  return guardados;
}

/**
 * UNA VEZ: vuelve a mirar los correos de Casana de las últimas 7 semanas (los que el buzón no supo guardar)
 * y archiva cada factura en Buscaflor o en Casana según a nombre de quién vaya. No repite lo ya guardado.
 * En la hoja "Archivos" queda una línea por correo (lo guardado, o qué adjuntos traía si no había nada).
 */
function reprocesarCasana() {
  const ctx = cargarContexto_();
  ctx.llamadasGemini = -1000;                                // función manual: sin el tope de lecturas de una pasada normal
  const t0 = Date.now();
  let n = 0;
  const q = 'from:(' + CASANA.REMITENTES.join(' OR ') + ') newer_than:50d';
  for (const th of GmailApp.search(q, 0, 100)) {
    for (const msg of th.getMessages()) {
      if (Date.now() - t0 > 5 * 60 * 1000) { Logger.log('Tiempo agotado: ejecútalo otra vez para seguir.'); guardarContexto_(ctx); return; }
      const from = extraerEmail_(msg.getFrom());
      if (CASANA.REMITENTES.indexOf(from) < 0) continue;
      const g = guardarAdjuntos_(msg, 'ESPAÑA', 'Casana', from, msg.getSubject() || '', (msg.getPlainBody() || '').slice(0, 4000), msg.getDate(), ctx);
      n++;
      Logger.log(fmt_(msg.getDate(), 'dd-MM') + ' · ' + msg.getSubject() + ' → ' + (g.length ? g.map(x => x.nombre).join(', ') : 'nada nuevo'));
      if (g.length && !g.revisar) msg.markRead();
    }
  }
  guardarContexto_(ctx);
  Logger.log('Correos de Casana revisados: ' + n);
}

/**
 * Enlaces de KNFresh (Kuehne+Nagel): cada documento viene como
 *   <strong>AWB</strong> … <a href="https://knfreshapp.kuehne-nagel.com/api/booking/documents/awb/attachedDocument?document=…">
 * Se descargan los útiles y se guardan en AWB … / Documentos vuelo con nombre reconocible:
 *   AWB → guía (flete Total Prepaid) · CR → Consolidation Report (hace de Master) · WH → Recibo de bodega (pesos)
 *   EXR → Export report · INV → todas las facturas de fincas juntas (referencia, por si falta alguna)
 * PHYTO y FORM A no se guardan. Si un enlace falla, el correo queda en "Revisar" para descargarlo a mano.
 */
// De Colombia (K+N) solo sirven TRES documentos: la guía (AWB), el Consolidation Report (CR) y el recibo de bodega. El resto no se guarda.
const KN_DOCS = { AWB: 'AWB', CR: 'CR', WH: 'Recibo bodega' };
const KN_UTIL = /^(AWB|CR)[ _-].*\.pdf$/i;                 // adjuntos de K+N que sí se guardan en la carpeta del vuelo
// Recibo de bodega (peso real de cada finca): K+N lo adjunta SIN prefijo, solo "<guía>_<número>.pdf"
const KN_RECIBO = /^\d{3}-?\d{8}_\d{6,}\.pdf$|recibo.*bodega|warehouse|^WH[ _-]/i;
const KN_FACTURA = /factura|invoice|credit note|nota de cr[eé]dito/i;

// Formato nuevo de K+N (oct-2026, "Faster downloads"): enlaces de descarga directa con el nombre del documento
// ("AIR WAY BILL", "CONSOLIDATION REPORT", "WAREHOUSE RECEIPT"); el antiguo llevaba la etiqueta AWB / CR / WH antes del enlace.
const KN_ENLACE_TEXTO = [[/AIR\s*WAY\s*BILL|AIRWAY\s*BILL/i, 'AWB'], [/CONSOLIDATION\s*REPORT/i, 'CR'], [/WAREHOUSE\s*RECEIPT/i, 'WH']];

/** Enlaces útiles del correo de K+N: { AWB: url, CR: url, WH: url }. Vale para el formato antiguo y el nuevo. */
function enlacesKN_(html) {
  const out = {};
  const limpiar = u => u.replace(/&amp;/g, '&');
  // 1) por el texto del enlace: <a href="…">AIR WAY BILL</a>
  const rxA = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = rxA.exec(html)) !== null) {
    const texto = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [rx, cod] of KN_ENLACE_TEXTO) if (!out[cod] && rx.test(texto)) out[cod] = limpiar(m[1]);
  }
  // 2) por la etiqueta pequeña (AWB, CR, WH) que va justo antes del enlace
  const rxL = /(?:<strong[^>]*>|>)\s*(AWB|CR|WH)\s*<[\s\S]{0,600}?href="(https?:\/\/[^"]+)"/g;
  while ((m = rxL.exec(html)) !== null) if (!out[m[1]]) out[m[1]] = limpiar(m[2]);
  return out;
}

/** Baja un enlace y devuelve los bytes si es un PDF (sigue redirecciones). */
function bajarPdfKN_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const bytes = res.getBlob().getBytes();
  const esPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  return { ok: res.getResponseCode() === 200 && esPdf, codigo: res.getResponseCode(), bytes: bytes };
}

function descargarEnlacesKN_(msg, awb, from, proveedor, fecha, ctx, guardados) {
  let html = '';
  try { html = msg.getBody() || ''; } catch (e) { return; }
  const enlaces = enlacesKN_(html);
  let fallos = 0;
  Object.keys(KN_DOCS).forEach(cod => {
    if (!enlaces[cod]) return;
    try {
      const r = bajarPdfKN_(enlaces[cod]);
      if (!r.ok) { fallos++; Logger.log('KN ' + cod + ': ' + r.codigo); return; }
      const nombre = KN_DOCS[cod] + '_' + awb + '.pdf';
      const md5 = huella_(r.bytes, nombre);
      guardados.validos = (guardados.validos || 0) + 1;
      if (ctx.md5[md5]) return;                                     // ya estaba (p. ej. lo subiste tú)
      const ruta = awbBase_(awb, fecha).concat(['Documentos vuelo']);
      const carpeta = getOrCreatePath_(ruta);
      if (carpeta.getFilesByName(nombre).hasNext()) return;          // mismo documento subido a mano
      const nuevo = nombreUnico_(carpeta, fmt_(fecha, 'yyyy-MM-dd') + '_' + nombre);
      const file = carpeta.createFile(Utilities.newBlob(r.bytes, 'application/pdf', nuevo));
      ctx.md5[md5] = true;
      ctx.nuevosArchivos.push([fecha, from, proveedor, 'TRANSITARIO', awb, nuevo, ruta.join(' / '), file.getUrl(), md5, msg.getId(), file.getId()]);
      guardados.push({ nombre: nuevo, url: file.getUrl() });
    } catch (e) { fallos++; Logger.log('KN ' + cod + ' error: ' + e); }
  });
  if (fallos) guardados.revisar = true;                             // algo no se pudo bajar: que lo mires
}

/**
 * UNA VEZ: baja la guía, el CR y el recibo de bodega de K+N de los vuelos de KN_AWB_MANUAL desde sus correos
 * ("Shipment Documents · Documents ready for AWB …") y los deja en "AWB … / Documentos vuelo".
 * Después ejecuta revisarVuelos para que haga el inventario.
 */
const KN_AWB_MANUAL = ['729-95837276'];

function bajarDocsKN() {
  KN_AWB_MANUAL.forEach(awb => {
    const num = awb.replace(/\D/g, '').slice(3);                       // 95837276
    const hilos = GmailApp.search('(' + num + ' OR "' + num.slice(0, 4) + ' ' + num.slice(4) + '") (kuehne OR knfresh OR knbog) in:anywhere', 0, 20);
    const enlaces = {};
    let fecha = null;
    hilos.forEach(th => th.getMessages().forEach(msg => {
      let html = ''; try { html = msg.getBody() || ''; } catch (e) {}
      const e = enlacesKN_(html);
      Object.keys(e).forEach(k => { if (!enlaces[k]) { enlaces[k] = e[k]; fecha = fecha || msg.getDate(); } });
    }));
    Logger.log(awb + ': ' + hilos.length + ' correos de K+N · enlaces encontrados: ' + (Object.keys(enlaces).join(', ') || 'NINGUNO'));
    if (!Object.keys(enlaces).length) return;
    const ruta = awbBase_(awb, fecha || new Date()).concat(['Documentos vuelo']);
    const docs = getOrCreatePath_(ruta);
    const dia = fmt_(fecha || new Date(), 'yyyy-MM-dd');
    Object.keys(KN_DOCS).forEach(cod => {
      if (!enlaces[cod]) { Logger.log('  ' + cod + ': no viene en el correo'); return; }
      const nombre = dia + '_' + KN_DOCS[cod] + '_' + awb + '.pdf';
      if (docs.getFilesByName(nombre).hasNext()) { Logger.log('  ' + cod + ': ya estaba'); return; }
      try {
        const r = bajarPdfKN_(enlaces[cod]);
        if (!r.ok) { Logger.log('  ' + cod + ': NO se pudo bajar (código ' + r.codigo + '). Enlace: ' + enlaces[cod]); return; }
        docs.createFile(Utilities.newBlob(r.bytes, 'application/pdf', nombre));
        Logger.log('  ' + cod + ': GUARDADO ' + nombre + ' en ' + ruta.join(' / '));
      } catch (e) { Logger.log('  ' + cod + ': error ' + e); }
    });
  });
  Logger.log('Ahora ejecuta revisarVuelos: leerá los documentos y hará el inventario.');
}

/**
 * Pre-alert de Saftec: el enlace "Download Farm Invoices" (tracking.saftec.com.ec/…/inv.pdf) es la
 * Commercial Master Invoice (fincas, HAWB, piezas, tallos, importes). Se guarda como
 * "MASTER AWB 075-….pdf" en Documentos vuelo para que vuelos.gs cruce las facturas.
 * Los certificados y las HAWB no se guardan.
 */
function descargarMasterSaftec_(msg, awb, from, proveedor, fecha, ctx, guardados) {
  let texto = '';
  try { texto = (msg.getBody() || '') + ' ' + (msg.getPlainBody() || ''); } catch (e) { return; }
  // Solo el pre-alert de Saftec ("Download Farm Invoices"). El enlace puede venir reescrito por Outlook (safelinks),
  // con un espacio sin codificar ("075-6808 1042") o con comillas simples: se prueban todas las formas y, si no, el de la guía.
  if (!/saftec/i.test(from + ' ' + texto) || !/farm\s*invoices|tracking\.saftec|attachs/i.test(texto)) return;
  if (typeof urlsMasterSaftec_ !== 'function') return;
  let bytes = null;
  for (const u of urlsMasterSaftec_(awb, texto)) { bytes = bajarPdf_(u); if (bytes) break; }
  if (!bytes) { guardados.revisar = true; Logger.log('Saftec master ' + awb + ': no se pudo bajar (se reintenta desde revisarVuelos)'); return; }
  try {
    const nombre = 'MASTER AWB ' + awb + '.pdf';
    const md5 = huella_(bytes, nombre);
    guardados.validos++;
    if (ctx.md5[md5]) return;
    const ruta = awbBase_(awb, fecha).concat(['Documentos vuelo']);
    const carpeta = getOrCreatePath_(ruta);
    if (carpeta.getFilesByName(nombre).hasNext()) return;
    const file = carpeta.createFile(Utilities.newBlob(bytes, 'application/pdf', nombre));
    ctx.md5[md5] = true;
    ctx.nuevosArchivos.push([fecha, from, proveedor, 'TRANSITARIO', awb, nombre, ruta.join(' / '), file.getUrl(), md5, msg.getId(), file.getId()]);
    guardados.push({ nombre: nombre, url: file.getUrl() });
  } catch (e) { guardados.revisar = true; Logger.log('Saftec master error: ' + e); }
}

/**
 * Modo vuelo: asunto "VUELO 075-68009826" + adjuntos (facturas de fincas, guía, peso, listado…).
 *  - guía / AWB / CR / EXR / peso / listado / manifiesto / packing → AWB …/Documentos vuelo
 *  - Excel (inventario)                                            → AWB … (raíz)
 *  - el resto (facturas de fincas)                                 → AWB …/Facturas fincas
 * La fecha de la carpeta de mes es la del correo.
 */
function procesarVuelo_(msg, thread, awb, from, fecha, ctx) {
  fechaVueloActual_ = extraerFechaVuelo_(msg.getSubject() || '');
  const base = awbBase_(awb, fecha);
  const adjuntos = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  let n = 0;
  adjuntos.forEach(att => {
    const nombre = att.getName() || 'adjunto';
    if (!EXT_OK.test(nombre)) return;
    if (/\.(jpe?g|png)$/i.test(nombre) && att.getSize() < CONFIG.MIN_IMAGE_BYTES) return;
    const bytes = att.getBytes();
    const md5 = huella_(bytes, nombre);
    if (ctx.md5[md5] || ctx.md5[hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes))]) return;

    const ruta = rutaVuelo_(awb, fecha, nombre);

    const carpeta = getOrCreatePath_(ruta);
    const nuevo = nombreUnico_(carpeta, fmt_(fecha, 'yyyy-MM-dd') + '_' + limpiar_(nombre));
    const file = carpeta.createFile(att.copyBlob().setName(nuevo));
    ctx.md5[md5] = true;
    ctx.nuevosArchivos.push([fecha, from, 'VUELO', 'VUELO', awb, nuevo, ruta.join(' / '), file.getUrl(), md5, msg.getId(), file.getId()]);
    n++;
  });
  // Si reenvías un pre-alert de Saftec o un correo de K+N con enlaces, también se descargan
  const g = []; g.validos = 0;
  descargarMasterSaftec_(msg, awb, from, 'VUELO', fecha, ctx, g);
  if (!n) descargarEnlacesKN_(msg, awb, from, 'VUELO', fecha, ctx, g);
  n += g.length;
  thread.addLabel(label_(LABELS.FINCA));
  if (!n) getOrCreatePath_(base.concat(['Facturas fincas']));
  if (n) msg.markRead(); else { msg.markUnread(); thread.addLabel(label_(LABELS.REVISAR)); }
  fechaVueloActual_ = null;
}

/**
 * Carpeta de un vuelo: 01 Importación / AÑO / Sxx (lun a dom) / AWB xxx
 * Si la carpeta de ese AWB ya existe (en cualquier semana), se reutiliza: las facturas
 * que llegan días después caen en el mismo vuelo.
 */
const _awbCache = {};
let fechaVueloActual_ = null;   // fecha de vuelo leída del asunto del transitario (si la hay)
let transitarioActual_ = '';    // transitario del correo que se está guardando (Kuehne+Nagel, Saftec…)

/**
 * Carpeta del vuelo: 01 Importación / AÑO / Sxx / "AWB 075-68009852 · Kuehne+Nagel"
 * El transitario se añade al nombre en cuanto se sabe (al llegar un documento suyo, o cuando vuelos.gs lee la Master).
 * La carpeta se encuentra por su nº de AWB aunque cambie el nombre (se guarda su Id en Propiedades del script).
 */
function awbBase_(awb, fecha) {
  const base = 'AWB ' + awb;
  const fv = fechaVueloActual_, tr = transitarioActual_;
  if (_awbCache[awb] && !fv && !tr) return _awbCache[awb];
  const f = buscarCarpetaAwb_(awb);
  if (f) {
    if (tr && f.getName() === base) f.setName(base + ' · ' + tr);          // añade el transitario al nombre
    const nombre = f.getName();
    const p = f.getParents();
    const sem = p.hasNext() ? p.next() : null;
    const pa = sem ? sem.getParents() : null;
    const anio = pa && pa.hasNext() ? pa.next() : null;
    if (sem && anio && /^S\d{2} /.test(sem.getName())) {
      // Carpeta creada hace pocos días pero en una semana muy lejana (la 1ª factura traía la fecha mal leída, p. ej.
      // 10/11 leído como 11-oct): se pasa a la semana en que se creó la carpeta.
      let fvE = fv;
      if (!fvE) {
        const creada = f.getDateCreated();
        if (Date.now() - creada.getTime() < 10 * 86400000) {
          const sc = semana_(creada);
          const n1 = Number(sem.getName().slice(1, 3)), n2 = Number(sc.nombre.slice(1, 3));
          if (String(sc.anio) !== anio.getName() || Math.abs(n1 - n2) >= 3) fvE = creada;
        }
      }
      if (fvE) { // la fecha del vuelo manda: si la carpeta está en otra semana, se mueve
        const s = semana_(fvE);
        if (s.nombre !== sem.getName() || String(s.anio) !== anio.getName()) {
          const destino = getOrCreatePath_([FOLDERS.IMPORTACION, String(s.anio), s.nombre]);
          const ex = destino.getFoldersByName(nombre);
          if (ex.hasNext()) volcarCarpeta_(f, ex.next()); else f.moveTo(destino);
          return (_awbCache[awb] = [FOLDERS.IMPORTACION, String(s.anio), s.nombre, nombre]);
        }
      }
      return (_awbCache[awb] = [FOLDERS.IMPORTACION, anio.getName(), sem.getName(), nombre]);
    }
  }
  // No existe: se crea (con el transitario si ya se conoce). Si la fecha de la factura está a más de 20 días de hoy
  // (fecha mal leída: 10/11 como 11-oct), manda la fecha de hoy.
  let fC = fv || fecha;
  const tC = fC instanceof Date ? fC.getTime() : new Date(String(fC || '').slice(0, 10) + 'T12:00:00').getTime();
  if (!fv && (!tC || Math.abs(Date.now() - tC) > 20 * 86400000)) fC = new Date();
  const s = semana_(fC);
  const ruta = [FOLDERS.IMPORTACION, String(s.anio), s.nombre, base + (tr ? ' · ' + tr : '')];
  const nueva = getOrCreatePath_(ruta);
  PropertiesService.getScriptProperties().setProperty('AWBDIR_' + awb, nueva.getId());
  return (_awbCache[awb] = ruta);
}

/**
 * UNA VEZ: pasa la carpeta de un vuelo a la semana de la fecha indicada (p. ej. un vuelo que se guardó en una semana
 * equivocada). Después ejecuta revisarVuelos. Ejemplo: moverVueloDeSemana('075-69143141', '2026-11-11').
 */
function moverVueloDeSemana(awb, fechaISO) {
  awb = awb || '075-69143141'; fechaISO = fechaISO || '2026-11-11';
  fechaVueloActual_ = new Date(fechaISO + 'T12:00:00');
  delete _awbCache[awb];
  const ruta = awbBase_(awb, fechaISO);
  fechaVueloActual_ = null;
  Logger.log('Vuelo ' + awb + ' → ' + ruta.join(' / ') + '. Ahora ejecuta revisarVuelos.');
}

/** Busca la carpeta de un AWB: primero por su Id guardado, después por nombre ("AWB 075-…" con o sin transitario). */
function buscarCarpetaAwb_(awb) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('AWBDIR_' + awb);
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  const rx = new RegExp('^AWB ' + awb.replace(/[-]/g, '\\-') + '( |$)');
  const consultas = ["title = 'AWB " + awb + "' and trashed = false",
                     "title contains 'AWB " + awb + "' and trashed = false"];
  for (const q of consultas) {
    const it = DriveApp.searchFolders(q);
    while (it.hasNext()) {
      const f = it.next();
      if (!rx.test(f.getName())) continue;
      const p = f.getParents(); if (!p.hasNext() || !/^S\d{2} /.test(p.next().getName())) continue;
      props.setProperty('AWBDIR_' + awb, f.getId());
      return f;
    }
  }
  return null;
}

/**
 * Vuelo ANTERIOR a la instalación (estructura antigua: documentos sueltos en "Sxx / 13-09", sin carpeta "AWB …").
 * Devuelve { carpeta, ruta } de donde ya están sus documentos; null si el vuelo tiene carpeta "AWB …" o no se conoce.
 * Se sabe por la hoja "Docs IA", que guarda a qué guía pertenece cada documento ya leído.
 */
const _antiguoCache = {};
function carpetaVueloAntiguo_(awb, tipo) {
  const k = awb + '|' + tipo;
  if (_antiguoCache[k] !== undefined) return _antiguoCache[k];
  let out = null;
  try {
    if (!buscarCarpetaAwb_(awb)) {
      const sh = getRegistro_().getSheetByName('Docs IA');
      const filas = (sh && sh.getLastRow() > 1)
        ? sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().filter(r => r[0] && r[1] === awb) : [];
      // una factura de finca cae junto a las otras facturas; un documento del transitario, junto a la guía
      const primero = tipo === 'FINCA' ? ['FINCA'] : ['GUIA', 'MASTER', 'FLETE'];
      filas.sort((a, b) => (primero.indexOf(a[2]) >= 0 ? 0 : 1) - (primero.indexOf(b[2]) >= 0 ? 0 : 1));
      for (const r of filas) {
        let f;
        try { f = DriveApp.getFileById(r[0]); } catch (e) { continue; }
        if (f.isTrashed()) continue;
        const p = f.getParents();
        if (!p.hasNext()) continue;
        const carpeta = p.next(), nombres = [];
        let c = carpeta, enSemana = false;
        for (let i = 0; i < 6 && c; i++) {
          nombres.unshift(c.getName());
          if (/^S\d{2} /.test(c.getName())) enSemana = true;
          if (c.getName() === FOLDERS.IMPORTACION) break;
          const pp = c.getParents();
          c = pp.hasNext() ? pp.next() : null;
        }
        // solo vale si cuelga de una semana de "01 Importación" (no "Por proveedor" ni otras carpetas)
        if (enSemana && nombres[0] === FOLDERS.IMPORTACION) { out = { carpeta: carpeta, ruta: nombres }; break; }
      }
    }
  } catch (e) { Logger.log('Vuelo antiguo ' + awb + ': ' + e); }
  return (_antiguoCache[k] = out);
}

/** Fecha de la factura (leída del PDF) si es más de 3 días anterior al correo; null si no se ve o es reciente. */
function fechaFacturaAtrasada_(fechaCorreo, leer) {
  const r = leer();
  if (!r || r.tipo !== 'FACTURA' || !/^\d{4}-\d{2}-\d{2}$/.test(r.fecha || '')) return null;
  const p = r.fecha.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2], 12);
  const dias = (fechaCorreo.getTime() - d.getTime()) / 864e5;
  return (dias > 3 && dias < 400) ? d : null;
}

/** ¿La ruta cae en una semana que revisarVuelos ya no mira (más antigua que las últimas VUELOS.SEMANAS)? */
function semanaFueraDeRevision_(ruta) {
  const sem = ruta.filter(x => /^S\d{2} \(/.test(x))[0];
  if (!sem) return false;
  const n = (typeof VUELOS !== 'undefined' && VUELOS.SEMANAS) || 3, hoy = Date.now();
  for (let i = 0; i < n; i++) if (semana_(new Date(hoy - i * 7 * 86400000)).nombre === sem) return false;
  return true;
}

/** Lee lo justo de una factura atrasada y crea su acceso en "Por proveedor / <proveedor> / Pendientes de pago". */
function accesoPagoAtrasado_(file, awb) {
  if (typeof leerFacturaLigera_ !== 'function' || typeof crearAccesoPago_ !== 'function') return;
  try {
    const r = leerFacturaLigera_(file);
    if (!r) return;
    const doc = { awb: awb, tipo: r._tipo, data: r, nombre: file.getName() };
    guardarDoc_(file, awb, doc);
    crearAccesoPago_(file, doc);
  } catch (e) { Logger.log('Acceso de pago de ' + file.getName() + ': ' + e); }
}

/** Nombre corto del transitario para la carpeta del vuelo */
function transitarioCorto_(proveedor) {
  if (typeof nombreTransitario_ === 'function') return nombreTransitario_(proveedor);
  return String(proveedor || '').trim();
}

function volcarCarpeta_(origen, destino) {
  const fi = origen.getFiles();
  while (fi.hasNext()) fi.next().moveTo(destino);
  const fo = origen.getFolders();
  while (fo.hasNext()) {
    const sub = fo.next();
    const ex = destino.getFoldersByName(sub.getName());
    if (ex.hasNext()) volcarCarpeta_(sub, ex.next()); else sub.moveTo(destino);
  }
  origen.setTrashed(true);
}

/** Fecha de vuelo en el asunto: 2026-09-23, 23/09/2026 o 23-09-2026 */
function extraerFechaVuelo_(texto) {
  let m = String(texto).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  m = String(texto).match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12);
  // "11 NOV 2026 AWB 075-…" (Logike, Saftec, Ecuador Cargo)
  m = String(texto).match(/\b(\d{1,2})[\s.\-]*(ENE|JAN|FEB|MAR|ABR|APR|MAY|JUN|JUL|AGO|AUG|SEP|SET|OCT|NOV|DIC|DEC)[A-Z]*\.?[\s.\-]*(20\d{2}|\d{2})\b/i);
  if (m) {
    const mes = { ENE: 0, JAN: 0, FEB: 1, MAR: 2, ABR: 3, APR: 3, MAY: 4, JUN: 5, JUL: 6, AGO: 7, AUG: 7, SEP: 8, SET: 8, OCT: 9, NOV: 10, DIC: 11, DEC: 11 }[m[2].toUpperCase()];
    const an = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(an, mes, Number(m[1]), 12);
  }
  return null;
}

/** Gemini lee el MAWB dentro de una factura de finca. Devuelve '075-12345678' o ''. */
function geminiAwbDeFactura_(blob, mime) {
  if (!iaDisponible_()) return '';
  const prompt =
    'Esta es una factura de una finca de flores o de un transitario de carga (Ecuador o Colombia) a un importador español. ' +
    'Busca el número de guía aérea MASTER (MAWB / AWB / Guía Master; NO la guía hija HAWB). ' +
    'Tiene 11 dígitos: 3 de aerolínea + 8 (ej. 075-6800 9826); a veces aparece sin guiones (07568080891). ' +
    'Cópialo cifra a cifra EXACTAMENTE como está impreso, sin cambiar el orden de ninguna cifra. ' +
    'Responde SOLO con JSON: {"mawb": "XXX-XXXXXXXX" o ""}';
  const norm = r => {
    const m = String((r && r.mawb) || '').match(/(\d{3})[-\s]?(\d{4})[-\s]?(\d{4})/);
    return m ? m[1] + '-' + m[2] + m[3] : '';
  };
  let awb = norm(iaJson_(prompt, blob, mime));
  if (awb && awbValido_(awb)) return awb;
  // Dígito de control incorrecto (o nada): segunda lectura con el modelo más preciso
  const modelo = (typeof VUELOS !== 'undefined' && VUELOS.MODELO_FACTURAS) || null;
  const awb2 = norm(iaJson_(prompt + (awb ? ' ATENCIÓN: en una primera lectura leíste ' + awb +
    ', que no es una guía válida (su dígito de control no cuadra): alguna cifra está mal o cambiada de orden.' : ''), blob, mime, 2000, modelo));
  if (awb2 && awbValido_(awb2)) return awb2;
  Logger.log('Guía no válida leída en la factura: ' + (awb2 || awb || '(ninguna)'));
  return '';                                        // mejor en _Sin vuelo asignado que en un vuelo inventado
}

// ─────────────────────────── IA: Claude (preferente) o Gemini ───────────────────────────
// Usa CLAUDE_API_KEY si existe en Propiedades del script; si no, GEMINI_API_KEY.
function iaDisponible_() {
  const p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('CLAUDE_API_KEY') || p.getProperty('GEMINI_API_KEY'));
}

function iaJson_(prompt, blob, mime, maxTokens, modelo) {
  const p = PropertiesService.getScriptProperties();
  const claude = p.getProperty('CLAUDE_API_KEY');
  const gemini = p.getProperty('GEMINI_API_KEY');
  const leer = txt => {
    if (!txt) return null;
    try {
      const clean = txt.replace(/```json|```/g, '').trim();
      const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
      return JSON.parse(a >= 0 ? clean.slice(a, b + 1) : clean);
    } catch (e) { Logger.log('Respuesta IA no válida: ' + String(txt).slice(0, 300)); return null; }
  };
  let r = null;
  // 1) modelo más potente (facturas): más margen de tokens porque "piensa" antes de responder
  if (claude && modelo) r = leer(llamarClaude_(claude, prompt, blob, mime, Math.max(16000, maxTokens || 0), modelo));
  // 2) modelo de siempre (o si el potente falla / responde vacío)
  if (!r && claude) r = leer(llamarClaude_(claude, prompt, blob, mime, maxTokens));
  // 3) Gemini de respaldo
  if (!r && gemini) r = leer(llamarGemini_(gemini, prompt, blob, mime));
  return r;
}

function llamarClaude_(key, prompt, blob, mime, maxTokens, modelo) {
  try {
    const content = [];
    if (blob) {
      const data = Utilities.base64Encode(blob.getBytes());
      if (mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data } });
      else content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: data } });
    }
    content.push({ type: 'text', text: prompt });
    const res = fetchConReintento_('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // Los modelos nuevos (familia 5) no aceptan "temperature": solo se envía a los modelos 4.x
      payload: JSON.stringify(Object.assign({ model: modelo || CONFIG.CLAUDE_MODEL, max_tokens: maxTokens || 300,
        messages: [{ role: 'user', content: content }] }, /-4-/.test(modelo || CONFIG.CLAUDE_MODEL) ? { temperature: 0 } : {}))
    });
    if (res.getResponseCode() !== 200) { Logger.log('Claude ' + res.getResponseCode() + ': ' + res.getContentText()); return null; }
    return JSON.parse(res.getContentText()).content.map(c => c.text || '').join('');
  } catch (e) { Logger.log('Error Claude: ' + e); return null; }
}

function llamarGemini_(key, prompt, blob, mime) {
  try {
    const parts = [];
    if (blob) parts.push({ inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } });
    parts.push({ text: prompt });
    const res = fetchConReintento_(
      'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + key,
      { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }) });
    if (res.getResponseCode() !== 200) { Logger.log('Gemini ' + res.getResponseCode() + ': ' + res.getContentText()); return null; }
    return JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
  } catch (e) { Logger.log('Error Gemini: ' + e); return null; }
}

/** Reintenta hasta 3 veces si el servicio está saturado (429, 500, 503, 529). */
function fetchConReintento_(url, opts) {
  let res;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(url, opts);
    const c = res.getResponseCode();
    if ([429, 500, 503, 529].indexOf(c) < 0) return res;
    Utilities.sleep(3000 * (i + 1));
  }
  return res;
}

/** Prueba rápida: ejecútala y mira el registro. */
function probarIA() {
  const p = PropertiesService.getScriptProperties();
  Logger.log('Proveedor: ' + (p.getProperty('CLAUDE_API_KEY') ? 'Claude' : (p.getProperty('GEMINI_API_KEY') ? 'Gemini' : 'NINGUNO')));
  const r = iaJson_('Responde SOLO con JSON: {"ok": true}', null, null);
  Logger.log(r && r.ok ? '✅ La IA responde correctamente' : '❌ No responde: revisa la clave (ver mensajes anteriores)');
}

function semana_(fecha) {
  const p = fmt_(fecha, 'yyyy-MM-dd').split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const lun = new Date(d); lun.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const dom = new Date(lun); dom.setUTCDate(lun.getUTCDate() + 6);
  const jue = new Date(lun); jue.setUTCDate(lun.getUTCDate() + 3);
  const ini = new Date(Date.UTC(jue.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((jue - ini) / 86400000 + 1) / 7);
  const dm = x => ('0' + x.getUTCDate()).slice(-2) + '-' + ('0' + (x.getUTCMonth() + 1)).slice(-2);
  return { anio: jue.getUTCFullYear(), nombre: 'S' + ('0' + n).slice(-2) + ' (' + dm(lun) + ' a ' + dm(dom) + ')' };
}

function rutaVuelo_(awb, fecha, nombre) {
  const base = awbBase_(awb, fecha);
  if (/awb|gu[ií]a|(^|[^a-z])cr([^a-z]|$)|exr|peso|weight|listado|manifest|packing|lista/i.test(nombre)) return base.concat(['Documentos vuelo']);
  if (/\.(xlsx?|csv)$/i.test(nombre)) return base;
  return base.concat(['Facturas fincas']);
}

function nombreUnico_(carpeta, nombre) {
  if (!carpeta.getFilesByName(nombre).hasNext()) return nombre;
  const m = nombre.match(/^(.*?)(\.[^.]+)?$/);
  for (let i = 2; i < 100; i++) {
    const n = m[1] + '-' + i + (m[2] || '');
    if (!carpeta.getFilesByName(n).hasNext()) return n;
  }
  return nombre;
}

/**
 * PRUEBA (no mueve ni crea nada): simula cómo se archivaría la nómina de septiembre de Juan
 * y escribe en el registro de ejecución la carpeta de destino.
 */
function probarNomina() {
  const file = DriveApp.getFileById('1q3NrzIcDksRcYhNBdJ302yDOI92XiYJA');
  nombreActual_ = file.getName();
  asuntoActual_ = 'NÓMINAS SEPTIEMBRE 2026';
  let ruta = rutaDestino_('ESPAÑA', 'Miras', new Date(), '', false);
  const esNomina = esRutaNominas_(ruta);
  if (esNomina) ruta = ruta.concat(carpetaTrabajador_(file.getBlob()));
  nombreActual_ = ''; asuntoActual_ = '';
  Logger.log('¿Detectada como nómina? ' + (esNomina ? 'SÍ' : 'NO'));
  Logger.log('Se guardaría en: Buscaflor / ' + ruta.join(' / '));
}

/** ¿La ruta es la carpeta de nóminas (06 Personal / Nóminas)? */
function esRutaNominas_(ruta) { return ruta.length === 2 && ruta[0] === FOLDERS.PERSONAL && ruta[1] === 'Nóminas'; }

/**
 * Subcarpeta del trabajador dentro de 06 Personal / Nóminas (p. ej. "Juan Girona").
 * La IA lee el nombre del trabajador en la nómina; se usa la carpeta que ya exista para esa persona
 * (todas las palabras de la carpeta aparecen en su nombre completo) o se crea "Nombre PrimerApellido".
 * Si la nómina es de varios trabajadores o no se puede leer, se queda en Nóminas (sin subcarpeta).
 */
function carpetaTrabajador_(blob) {
  if (!iaDisponible_()) return [];
  const r = iaJson_('Es una nómina española (recibo de salarios). Responde SOLO JSON: {"trabajadores":[{"nombre":"nombre de pila",' +
    '"apellidos":"apellidos"}]} con cada trabajador que aparezca (normalmente uno; en el recibo suele venir como "APELLIDOS, NOMBRE").',
    blob, 'application/pdf', 300);
  const t = (r && r.trabajadores) || [];
  if (t.length !== 1 || !t[0].nombre) return [];
  const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const todas = norm(t[0].nombre + ' ' + t[0].apellidos);
  const base = getOrCreatePath_([FOLDERS.PERSONAL, 'Nóminas']);
  const it = base.getFolders();
  while (it.hasNext()) {
    const n = it.next().getName();
    const pal = norm(n);
    if (pal.length && pal.every(p => todas.indexOf(p) >= 0)) return [n];      // "Juan Girona" ⊂ "Juan Antonio Girona Moreno"
  }
  const primera = x => String(x || '').replace(/[,.]/g, ' ').trim().split(/\s+/)[0] || '';
  const tit = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();       // conserva las tildes: "José Pérez"
  return [(tit(primera(t[0].nombre)) + ' ' + tit(primera(t[0].apellidos))).trim()];
}

let nombreActual_ = '';
let asuntoActual_ = '';                                   // asunto del correo que se está guardando (para reglas como la de nóminas)
const NOMINA_REGEX = /(^|[^a-záéíóúñ])n[oóÓ]minas?([^a-záéíóúñ]|$)|payroll/i;
/**
 * Gastos de España: un mes se da por CERRADO cuando ya se ha generado su documento de gastos para la gestoría
 * (Gastos.gs lo genera el día 10 del mes siguiente y apunta cada factura en la hoja "Gastos IA").
 * Una factura de un mes ya cerrado (p. ej. una de septiembre que llega el 14 de octubre) se archiva en el mes en curso,
 * para que entre en el siguiente documento. El nombre del archivo conserva la fecha real de la factura.
 * Si la hoja "Gastos IA" está vacía, se usa la regla del día 10: pasado el día 10, el mes anterior está cerrado.
 */
let _cierreGastos = null;
function cierreGastos_() {                                   // 1er día del primer mes que sigue ABIERTO
  if (_cierreGastos) return _cierreGastos;
  const hoy = new Date();
  let limite = new Date(hoy.getFullYear(), hoy.getMonth() - (hoy.getDate() > 10 ? 0 : 1), 1);
  try {
    const sh = getRegistro_().getSheetByName('Gastos IA');
    if (sh && sh.getLastRow() > 1) {
      const ult = sh.getRange(2, 5, sh.getLastRow() - 1, 1).getValues()
        .map(r => r[0] instanceof Date ? r[0].getTime() : 0).reduce((a, b) => Math.max(a, b), 0);
      if (ult) { const u = new Date(ult); limite = new Date(u.getFullYear(), u.getMonth(), 1); }   // último documento generado
    }
  } catch (e) {}
  return (_cierreGastos = limite);
}
function fechaGasto_(fecha) {
  const d = new Date(fecha);
  return d.getTime() < cierreGastos_().getTime() ? new Date() : d;
}

function rutaDestino_(tipo, proveedor, fecha, awb, esEecc) {
  const y = fmt_(fecha, 'yyyy');
  const ym = fmt_(fecha, 'yyyy-MM');
  const trimestre = 'T' + (Math.floor((Number(fmt_(fecha, 'M')) - 1) / 3) + 1);
  const prov = limpiar_(proveedor);

  // Nóminas de los trabajadores de Buscaflor: 06 Personal / Nóminas (junto a las anteriores), fuera de los gastos con IVA
  if ((tipo === 'ESPAÑA' || tipo === 'OTROS') && NOMINA_REGEX.test(nombreActual_ + ' ' + asuntoActual_)) {
    return [FOLDERS.PERSONAL, 'Nóminas'];
  }

  // Estados de cuenta de proveedores españoles: carpeta propia por proveedor, fuera de los gastos (no son facturas)
  if (esEecc && (tipo === 'ESPAÑA' || tipo === 'OTROS')) return [FOLDERS.GASTOS_ES, 'Estados de cuenta', prov];

  switch (tipo) {
    case 'ESPAÑA': {
      // Trimestre ya mandado a la gestoría: la factura que llega tarde va al mes en curso (entra en el siguiente envío).
      // El nombre del archivo sigue llevando la fecha real de la factura.
      const fg = fechaGasto_(fecha);
      const yG = fmt_(fg, 'yyyy'), ymG = fmt_(fg, 'yyyy-MM'), tG = 'T' + (Math.floor((Number(fmt_(fg, 'M')) - 1) / 3) + 1);
      // Vallinoto va a su carpeta propia: 04 Gastos España / AÑO / Vallinoto / MM
      if (/vallinoto/i.test(proveedor)) return [FOLDERS.GASTOS_ES, yG, 'Vallinoto', fmt_(fg, 'MM')];
      return [FOLDERS.GASTOS_ES, yG, 'Otros gastos', tG, ymG];
    }
    case 'FINCA':
    case 'TRANSITARIO':
      // Estados de cuenta: junto a las facturas pendientes de ese proveedor (01 Importación / Por proveedor / X / Pendientes de pago)
      if (esEecc) {
        const pp = tipo === 'TRANSITARIO' && typeof nombreTransitario_ === 'function' ? nombreTransitario_(proveedor)
                 : (typeof nombreProveedor_ === 'function' ? nombreProveedor_(proveedor) : prov);
        // Grupo Cantiza: el estado de cuenta es del grupo entero → "Grupo Cantiza / Estados de cuenta"
        if (typeof GRUPOS_EMPRESAS !== 'undefined' && GRUPOS_EMPRESAS[pp]) return [FOLDERS.IMPORTACION, 'Por proveedor', pp, 'Estados de cuenta'];
        return [FOLDERS.IMPORTACION, 'Por proveedor', pp || prov, 'Pendientes de pago'];
      }
      if (awb && tipo === 'FINCA') return awbBase_(awb, fecha).concat(['Facturas fincas']);
      if (awb) { // transitario: solo lo que parece factura va a "Facturas transporte"; el resto son documentos del vuelo
        return /invoice|factura|fact|\binv\b|fv[-_ ]|abono|credit note|nota de cr[eé]dito/i.test(nombreActual_) ? awbBase_(awb, fecha).concat(['Facturas transporte'])
                                                 : awbBase_(awb, fecha).concat(['Documentos vuelo']);
      }
      return [FOLDERS.IMPORTACION, y, FOLDERS.SIN_VUELO, prov];
    case 'TPV':
      return [FOLDERS.VENTAS, 'Tickets TPV', y, ym];
    case 'OTROS':
      return [FOLDERS.EMPRESA, '_Entrada', ym];
    default:
      return [FOLDERS.REGISTRO, FOLDERS.PENDIENTE];
  }
}

function extraerAwbs_(texto) {
  const set = {};
  let m;
  AWB_REGEX.lastIndex = 0;
  while ((m = AWB_REGEX.exec(texto)) !== null) {
    const awb = (m[1] === '729' ? '729' : '075') + '-' + m[2] + m[3];
    if (awbValido_(awb)) set[awb] = true;           // descarta números que no son una guía real
  }
  return Object.keys(set);
}

/**
 * Dígito de control IATA de una guía aérea: la última cifra es el resto de dividir entre 7
 * las 7 cifras anteriores del número de serie. 075-6808089 1 → 6808089 % 7 = 1 ✔
 * Detecta cifras mal leídas o cambiadas de orden (p. ej. 075-68008891 en vez de 075-68080891).
 */
function awbValido_(awb) {
  const d = String(awb || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  return Number(d.slice(3, 10)) % 7 === Number(d.slice(10));
}

// Cuando clasificas un remitente que estaba PENDIENTE, sus archivos se recolocan solos.
function reprocesarPendientes_(ctx, t0) {
  const sh = ctx.ss.getSheetByName('Archivos');
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const data = sh.getRange(2, 1, n, 11).getValues();
  data.forEach((row, i) => {
    if (Date.now() - t0 > CONFIG.MAX_RUNTIME_MS / 2) return;
    if (row[3] !== 'PENDIENTE') return;
    if (CONFIG.PROPIOS.indexOf(String(row[1]).toLowerCase()) >= 0 && row[4]) {
      try {
        const file = DriveApp.getFileById(row[10]);
        const fecha = new Date(row[0]);
        const original = String(row[5]).replace(/^\d{4}-\d{2}-\d{2}_[^_]+_/, '');
        const ruta = rutaVuelo_(row[4], fecha, original);
        const carpeta = getOrCreatePath_(ruta);
        file.moveTo(carpeta);
        file.setName(nombreUnico_(carpeta, fmt_(fecha, 'yyyy-MM-dd') + '_' + original));
        sh.getRange(i + 2, 3, 1, 5).setValues([['VUELO', 'VUELO', row[4], file.getName(), ruta.join(' / ')]]);
      } catch (e) { Logger.log('No se pudo recolocar ' + row[5] + ': ' + e); }
      return;
    }
    const rem = buscarRemitente_(row[1], ctx);
    if (!rem || rem.tipo === 'PENDIENTE') return;
    try {
      const file = DriveApp.getFileById(row[10]);
      if (rem.tipo === 'IGNORAR' || rem.tipo === 'PUBLICIDAD') {
        file.setTrashed(true);
        sh.getRange(i + 2, 4).setValue(rem.tipo + ' (eliminado)');
        return;
      }
      const fecha = new Date(row[0]);
      let asuntoOrig = '';
      try { asuntoOrig = GmailApp.getMessageById(row[9]).getSubject() || ''; } catch (e) {}
      // Documentos que no se guardan nunca (avisos de combustible de Getru, ofertas…): a la papelera
      const nombreOrig = String(row[5]).replace(/^\d{4}-\d{2}-\d{2}_[^_]+_/, '');
      if (DESCARTAR_REGEX.test(nombreOrig) || DESCARTAR_REGEX.test(asuntoOrig)) {
        file.setTrashed(true);
        sh.getRange(i + 2, 3, 1, 2).setValues([[rem.proveedor || row[2], rem.tipo + ' (descartado)']]);
        try {
          const msg = GmailApp.getMessageById(row[9]), th = msg.getThread();
          th.removeLabel(label_(LABELS.PENDIENTE)); th.removeLabel(label_(LABELS.REVISAR)); msg.markRead();
        } catch (e) {}
        return;
      }
      let awbs = extraerAwbs_(file.getName());
      if (!awbs.length) awbs = extraerAwbs_(asuntoOrig);
      const leer = lectorDoc_(() => file.getBlob(), ctx);
      const esEecc = !awbs.length && esEstadoCuenta_(file.getName(), asuntoOrig, rem.tipo, leer);
      const tipoArch = tipoDeArchivo_(rem.tipo, file.getMimeType() === 'application/pdf' ? nombreOrig.replace(/(\.pdf)?$/i, '.pdf') : nombreOrig, asuntoOrig, esEecc, leer);
      const fechaDoc = (esEecc || file.getMimeType() !== 'application/pdf' || esAlbaran_(nombreOrig, asuntoOrig)) ? fecha
        : fechaFactura_(nombreOrig, fecha, tipoArch, leer);
      // Facturas de fincas/transitarios sin AWB en el nombre ni en el asunto: la IA lo lee dentro del PDF
      // (igual que cuando el remitente ya estaba clasificado al llegar el correo)
      if (!awbs.length && !esEecc && (rem.tipo === 'FINCA' || rem.tipo === 'TRANSITARIO') &&
          file.getMimeType() === 'application/pdf' && ctx.llamadasGemini < CONFIG.MAX_GEMINI_CALLS) {
        ctx.llamadasGemini++;
        const a = geminiAwbDeFactura_(file.getBlob(), 'application/pdf');
        if (a) awbs = [a];
      }
      nombreActual_ = file.getName();
      asuntoActual_ = asuntoOrig;
      transitarioActual_ = rem.tipo === 'TRANSITARIO' ? transitarioCorto_(rem.proveedor || row[2]) : '';
      let ruta = rutaDestino_(tipoArch, rem.proveedor || row[2], fechaDoc, awbs.length === 1 ? awbs[0] : '', esEecc);
      asuntoActual_ = ''; transitarioActual_ = '';
      if (esRutaNominas_(ruta) && file.getMimeType() === 'application/pdf') ruta = ruta.concat(carpetaTrabajador_(file.getBlob()));
      const original = String(row[5]).replace(/^\d{4}-\d{2}-\d{2}_[^_]+_/, '');
      const nuevoNombre = (/vallinoto/i.test(rem.proveedor || '') ? nombreVallinoto_(original, file.getBlob()) : null)
        || fmt_(fechaDoc, 'yyyy-MM-dd') + '_' + limpiar_(rem.proveedor || row[2]) + '_' + original;
      file.moveTo(getOrCreatePath_(ruta));
      file.setName(nuevoNombre);
      sh.getRange(i + 2, 3, 1, 5).setValues([[rem.proveedor || row[2], tipoArch, awbs[0] || '', nuevoNombre, ruta.join(' / ')]]);
      try {
        const msg = GmailApp.getMessageById(row[9]);
        const th = msg.getThread();
        th.removeLabel(label_(LABELS.PENDIENTE));
        if (LABELS[rem.tipo]) th.addLabel(label_(LABELS[rem.tipo]));
        if (ruta.indexOf(FOLDERS.SIN_VUELO) < 0) { msg.markRead(); th.removeLabel(label_(LABELS.REVISAR)); }
      } catch (e) { /* correo borrado: no pasa nada */ }
    } catch (e) {
      Logger.log('No se pudo recolocar ' + row[5] + ': ' + e);
    }
  });
}

/**
 * Revisa "01 Importación / AÑO / _Sin vuelo asignado / <proveedor>" en cada pasada.
 * Si encuentra el AWB de una factura (en el registro, en el nombre o leyéndolo con la IA),
 * la mueve a la carpeta de su vuelo (AWB … / Facturas fincas o Facturas transporte), igual que
 * si hubiera llegado con el AWB a la vista. La IA lee cada PDF UNA sola vez: si no encuentra guía,
 * el archivo se queda aquí para que lo muevas tú (no se vuelve a gastar lectura en él).
 */
function recolocarSinVuelo_(ctx, t0) {
  const props = PropertiesService.getScriptProperties();
  const sh = ctx.ss.getSheetByName('Archivos');
  const n = sh.getLastRow() - 1;
  const filaDe = {};                                  // FileId → nº de fila en "Archivos"
  const datos = n > 0 ? sh.getRange(2, 1, n, 11).getValues() : [];
  datos.forEach((r, i) => { if (r[10]) filaDe[r[10]] = i; });

  const y = Number(fmt_(new Date(), 'yyyy'));
  [y, y - 1].forEach(anio => {
    let raiz;
    try {
      const it = getOrCreatePath_([FOLDERS.IMPORTACION]).getFoldersByName(String(anio));
      if (!it.hasNext()) return;
      const sv = it.next().getFoldersByName(FOLDERS.SIN_VUELO);
      if (!sv.hasNext()) return;
      raiz = sv.next();
    } catch (e) { return; }

    const provs = raiz.getFolders();
    while (provs.hasNext()) {
      const carpetaProv = provs.next();
      const files = carpetaProv.getFiles();
      while (files.hasNext()) {
        if (Date.now() - t0 > CONFIG.MAX_RUNTIME_MS / 2) return;
        const file = files.next();
        const id = file.getId();
        const i = filaDe[id];
        const row = i === undefined ? null : datos[i];

        // 1) AWB ya anotado en el registro o en el nombre del archivo
        let awb = row && /^\d{3}-\d{8}$/.test(String(row[4])) ? String(row[4]) : '';
        if (!awb) { const a = extraerAwbs_(file.getName()); if (a.length === 1) awb = a[0]; }
        // 2) Si no, la IA lo lee dentro del PDF (una sola vez por archivo)
        const clave = 'SV_' + id;
        if (!awb && file.getMimeType() === 'application/pdf' && !props.getProperty(clave) &&
            !EECC_REGEX.test(file.getName()) && ctx.llamadasGemini < CONFIG.MAX_GEMINI_CALLS) {
          ctx.llamadasGemini++;
          awb = geminiAwbDeFactura_(file.getBlob(), 'application/pdf');
          props.setProperty(clave, awb || 'SIN AWB');
        }
        if (!awb) continue;

        const tipo = row && (row[3] === 'TRANSITARIO' || row[3] === 'FINCA') ? row[3] : 'FINCA';
        const proveedor = (row && row[2]) || carpetaProv.getName();
        const fecha = row && row[0] ? new Date(row[0]) : file.getDateCreated();
        nombreActual_ = file.getName();
        transitarioActual_ = tipo === 'TRANSITARIO' ? transitarioCorto_(proveedor) : '';
        const ruta = rutaDestino_(tipo, proveedor, fecha, awb, false);
        transitarioActual_ = '';
        if (ruta.indexOf(FOLDERS.SIN_VUELO) >= 0) continue;
        const destino = getOrCreatePath_(ruta);
        const nombreFinal = nombreUnico_(destino, file.getName());   // por si ya hay uno igual en el vuelo
        file.moveTo(destino);
        if (nombreFinal !== file.getName()) file.setName(nombreFinal);
        props.deleteProperty(clave);
        if (row) {
          sh.getRange(i + 2, 5, 1, 3).setValues([[awb, file.getName(), ruta.join(' / ')]]);
          try {
            const msg = GmailApp.getMessageById(row[9]);
            msg.markRead(); msg.getThread().removeLabel(label_(LABELS.REVISAR));
          } catch (e) { /* correo borrado: no pasa nada */ }
        }
        Logger.log('Recolocado desde _Sin vuelo asignado: ' + file.getName() + ' → ' + ruta.join(' / '));
      }
      // carpeta del proveedor vacía: fuera
      if (!carpetaProv.getFiles().hasNext() && !carpetaProv.getFolders().hasNext()) carpetaProv.setTrashed(true);
    }
  });
}

// ─────────────────────────────── AVISOS ───────────────────────────────

function revisarAlertas_(msg, thread, tipo, from, asunto, cuerpo, guardados, ctx) {
  let motivo = '';
  // Para proveedores conocidos solo se mira el asunto (sus pies de correo generan falsos avisos)
  const textoAlerta = ['FINCA', 'TRANSITARIO', 'ESPAÑA', 'TPV'].indexOf(tipo) >= 0 ? asunto : asunto + ' ' + cuerpo;
  if (ALERTA_REGEX.test(textoAlerta)) {
    motivo = 'Posible reclamación, impago o requerimiento oficial';
  } else if (['FINCA', 'TRANSITARIO', 'ESPAÑA'].indexOf(tipo) >= 0 && ctx.llamadasGemini < CONFIG.MAX_GEMINI_CALLS) {
    ctx.llamadasGemini++;
    const r = geminiRequiereRespuesta_(from, asunto, cuerpo);
    if (r && r.requiere_respuesta) motivo = 'Pide respuesta: ' + (r.motivo || '');
  }
  if (!motivo) return '';

  thread.addLabel(label_(LABELS.ATENCION));
  const enlace = 'https://mail.google.com/mail/#all/' + thread.getId();
  const adj = guardados.length
    ? '<p><b>Adjuntos guardados:</b><br>' + guardados.map(g => '<a href="' + g.url + '">' + g.nombre + '</a>').join('<br>') + '</p>'
    : '';
  MailApp.sendEmail({
    to: CONFIG.ALERT_EMAIL,
    subject: '[Buzón Buscaflor] Requiere atención: ' + asunto,
    htmlBody:
      '<p><b>Motivo:</b> ' + escapar_(motivo) + '</p>' +
      '<p><b>De:</b> ' + escapar_(msg.getFrom()) + '<br><b>Fecha:</b> ' + fmt_(msg.getDate(), 'dd/MM/yyyy HH:mm') + '</p>' +
      '<p><b>Asunto:</b> ' + escapar_(asunto) + '</p>' +
      '<p style="color:#555">' + escapar_(cuerpo.slice(0, 400)) + '…</p>' + adj +
      '<p><a href="' + enlace + '">Abrir el correo</a> (con la sesión de facturasbuscaflor@)</p>'
  });
  ctx.nuevosAvisos.push([new Date(), from, asunto, motivo, enlace]);
  return motivo;
}

function geminiRequiereRespuesta_(from, asunto, cuerpo) {
  const prompt =
    'Eres el asistente de una importadora de flor cortada. Decide si este correo de un proveedor ' +
    'pide una respuesta o acción a la empresa (una pregunta, confirmar un pedido, aprobar algo, un dato que falta, ' +
    'un cambio de precio, un problema con un envío). Las facturas, albaranes, ofertas o avisos automáticos sin pregunta NO ' +
    'requieren respuesta. Responde SOLO con JSON: {"requiere_respuesta": true|false, "motivo": "frase corta en español"}\n\n' +
    'Remitente: ' + from + '\nAsunto: ' + asunto + '\nTexto:\n' + cuerpo.slice(0, 2000);
  return iaJson_(prompt, null, null);
}

/**
 * Aplica la regla leído / no leído a los correos ya procesados (últimos N días).
 * Ejecútala una vez tras actualizar el script.
 */
function revisarLeidos(dias) {
  dias = dias || 14;
  const ctx = cargarContexto_();
  const arc = ctx.ss.getSheetByName('Archivos');
  const porMsg = {};
  if (arc.getLastRow() > 1) arc.getRange(2, 1, arc.getLastRow() - 1, 11).getValues().forEach(r => {
    (porMsg[r[9]] = porMsg[r[9]] || []).push(r);
  });
  const avisos = {};
  const av = ctx.ss.getSheetByName('Avisos');
  if (av.getLastRow() > 1) av.getRange(2, 5, av.getLastRow() - 1, 1).getValues().forEach(r => { avisos[String(r[0]).split('/').pop()] = true; });
  let leidos = 0, revisar = 0;
  GmailApp.search('newer_than:' + dias + 'd -in:sent -in:chats', 0, 200).forEach(th => {
    th.getMessages().forEach(m => {
      if (!ctx.procesados[m.getId()]) return;
      const from = extraerEmail_(m.getFrom());
      const rem = buscarRemitente_(from, ctx);
      const tipo = rem ? rem.tipo : 'PENDIENTE';
      const filas = porMsg[m.getId()] || [];
      let ok;
      if (tipo === 'IGNORAR' || tipo === 'PUBLICIDAD') ok = true;
      else ok = tipo !== 'PENDIENTE' && filas.length > 0 && !avisos[th.getId()] &&
        filas.every(r => String(r[3]) !== 'PENDIENTE' && String(r[6]).indexOf(FOLDERS.SIN_VUELO) < 0 &&
          String(r[6]).indexOf(FOLDERS.PENDIENTE) < 0 && String(r[5]).indexOf('(sin adjuntos') !== 0);
      if (ok) { m.markRead(); leidos++; }
      else { m.markUnread(); th.addLabel(label_(LABELS.REVISAR)); revisar++; }
    });
  });
  Logger.log('Marcados como leídos: ' + leidos + ' · Sin leer para revisar: ' + revisar);
}

function aprenderRemitentes(dias) {
  dias = dias || 90;
  const ctx = cargarContexto_();
  ctx.promos = {};
  GmailApp.search('category:promotions newer_than:' + dias + 'd', 0, 500).forEach(th => ctx.promos[th.getId()] = true);
  let start = 0;
  while (start < 1000) {
    const threads = GmailApp.search('newer_than:' + dias + 'd -in:sent -in:chats', start, 100);
    if (!threads.length) break;
    threads.forEach(th => th.getMessages().forEach(m => {
      const from = extraerEmail_(m.getFrom());
      if (!buscarRemitente_(from, ctx)) {
        registrarRemitenteNuevo_(from, m.getSubject(), ctx, esPublicidad_(m, th, ctx) ? 'PUBLICIDAD' : 'PENDIENTE');
      }
    }));
    start += 100;
  }
  guardarContexto_(ctx);
}

function buscarRemitente_(email, ctx) {
  email = String(email).toLowerCase();
  return ctx.remitentes[email] || ctx.remitentes['@' + email.split('@')[1]] || null;
}

function registrarRemitenteNuevo_(email, asunto, ctx, tipo) {
  tipo = tipo || 'PENDIENTE';
  const nota = tipo === 'PUBLICIDAD' ? '(auto-publicidad) ' : '';
  ctx.remitentes[email] = { tipo: tipo, proveedor: '', fila: null };
  ctx.nuevosRemitentes.push([email, tipo, '', nota + (asunto || '').slice(0, 120), new Date(), 1]);
}

/**
 * Publicidad de un remitente conocido. Solo se descarta si se cumplen las dos cosas:
 *  1) el correo trae enlace de baja (List-Unsubscribe) o Gmail lo pone en Promociones, y
 *  2) no hay nada que parezca una factura o documento de vuelo: ningún PDF, o solo PDFs
 *     con nombre de catálogo/oferta, y ni asunto ni adjuntos hablan de factura, AWB o estado de cuenta.
 * Ante la duda, NO se descarta (se archiva como siempre).
 */
const FACTURA_REGEX = /invoice|factura|fact|\binv\b|fv[-_ ]|awb|gu[ií]a|statement|estado de cuenta|abono|credit note|nota de cr[eé]dito/i;
const PROMO_ADJ_REGEX = /cat[aá]logo|catalog|availability|disponibilidad|price ?list|lista de precios|oferta|promo|newsletter|brochure/i;

const ALBARAN_REGEX = /albar[aá]n|albaran|delivery ?note|nota de entrega|\balb[\._ -]/i;
const DESCARTAR_REGEX = /sales-history|historial de ventas|offering|\boffers?\b|\bofertas?\b|availability|disponibilidad|price ?list|lista de precios|brandstof/i;   // se descartan (no se guardan): historiales de Verdnatura, ofertas/disponibilidad de fincas y avisos semanales de recargo de combustible de Getru ("Brandstofclausule", "Brandstoftoeslag")
// Facturas de Vallinoto: el archivo se llama solo con su nº de factura (ej. "2612051.pdf").
// Si el adjunto no lo trae en el nombre (p. ej. un escaneo "20260924121247670.pdf"), se lee con la IA.
function nombreVallinoto_(nombre, blobOrAtt) {
  const ext = (String(nombre).match(/\.[a-z0-9]+$/i) || ['.pdf'])[0].toLowerCase();
  const m = String(nombre).match(/(?:^|\D)(2\d{6})(?:\D|$)/);            // nº Vallinoto: 7 cifras que empiezan por 2 (26xxxxx)
  if (m && String(nombre).replace(/\D/g, '').length <= 8) return m[1] + ext;
  if (ext === '.pdf' && iaDisponible_()) {
    try {
      const blob = blobOrAtt.copyBlob ? blobOrAtt.copyBlob() : blobOrAtt;
      const r = iaJson_('Documento de VALLINOTO (agente de aduanas). Responde SOLO JSON: {"tipo":"FACTURA|DUA|OTRO",' +
        '"numero":"si es FACTURA: nº de factura, solo cifras (ej. 2612051)","awb":"si es DUA/certificado de importación: nº de guía 075-XXXXXXXX"}.',
        blob, 'application/pdf', 150);
      const n = String((r && r.numero) || '').replace(/\D/g, '');
      if (r && r.tipo === 'FACTURA' && n) return n + ext;
      const a = String((r && r.awb) || '').match(/(\d{3})[-\s]?(\d{4})[-\s]?(\d{4})/);
      if (r && r.tipo === 'DUA') return null;   // DUA / certificado de importación: no se guarda (el IVA va en la factura de Vallinoto)
    } catch (e) {}
  }
  return limpiar_(nombre);                                                // si no hay forma de saberlo, el nombre original
}

function esAlbaran_(nombre, asunto) {
  if (FACTURA_REGEX.test(nombre)) return false;           // el adjunto se llama "factura…": es factura
  return ALBARAN_REGEX.test(nombre) || (ALBARAN_REGEX.test(asunto) && !FACTURA_REGEX.test(asunto));
}

const OFERTA_ASUNTO = /\boffers?\b|offering|\bofertas?\b|availability|disponibilidad|price ?list|lista de precios|\bspecials?\b|\bpromo(tion|tions|ci[oó]n|ciones)?\b/i;

/** Correo de oferta / disponibilidad de un proveedor conocido (por el asunto), salvo que traiga una factura o hable de una guía. */
function esOferta_(msg, asunto) {
  if (!OFERTA_ASUNTO.test(asunto)) return false;
  if (FACTURA_REGEX.test(asunto) || extraerAwbs_(asunto).length) return false;
  const adj = msg.getAttachments({ includeInlineImages: false }).map(a => a.getName() || '');
  return !adj.some(n => FACTURA_REGEX.test(n) || extraerAwbs_(n).length);
}

function esPromoDeConocido_(msg, thread, asunto, ctx) {
  let unsubscribe = '';
  try { unsubscribe = msg.getHeader('List-Unsubscribe') || ''; } catch (e) {}
  const esPromo = !!unsubscribe || !!(ctx.promos && ctx.promos[thread.getId()]);
  if (!esPromo) return false;
  if (FACTURA_REGEX.test(asunto) || extraerAwbs_(asunto).length) return false;
  const pdfs = msg.getAttachments({ includeInlineImages: false })
    .map(a => a.getName() || '')
    .filter(n => /\.pdf$/i.test(n));
  if (pdfs.some(n => FACTURA_REGEX.test(n) || extraerAwbs_(n).length)) return false;
  return pdfs.every(n => PROMO_ADJ_REGEX.test(n));
}

/**
 * Publicidad automática (solo para remitentes desconocidos):
 * cabecera List-Unsubscribe o pestaña Promociones de Gmail, y SIN PDF adjunto.
 * Si trae un PDF se deja como PENDIENTE por si fuera una factura.
 */
function esPublicidad_(msg, thread, ctx) {
  const tienePdf = msg.getAttachments({ includeInlineImages: false })
    .some(a => /\.pdf$/i.test(a.getName() || ''));
  if (tienePdf) return false;
  let unsubscribe = '';
  try { unsubscribe = msg.getHeader('List-Unsubscribe') || ''; } catch (e) {}
  return !!unsubscribe || !!(ctx.promos && ctx.promos[thread.getId()]);
}

// ─────────────────────────── CONTEXTO / HOJAS ───────────────────────────

function cargarContexto_() {
  const ss = getRegistro_();
  const ctx = {
    ss: ss, remitentes: {}, procesados: {}, md5: {}, contadores: {}, llamadasGemini: 0,
    nuevosRemitentes: [], nuevosArchivos: [], nuevosAvisos: [], nuevosProcesados: []
  };
  const rem = ss.getSheetByName('Remitentes');
  if (rem.getLastRow() > 1) {
    rem.getRange(2, 1, rem.getLastRow() - 1, 6).getValues().forEach((r, i) => {
      if (!r[0]) return;
      let k = String(r[0]).trim().toLowerCase();
      if (k.indexOf('@') < 0) k = '@' + k;
      ctx.remitentes[k] = { tipo: String(r[1] || 'PENDIENTE').toUpperCase(), proveedor: String(r[2] || '').trim(), fila: i + 2, n: Number(r[5]) || 0 };
    });
  }
  const pro = ss.getSheetByName('Procesados');
  if (pro.getLastRow() > 1) pro.getRange(2, 1, pro.getLastRow() - 1, 1).getValues().forEach(r => ctx.procesados[r[0]] = true);
  const arc = ss.getSheetByName('Archivos');
  if (arc.getLastRow() > 1) arc.getRange(2, 9, arc.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0]) ctx.md5[r[0]] = true; });
  return ctx;
}

function guardarContexto_(ctx) {
  const ap = (name, rows) => {
    if (!rows.length) return;
    const sh = ctx.ss.getSheetByName(name);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  };
  ap('Remitentes', ctx.nuevosRemitentes);
  ap('Archivos', ctx.nuevosArchivos);
  ap('Avisos', ctx.nuevosAvisos);
  ap('Procesados', ctx.nuevosProcesados);
  const rem = ctx.ss.getSheetByName('Remitentes');
  Object.keys(ctx.contadores).forEach(fila => {
    const c = rem.getRange(Number(fila), 6);
    c.setValue((Number(c.getValue()) || 0) + ctx.contadores[fila]);
  });
}

function getRegistro_() {
  const carpeta = getOrCreatePath_([FOLDERS.REGISTRO]);
  const it = carpeta.getFilesByName(CONFIG.REGISTRO_NAME);
  if (it.hasNext()) return SpreadsheetApp.open(it.next());
  const ss = SpreadsheetApp.create(CONFIG.REGISTRO_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(carpeta);
  return ss;
}

// ─────────────────────────────── UTILIDADES ───────────────────────────────

const _folderCache = {};
function getOrCreatePath_(parts) {
  const key = parts.join('/');
  if (_folderCache[key]) return _folderCache[key];
  let f = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  parts.forEach(p => { f = getOrCreateFolder_(f, p); });
  return (_folderCache[key] = f);
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function extraerEmail_(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

function limpiar_(s) {
  return String(s).replace(/[\\/:*?"<>|#\[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function fmt_(d, pattern) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, pattern);
}

/**
 * Huella para detectar duplicados. En los PDF se ignoran las fechas de creación/modificación y el
 * identificador interno, que cambian cada vez que el proveedor vuelve a generar el MISMO documento
 * (p. ej. Floranrosa 001037593 enviada dos veces: idéntica salvo "CreationDate"). Así, una factura
 * reenviada no se guarda dos veces; una versión corregida (contenido distinto) sí se guarda con -2.
 */
function huella_(bytes, nombre) {
  if (!/\.pdf$/i.test(nombre || '')) return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
  const txt = Utilities.newBlob(bytes).getDataAsString('ISO-8859-1')
    .replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '')
    .replace(/<xmp:(CreateDate|ModifyDate|MetadataDate)>[^<]*<\/xmp:\w+>/g, '')
    .replace(/xmp:(CreateDate|ModifyDate|MetadataDate)="[^"]*"/g, '')
    .replace(/xmpMM:(DocumentID|InstanceID)(="[^"]*"|>[^<]*<\/xmpMM:\w+>)/g, '')
    .replace(/\/ID\s*\[\s*<[0-9a-fA-F]*>\s*<[0-9a-fA-F]*>\s*\]/g, '');
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, txt, Utilities.Charset.UTF_8));
}

function hex_(bytes) {
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function escapar_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}