/**
 * FARM INVOICES de Kuehne+Nagel (Javier, 25-11-2026)
 *
 * Cuando ha llegado la guía de un vuelo de K+N y a la Master (Consolidation Report) le falta la factura de alguna finca
 * (Invos suele mandarla tarde), se baja el PDF "FARM INVOICES" del correo de K+N, que trae todas las facturas de las fincas
 * juntas, y por cada finca que falta se deja una COPIA en "Facturas fincas":
 *     AAAA-MM-DD_<FINCA>_FARM INVOICES KN_<guía>.pdf      (en su descripción: la línea de la Master de esa finca)
 * La siguiente pasada de revisarVuelos la lee como factura de ESA finca (leerDocumentoVuelo_ lo sabe por el nombre y solo
 * lee la suya) y, si con ella ya están todas, hace el inventario definitivo.
 * Si después llega la factura de la finca por su cuenta (mismo proveedor y número), manda la de la finca y la copia deja de
 * contar; si trae otro importe, te avisa por correo.
 * El PDF completo queda en la raíz de la carpeta del vuelo ("FARM INVOICES KN_<guía>.pdf"), que revisarVuelos no lee.
 */
const RX_FARM_KN = /FARM INVOICES KN/i;
const FARM_KN_MAX_INTENTOS = 12;          // como mucho 12 pasadas (unas 12 h) buscando el enlace en el correo de K+N

function esVueloKN_(carpeta, mios) {
  const rx = /kuehne|k\s*\+\s*n/i;
  return rx.test(carpeta.getName()) || mios.some(d => rx.test(String((d.data || {}).transitario || '')));
}

/** Enlace "FARM INVOICES" (etiqueta INV) de un correo de K+N, formato nuevo o antiguo. '' si no lo trae. */
function enlaceInvKN_(html) {
  const limpiar = u => u.replace(/&amp;/g, '&');
  const rxA = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = rxA.exec(html)) !== null) {
    const texto = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (/FARM\s*INVOICES?/i.test(texto)) return limpiar(m[1]);
  }
  m = /(?:<strong[^>]*>|>)\s*INV\s*<[\s\S]{0,600}?href="(https?:\/\/[^"]+)"/.exec(html);
  return m ? limpiar(m[1]) : '';
}

/** Baja (una sola vez) el FARM INVOICES de la guía a la raíz de la carpeta del vuelo. Devuelve el archivo o null. */
function farmInvoicesKN_(awb, carpeta) {
  const nombre = 'FARM INVOICES KN_' + awb + '.pdf';
  const ya = carpeta.getFilesByName(nombre);
  if (ya.hasNext()) return ya.next();
  const props = PropertiesService.getScriptProperties(), k = 'KN_FARM_' + awb;
  const intentos = Number(props.getProperty(k) || 0);
  if (intentos >= FARM_KN_MAX_INTENTOS) return null;
  props.setProperty(k, String(intentos + 1));
  const num = String(awb).replace(/\D/g, '').slice(3);                       // 68014166
  const hilos = GmailApp.search('(' + num + ' OR "' + num.slice(0, 4) + ' ' + num.slice(4) + '") (kuehne OR knfresh OR knbog) in:anywhere newer_than:30d', 0, 20);
  for (const th of hilos) {
    const msgs = th.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {                              // el correo más reciente primero
      let html = '';
      try { html = msgs[i].getBody() || ''; } catch (e) { continue; }
      if (html.indexOf(num) < 0 && html.indexOf(num.slice(0, 4) + ' ' + num.slice(4)) < 0) continue;
      const url = enlaceInvKN_(html);
      if (!url) continue;
      try {
        const r = bajarPdfKN_(url);
        if (!r.ok) { Logger.log('FARM INVOICES ' + awb + ': HTTP ' + r.codigo); continue; }
        return carpeta.createFile(Utilities.newBlob(r.bytes, 'application/pdf', nombre));
      } catch (e) { Logger.log('FARM INVOICES ' + awb + ': ' + e); }
    }
  }
  Logger.log('FARM INVOICES ' + awb + ': no encuentro el enlace en los correos de K+N (intento ' + (intentos + 1) + ')');
  return null;
}

/**
 * Por cada finca que falta: una copia del FARM INVOICES en "Facturas fincas" con su nombre (una sola vez por finca y guía).
 * Devuelve cuántas copias nuevas ha dejado (0 = nada nuevo: ya se intentó, o no hay FARM INVOICES).
 */
function sacarDeFarmInvoicesKN_(awb, carpeta, faltan) {
  const props = PropertiesService.getScriptProperties();
  const clave = f => 'KN_FARM_' + awb + '_' + claveNombre_(f.finca);
  const vistas = {};
  const pendientes = faltan.filter(f => {
    const c = claveNombre_(f.finca);
    if (!c || vistas[c] || props.getProperty(clave(f))) return false;
    return (vistas[c] = true);
  });
  if (!pendientes.length) return 0;
  const farm = farmInvoicesKN_(awb, carpeta);
  if (!farm) return 0;
  const it = carpeta.getFoldersByName('Facturas fincas');
  const destino = it.hasNext() ? it.next() : carpeta.createFolder('Facturas fincas');
  const hoy = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd');
  pendientes.forEach(f => {
    // la misma finca puede venir en varias líneas de la Master: en la pista van todas juntas
    const suyas = faltan.filter(x => claveNombre_(x.finca) === claveNombre_(f.finca));
    const sum = campo => Math.round(suyas.reduce((a, x) => a + (Number(x[campo]) || 0), 0) * 100) / 100;
    const copia = farm.makeCopy(hoy + '_' + claveNombre_(f.finca) + '_FARM INVOICES KN_' + awb + '.pdf', destino);
    copia.setDescription('FINCA: ' + f.finca + (f.hawb ? ' · HAWB ' + f.hawb : '') + (sum('piezas') ? ' · ' + sum('piezas') + ' cajas' : '') +
      (sum('tallos') ? ' · ' + sum('tallos') + ' tallos' : '') + (sum('usd') ? ' · ' + sum('usd') + ' USD en la Master' : ''));
    props.setProperty(clave(f), hoy);
  });
  return pendientes.length;
}

/** Instrucción extra para la IA cuando el PDF es una copia del FARM INVOICES (varias facturas juntas). */
function pistaFarmKN_(file) {
  if (!file || !RX_FARM_KN.test(file.getName())) return '';
  const desc = String(file.getDescription() || '').replace(/^FINCA:\s*/, '');
  return '\n\nOJO: este PDF reúne VARIAS facturas de fincas distintas (las "FARM INVOICES" de Kuehne+Nagel). Lee SOLO la factura ' +
    'de esta finca: ' + (desc || file.getName()) + ', e ignora por completo las de las demás fincas. Si la finca tiene varias facturas ' +
    'en el PDF, une sus líneas en una sola respuesta con el número de la primera. Si en el PDF no hay ninguna factura de esa finca, ' +
    'responde {"finca":"","numero":"","total_usd":0,"lineas":[]}.';
}

/**
 * Si la factura de una finca ha llegado ya por su cuenta (mismo proveedor y nº), la copia del FARM INVOICES se quita de la
 * lista del vuelo (manda la de la finca). Si los importes no coinciden, UN aviso por correo.
 */
function quitarCopiasFarmKN_(awb, mios) {
  const num = n => String(n || '').replace(/\D/g, '').replace(/^0+/, '');
  const esCopia = d => d.tipo === 'FINCA' && RX_FARM_KN.test(d.nombre || '');
  const propias = mios.filter(d => d.tipo === 'FINCA' && !esCopia(d));
  const quitar = [];
  mios.filter(esCopia).forEach(d => {
    const p = propias.find(x => num(x.data.numero) && num(x.data.numero) === num(d.data.numero) &&
      nombreProveedor_(x.data.finca) === nombreProveedor_(d.data.finca));
    if (!p) return;
    quitar.push(d);
    const a = Number(d.data.total_usd) || 0, b = Number(p.data.total_usd) || 0;
    const props = PropertiesService.getScriptProperties(), k = 'KN_FARM_DIF_' + d.id;
    if (Math.abs(a - b) > 1 && !props.getProperty(k)) {
      props.setProperty(k, '1');
      try {
        MailApp.sendEmail(CONFIG.ALERT_EMAIL, '[Buzón Buscaflor] Factura de ' + corto_(d.data.finca) + ' distinta a la del FARM INVOICES: AWB ' + awb,
          'La factura ' + (p.data.numero || '') + ' de ' + d.data.finca + ' ha llegado por su cuenta con ' + b.toFixed(2) + ' USD, pero en el ' +
          'FARM INVOICES de K+N ponía ' + a.toFixed(2) + ' USD. El inventario se rehace con la de la finca. ' +
          'Si la guía ya estaba subida a AmbarX, revisa esa factura allí.');
      } catch (e) {}
    }
  });
  quitar.forEach(d => mios.splice(mios.indexOf(d), 1));
  return quitar.length;
}

/** Nota para el correo del inventario: qué facturas salen del FARM INVOICES. */
function notaFarmKN_(mios) {
  const c = mios.filter(d => d.tipo === 'FINCA' && RX_FARM_KN.test(d.nombre || ''));
  if (!c.length) return '';
  return 'Sacada del FARM INVOICES de K+N porque la finca aún no la había mandado: ' +
    c.map(d => corto_(d.data.finca) + ' ' + (d.data.numero || '') + ' (' + (Number(d.data.total_usd) || 0).toFixed(2) + ' USD)').join('; ') +
    '. Si después llega la factura de la finca, manda esa y el inventario se rehace solo.';
}
