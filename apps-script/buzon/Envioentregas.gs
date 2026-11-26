/**
 * Buzón Buscaflor · Envío directo de entregas firmadas (23-11-2026)
 *
 * Si una entrega está firmada en la app de reparto pero AmbarX no ha podido firmarla
 * (3 intentos fallidos, o 30 minutos sin pasar porque el servidor está parado),
 * manda al cliente desde esta cuenta (facturasbuscaflor@gmail.com) el justificante
 * de entrega firmado en PDF: documento, líneas, total, hora, quién recibe y firma.
 * Responder a: expansion@rosasdebuscaflor.com, con copia oculta a expansion@.
 *
 * Deja la marca entregas/<nº>/emailDirecto en Firebase. Con esa marca, el script del
 * servidor ya no firma esa entrega por la pantalla de AmbarX móvil (que mandaría un
 * segundo email): solo guarda el PDF firmado como adjunto del documento.
 *
 * Además atiende el botón «Reenviar email» de la oficina (entregas/<nº>/reenviar):
 * manda el mismo justificante a los emails que se pongan allí.
 *
 * Instalar: pegar este archivo en el proyecto del buzón y ejecutar una vez
 * instalarEnvioEntregas() (crea el activador de cada 5 minutos).
 */
var EE_DB = 'https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app/buscaflor/reparto/';
var EE_RESPONDER = 'expansion@rosasdebuscaflor.com';
var EE_MINUTOS = 30;      // sin pasar a AmbarX en este tiempo → envío directo
var EE_DIAS = 3;          // repasa hoy y los 2 días anteriores
var EE_ZONA = 'Europe/Madrid';

function instalarEnvioEntregas() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarEntregasSinAmbarx') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('enviarEntregasSinAmbarx').timeBased().everyMinutes(5).create();
  enviarEntregasSinAmbarx();
}

function ee_fb(metodo, ruta, datos) {
  var o = { method: metodo, muteHttpExceptions: true, contentType: 'application/json' };
  if (datos !== undefined) o.payload = JSON.stringify(datos);
  var r = UrlFetchApp.fetch(EE_DB + ruta + '.json' + fbAuth_(), o);
  if (r.getResponseCode() >= 300) throw new Error('Firebase ' + r.getResponseCode() + ': ' + r.getContentText());
  return JSON.parse(r.getContentText() || 'null');
}
function ee_ahora() { return Utilities.formatDate(new Date(), EE_ZONA, "yyyy-MM-dd'T'HH:mm:ss"); }
function ee_ms(hora) { try { return Utilities.parseDate(String(hora).slice(0, 19), EE_ZONA, "yyyy-MM-dd'T'HH:mm:ss").getTime(); } catch (e) { return 0; } }
function ee_esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function ee_eur(n) { return (Math.round((+n || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }
function ee_num(n) { var x = +n || 0; return (Math.round(x * 100) / 100).toString().replace('.', ','); }

function enviarEntregasSinAmbarx() {
  try { ee_copiasAmbarx(); } catch (e) { Logger.log('Copias AmbarX: ' + e); }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    for (var atras = 0; atras < EE_DIAS; atras++) {
      var f = Utilities.formatDate(new Date(Date.now() - atras * 864e5), EE_ZONA, 'yyyy-MM-dd');
      var ent = ee_fb('GET', f + '/entregas') || {}, docs = null;
      Object.keys(ent).forEach(function (k) {
        var e = ent[k] || {}, a = e.ambarx || {};
        // Reenvío pedido desde la oficina
        if (e.reenviar && !e.reenviar.hecho && !e.reenviar.error && e.firma) {
          docs = docs || (ee_fb('GET', f + '/docs') || {});
          try {
            var pr = (e.reenviar.para || []).filter(function (x) { return x && /@/.test(x); });
            if (!pr.length) throw new Error('sin destinatarios');
            ee_enviar(docs[k] || {}, e, k, pr);
            ee_fb('PATCH', f + '/entregas/' + k + '/reenviar', { hecho: ee_ahora() });
          } catch (err) { ee_fb('PATCH', f + '/entregas/' + k + '/reenviar', { error: String(err && err.message || err) }); }
        }
        if (e.estado !== 'entregado' || !e.firma || e.emailDirecto) return;
        if (a.firma === 'firmado' || a.firma === 'adjunto') return;           // AmbarX ya lo hizo (y mandó su email)
        var falla = a.firma === 'error';
        var tarde = (Date.now() - ee_ms(e.hora)) / 60000 >= EE_MINUTOS;
        if (!falla && !tarde) return;
        docs = docs || (ee_fb('GET', f + '/docs') || {});
        var d = docs[k] || {};
        var para = (d.emails || []).filter(function (x) { return x && /@/.test(x); });
        if (!para.length) { ee_fb('PUT', f + '/entregas/' + k + '/emailDirecto', { estado: 'sinEmail', hora: ee_ahora() }); return; }
        try {
          ee_enviar(d, e, k, para);
          ee_fb('PUT', f + '/entregas/' + k + '/emailDirecto', { estado: 'enviado', hora: ee_ahora(), para: para, motivo: falla ? 'AmbarX falló' : 'Sin pasar a AmbarX en ' + EE_MINUTOS + ' min' });
        } catch (err) {
          ee_fb('PUT', f + '/entregas/' + k + '/emailDirectoError', { hora: ee_ahora(), error: String(err && err.message || err) });
        }
      });
    }
  } finally { lock.releaseLock(); }
}

function ee_enviar(d, e, k, para) {
  var pdf = ee_pdf(d, e, k);
  var tipo = (e.tipo || d.tipo) === 'factura' ? 'Factura' : 'Albarán';
  var num = e.num || d.num || k;
  var fechaE = String(e.hora || '').slice(0, 10).split('-').reverse().join('/');
  GmailApp.sendEmail(para.join(','), 'Rosas de Buscaflor · ' + tipo + ' ' + num + ' firmado (entrega ' + fechaE + ')',
    'Buenos días:\n\nLe adjuntamos el justificante de entrega firmado del ' + tipo.toLowerCase() + ' ' + num + ', entregado el ' + fechaE +
    ' a las ' + String(e.hora || '').slice(11, 16) + '.\n\nPara cualquier consulta, responda a este correo.\n\nUn saludo,\nRosas de Buscaflor La Mejor S.L.',
    { attachments: [pdf], name: 'Rosas de Buscaflor', replyTo: EE_RESPONDER, bcc: EE_RESPONDER });
}

// Justificante de entrega firmado (HTML → PDF)
function ee_pdf(d, e, k) {
  var tipo = (e.tipo || d.tipo) === 'factura' ? 'Factura' : 'Albarán', num = e.num || d.num || k;
  var filas = (d.lineas || []).map(function (l) {
    return '<tr><td>' + ee_esc(l.d) + '</td><td class="r">' + ee_num(l.u) + '</td><td class="r">' + ee_num(l.p) + '</td><td class="r">' + (l.dto ? ee_num(l.dto) : '') +
      '</td><td class="r">' + ee_num(l.iva) + '</td><td class="r">' + ee_num(l.t) + '</td></tr>';
  }).join('');
  var c = e.cobro || {}, f = c.forma || 'pendiente';
  var cobro = f === 'efectivo' ? 'Efectivo ' + ee_eur(c.importe) : f === 'tarjeta' ? 'Tarjeta ' + ee_eur(c.importe) : f === 'transferencia' ? 'Transferencia ' + ee_eur(c.importe) : 'Sin cobrar en la entrega';
  var h = String(e.hora || '');
  var html = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,sans-serif;font-size:10pt;color:#000;margin:24px}h1{font-size:14pt;margin:0}' +
    'table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border-bottom:1px solid #999;padding:4px 3px;text-align:left}th{border-bottom:1.5px solid #000}' +
    '.r{text-align:right}.cab{display:table;width:100%}.cab div{display:table-cell;vertical-align:top}.peq{font-size:9pt}</style></head><body>' +
    '<div class="cab"><div><h1>Rosas de Buscaflor La Mejor S.L.</h1><div class="peq">CIF B91821579</div></div>' +
    '<div class="r"><b style="font-size:12pt">' + tipo + ' ' + ee_esc(num) + '</b><br><span class="peq">Fecha: ' + ee_esc(String(d.fecha || '').split('-').reverse().join('/')) + '</span></div></div>' +
    '<p>' + [d.nombreFiscal || d.cliente, d.nif, d.direccion, d.poblacion].filter(Boolean).map(ee_esc).join('<br>') + '</p>' +
    '<table><tr><th>Artículo</th><th class="r">Uds</th><th class="r">Precio</th><th class="r">%Dto</th><th class="r">IVA %</th><th class="r">Importe</th></tr>' + filas + '</table>' +
    '<p class="r"><b>Total (IVA incluido): ' + ee_eur(d.total || e.total) + '</b></p>' +
    '<p>Entregado el ' + h.slice(0, 10).split('-').reverse().join('/') + ' a las ' + h.slice(11, 16) + (e.por ? ' por ' + ee_esc(e.por) : '') + (e.recibe ? ' · Recibe: ' + ee_esc(e.recibe) : '') +
    '<br>Cobro: ' + cobro + (e.nota ? '<br>Nota: ' + ee_esc(e.nota) : '') + '</p>' +
    '<p>Firma del cliente:<br><img src="' + e.firma + '" style="width:260px;height:auto;border-bottom:1px solid #000"></p>' +
    '<p class="peq">Justificante de entrega firmado. El ' + tipo.toLowerCase() + ' original está registrado en nuestro sistema de gestión.</p>' +
    '</body></html>';
  return Utilities.newBlob(html, 'text/html', 'x.html').getAs('application/pdf')
    .setName((tipo === 'Factura' ? 'FV-' : 'AV-') + String(num).replace('-', '') + '_firmado.pdf');
}

/**
 * Copias ocultas (CCO) que el robot pone al mandar un albarán o factura desde AmbarX (26-11-2026).
 * Asunto de AmbarX: «ROSAS DE BUSCAFLOR LAMEJOR, S.L.. Albarán A-12240». Se apunta en
 * buscaflor/reparto/copias/<nº> {hora, asunto, para}: con eso el robot sabe que el email salió aunque AmbarX
 * no lo confirmara, y no lo repite. El correo se marca como leído y se archiva.
 */
function ee_copiasAmbarx() {
  var hilos = GmailApp.search('newer_than:2d from:expansion@rosasdebuscaflor.com subject:"ROSAS DE BUSCAFLOR" is:unread', 0, 30);
  if (!hilos.length) return;
  var et = GmailApp.getUserLabelByName('Buzón/Copias-AmbarX') || GmailApp.createLabel('Buzón/Copias-AmbarX');
  hilos.forEach(function (th) {
    var ok = true;
    th.getMessages().forEach(function (m) {
      var asunto = m.getSubject() || '', mm = /(Albar[aá]n|Factura)\s+([A-Z]{1,3}-\d+)/i.exec(asunto);
      if (!mm) { ok = false; return; }
      try {
        ee_fb('PATCH', 'copias/' + mm[2].toUpperCase(), { hora: Utilities.formatDate(m.getDate(), EE_ZONA, "yyyy-MM-dd'T'HH:mm:ss"), asunto: asunto, para: m.getTo() || '' });
      } catch (e) { ok = false; Logger.log('Copia ' + mm[2] + ': ' + e); }
    });
    if (ok) { th.addLabel(et); th.markRead(); th.moveToArchive(); }
  });
}
