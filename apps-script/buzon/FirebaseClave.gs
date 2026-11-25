/**
 * Buzón Buscaflor · Clave de Firebase (25-11-2026)
 * Firebase (stock-buscaflor) solo deja leer y escribir con sesión o con la clave del servidor.
 * La clave está en Propiedades del script → FIREBASE_SECRET (nunca en el código).
 * Sin la propiedad, las llamadas van sin clave (como antes).
 */
function fbAuth_() {
  var k = PropertiesService.getScriptProperties().getProperty('FIREBASE_SECRET');
  return k ? '?auth=' + encodeURIComponent(k) : '';
}

/** Para comprobar a mano que la clave funciona: lee buscaflor/stockAmbarx/leido. */
function probarClaveFirebase() {
  var r = UrlFetchApp.fetch('https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app/buscaflor/stockAmbarx/leido.json' + fbAuth_(), { muteHttpExceptions: true });
  Logger.log((PropertiesService.getScriptProperties().getProperty('FIREBASE_SECRET') ? 'Con clave' : 'SIN clave') + ' → ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 80));
}
