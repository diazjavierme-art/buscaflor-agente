/**
 * Buzón Buscaflor · Clave de Firebase (25-11-2026)
 * Firebase (stock-buscaflor) solo deja leer y escribir con sesión o con la clave del servidor.
 * La clave se guarda en Propiedades del script → FIREBASE_SECRET (nunca en el código).
 * Si la propiedad no existe, se lee una vez del documento «Clave Firebase para tareas (no compartir)»
 * de Javier (compartido en lectura con esta cuenta) y se guarda en la propiedad.
 */
var FB_CLAVE_DOC = '16RPRxqiagz1UKLq-vDRc7zZg_49H_o4KIZcpKWrKJpQ';

function fbClave_() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty('FIREBASE_SECRET');
  if (k) return k;
  try {
    var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + FB_CLAVE_DOC + '/export?mimeType=text%2Fplain',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { Logger.log('Clave Firebase: no se puede leer el documento (' + r.getResponseCode() + ')'); return ''; }
    k = r.getContentText().replace(/^﻿/, '').trim();
    if (!/^[A-Za-z0-9_\-]{20,}$/.test(k)) { Logger.log('Clave Firebase: el documento no tiene una clave válida'); return ''; }
    props.setProperty('FIREBASE_SECRET', k);
    return k;
  } catch (e) { Logger.log('Clave Firebase: ' + e); return ''; }
}

function fbAuth_() {
  var k = fbClave_();
  return k ? '?auth=' + encodeURIComponent(k) : '';
}

/** Ejecutar a mano: guarda la clave (desde el documento) y comprueba que Firebase responde. */
function probarClaveFirebase() {
  var k = fbClave_();
  var r = UrlFetchApp.fetch('https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app/buscaflor/stockAmbarx/leido.json' + (k ? '?auth=' + encodeURIComponent(k) : ''), { muteHttpExceptions: true });
  Logger.log((k ? 'Con clave' : 'SIN clave') + ' → ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 80));
}
