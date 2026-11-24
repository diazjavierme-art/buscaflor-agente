/**
 * Buzón Buscaflor · Petición de estados de cuenta a fincas y transitarios (24-11-2026)
 *
 * - Botón en la app (Resumen › Fincas): deja buscaflor/fincas/peticiones/<id> = {finca, pedido, por}.
 *   Cada 5 minutos este script manda el email y marca la petición como enviada.
 * - Automático: el día 1 de cada mes a las 9:00 pide el estado de cuenta a todas las fincas activas.
 * Envía desde esta cuenta (facturasbuscaflor@gmail.com), responder a expansion@rosasdebuscaflor.com
 * (copia oculta a expansion@), así la respuesta con el PDF entra al buzón y se cruza sola.
 *
 * Instalar: pegar en el proyecto del buzón y ejecutar una vez instalarEstadosCuenta().
 */
var EC_DB = 'https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app/buscaflor/fincas/';
var EC_RESPONDER = 'expansion@rosasdebuscaflor.com';
var EC_ZONA = 'Europe/Madrid';

function instalarEstadosCuenta() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'atenderEstadosCuenta' || h === 'pedirEstadosCuentaMes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('atenderEstadosCuenta').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('pedirEstadosCuentaMes').timeBased().onMonthDay(1).atHour(9).inTimezone(EC_ZONA).create();
}

function ec_fb(metodo, ruta, datos) {
  var o = { method: metodo, muteHttpExceptions: true, contentType: 'application/json' };
  if (datos !== undefined) o.payload = JSON.stringify(datos);
  var r = UrlFetchApp.fetch(EC_DB + ruta + '.json', o);
  if (r.getResponseCode() >= 300) throw new Error('Firebase ' + r.getResponseCode() + ': ' + r.getContentText());
  return JSON.parse(r.getContentText() || 'null');
}
function ec_ahora() { return Utilities.formatDate(new Date(), EC_ZONA, "yyyy-MM-dd'T'HH:mm:ss"); }

function ec_email(c) {
  var hoy = Utilities.formatDate(new Date(), EC_ZONA, 'dd/MM/yyyy');
  var asunto = 'Solicitud de estado de cuenta · Rosas de Buscaflor · ' + hoy;
  var cuerpo = 'Buenos días, equipo de ' + c.nombre + ':\n\n' +
    'Les agradeceríamos que nos enviaran el estado de cuenta actualizado de Rosas de Buscaflor La Mejor S.L. a fecha de hoy, ' +
    'con el detalle de facturas pendientes, notas de crédito y pagos recibidos.\n\n' +
    'Por favor, respondan a este correo con el estado de cuenta en PDF o Excel.\n\n' +
    'Muchas gracias.\n\nUn saludo,\nAdministración · Rosas de Buscaflor La Mejor S.L.\nexpansion@rosasdebuscaflor.com';
  var op = { name: 'Rosas de Buscaflor', replyTo: EC_RESPONDER, bcc: EC_RESPONDER };
  if (c.cc && c.cc.length) op.cc = c.cc.join(',');
  GmailApp.sendEmail(c.para.join(','), asunto, cuerpo, op);
}

// Botón de la app
function atenderEstadosCuenta() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(2000)) return;
  try {
    var pet = ec_fb('GET', 'peticiones') || {}, con = null;
    Object.keys(pet).forEach(function (id) {
      var p = pet[id] || {};
      if (p.enviado || p.error) return;
      con = con || (ec_fb('GET', 'contactos') || {});
      var c = con[p.finca];
      try {
        if (!c || !c.para || !c.para.length) throw new Error('Sin email para ' + p.finca);
        ec_email(c);
        ec_fb('PATCH', 'peticiones/' + id, { enviado: ec_ahora(), para: c.para });
        ec_fb('PATCH', 'contactos/' + p.finca, { ultimaPeticion: ec_ahora() });
      } catch (e) { ec_fb('PATCH', 'peticiones/' + id, { error: String(e.message || e) }); }
    });
  } finally { lock.releaseLock(); }
}

// Día 1 de cada mes: a todas las activas
function pedirEstadosCuentaMes() {
  var con = ec_fb('GET', 'contactos') || {};
  Object.keys(con).forEach(function (k) {
    if (con[k] && con[k].activo) ec_fb('POST', 'peticiones', { finca: k, pedido: ec_ahora(), por: 'automático mensual' });
  });
  atenderEstadosCuenta();
}
