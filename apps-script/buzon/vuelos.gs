/**
 * VUELOS — control de facturas por AWB + INVENTARIO STOCK automático (Excel .xlsx)
 *
 * Cada hora (disparador creado con setupVuelos):
 *  1. Recorre las carpetas "AWB …" de las últimas 3 semanas en 01 Importación, solo las creadas
 *     después de ejecutar setupVuelos (los vuelos anteriores no se tocan).
 *  2. Lee con Claude los PDF nuevos (una sola vez; quedan en la hoja "Docs IA"):
 *       Documentos vuelo / Facturas transporte → MASTER (Commercial Master Invoice o Consolidation Report),
 *                                                FLETE (factura/liquidación del transitario), GUIA (AWB), PESOS (kg por finca)
 *       Facturas fincas → finca, nº, HAWB, piezas, tallos, importe y líneas (variedad, medida, paquetes, $/tallo)
 *  3. Cruza la Master y la Final Alert con las facturas de fincas, POR HAWB (no por nombre). Si al llegar la GUÍA falta alguna
 *     factura (o la del flete del transitario) → UN email con lo que falta; luego solo avisa cuando el inventario está listo.
 *  Además, cada factura de finca o de flete leída crea un ACCESO DIRECTO en
 *     01 Importación / Por proveedor / <Proveedor> / Pendientes de pago (al pagar, muévelo a "Pagadas").
 *  4. Con todas las facturas → crea/actualiza "INVENTARIO AWB ….xlsx" (Excel, formato STOCK) en la carpeta del AWB:
 *       Sin inventarios provisionales (Javier, 19-11-2026): solo con TODAS las facturas de fincas y la del flete
 *       (K+N se paga por la guía: con la guía basta).
 *     Se regenera solo si llega o cambia algún documento. Te avisa por email.
 *
 * Reglas (desde S41, campaña Santos 2026): EUR/USD 1,1200 · Vallinoto = 135 € + 1,90 €/caja; palet Brivio = palets × 100 € (Ecuador HB ÷ 22, Colombia piezas ÷ 32, redondeo arriba),
 * reparto plano por tallo · Flete: por kg de cada finca (Ecuador: kg de la Master Invoice; Colombia: recibo de bodega).
 * Stock: agrupado por variedad + medida, proveedores juntos, media ponderada por tallos; importes €/tallo,
 * coste total por paquete (por tallo en clavel). Avisa de precios ±15 % respecto al último vuelo de esa finca.
 */

const VUELOS = {
  FX: 1.12,                  // EUR/USD (cámbialo aquí; los textos del inventario se actualizan solos)
  PALET_EUR: 100,            // € por palet Madrid → Sevilla (Brivio: 76,23 de tarifa + combustible, seguro y recargos; media real oct-2026 ≈ 101,5)
  GASTOS_VALLINOTO: 135,      // € fijos por vuelo (comisión despacho 60 + entrega 49 + fito…)
  VALLINOTO_CAJA: 1.90,       // € por caja (THC y paletización por kg + palets de madera ~0,30/caja). Ajustado a las facturas de 2026 (media real 236 €/vuelo + palets)
  CAJAS_PALET: { ECU: 22, COL: 32 },
  SEMANAS: 3,
  MAX_LECTURAS_POR_PASADA: 6,
  MAX_BYTES_PDF: 25 * 1024 * 1024,
  AVISO_PRECIO: 0.15,
  // Precios de venta del inventario (Javier, 25-11-2026): precio para ganar ese margen SOBRE LA VENTA = coste ÷ (1 − margen)
  MARGENES: [0.17, 0.20, 0.25],
  // Modelo para leer las LÍNEAS de las facturas de fincas (más preciso que el de clasificar correos).
  // Si no estuviera disponible, se usa automáticamente CONFIG.CLAUDE_MODEL.
  MODELO_FACTURAS: 'claude-sonnet-5-5',
  POR_TALLO: ['CLAVEL', 'HORTENSIAS'],         // tipos que se cuentan y se cuestan por tallo, no por paquete
  // Unidad fija del stock, la ponga como la ponga la factura (Benchmark factura la alstroemeria por tallos sueltos)
  UNIDAD: { ALSTROEMERIA: 10, ROSAS: 25 },   // paniculata: por paquete (ramo de la factura), como la 464 PANICULATA 750 GR
  // ── Campaña Santos 2026 (instrucciones de Javier, 06-10-2026) ──
  // Guía de Kuehne+Nagel (Iberia BOG-MAD): lo que debe traer. Si la guía no cuadra, sale un aviso en el inventario.
  KN: {
    TARIFAS: [1.37, 1.41],                     // USD/kg: vuelos de más de ~1.000 kg / vuelos menores
    FEC: 0.24,                                 // combustible, USD/kg
    FIJOS: { MCC: 25, MAA: 30, CHC: 12 },      // USD por guía
    SANTOS: [                                  // recargo Iberia por fecha de vuelo, USD/kg sobre peso tasable
      { desde: '2026-10-04', hasta: '2026-10-11', usd: 0.40 },
      { desde: '2026-10-12', hasta: '2026-10-27', usd: 0.95 }
    ]
  },
  TARIFA_ECUADOR: 3.10,                        // USD/kg de referencia (Saftec); recargo Santos de Ecuador: sin dato todavía
  // Clavel de Benchmark: precios FOB cerrados para Santos (USD/tallo). Una línea a uno de estos precios es de SANTOS;
  // a cualquier otro precio es la ORDEN FIJA habitual (entra en stock igual, pero no resta del pedido de Santos).
  BENCHMARK_SANTOS: { FANCY: 0.20, SELECT: 0.21, DESBOTONADO: 0.30 }
};
const RX_SUB = {
  FINCAS: /^facturas?\s+fincas?$/i,
  TRANSPORTE: /^facturas?\s+(de\s+)?transporte$/i,
  DOCS: /^documentos?\s+(del\s+)?vuelo$/i
};
const PALABRAS_GENERICAS = /^(THE|COMPANY|INC|CORP|LLC|FLORICOLA|FLORES|FLOR|COMERCIALIZADORA|GRUPO|EL|LA|LAS|LOS|DE|DEL|CIA|SA|SAS|S|A|LTDA|CI|C|I|INVERSIONES|QUITO|TRADE|FARMS?|GROWERS?|ROSES?|ROSAS)$/;

function setupVuelos() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'revisarVuelos').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('revisarVuelos').timeBased().everyHours(1).create();
  hojaVuelos_(); hojaDocs_(); hojaPrecios_();
  // Solo se revisan los vuelos cuya carpeta AWB se cree a partir de este momento
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('VUELOS_DESDE')) props.setProperty('VUELOS_DESDE', new Date().toISOString());
  Logger.log('Listo: revisarVuelos se ejecutará cada hora. Vuelos revisados desde: ' + props.getProperty('VUELOS_DESDE'));
}

function revisarVuelos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const t0 = Date.now();
    const docs = cargarDocs_();
    let lecturas = 0;
    const vuelosRecientes = carpetasAwbRecientes_();
    vuelosRecientes.forEach(({ awb, carpeta, semana }) => {
      if (Date.now() - t0 > 4 * 60 * 1000) return;
      const subs = carpeta.getFolders();
      while (subs.hasNext()) {
        const sub = subs.next(), n = sub.getName();
        const tipo = RX_SUB.FINCAS.test(n) ? 'FINCA' : (RX_SUB.DOCS.test(n) || RX_SUB.TRANSPORTE.test(n)) ? 'DOC' : '';
        if (!tipo) continue;
        const lista = [], conPdf = {}, it = sub.getFiles();
        const sinExt = n => String(n).replace(/\.[^.]+$/, '').toLowerCase();
        while (it.hasNext()) { const x = it.next(); lista.push(x); if (x.getMimeType() === 'application/pdf') conPdf[sinExt(x.getName())] = true; }
        for (const f of lista) {
          // PDF siempre; en "Facturas fincas" también Excel (hay fincas, como Invos, que mandan la factura en .xls/.xlsx),
          // salvo que la misma factura ya esté en PDF (mismo nombre): entonces el Excel sobra y no se lee.
          const esExcel = tipo === 'FINCA' && esExcel_(f) && !conPdf[sinExt(f.getName())];
          // Final Alert del transitario (Logike: "FINAL ALERT 3013.xlsx"): lista de lo que VUELA de verdad, con el HAWB de cada finca.
          // Se lee sin IA, directamente de las celdas, y sirve para saber qué facturas van en este vuelo y cuáles no.
          // DIM de Logike: peso real de bodega de cada finca → documento PESOS (sin IA)
          if (tipo === 'DOC' && !docs[f.getId()] && esExcel_(f) && RX_DIM.test(f.getName())) {
            const texto = excelATexto_(f);
            if (!texto) continue;
            const dim = leerDim_(texto);
            docs[f.getId()] = { awb: awb, tipo: dim.fincas.length ? 'PESOS' : 'DOC', data: dim, nombre: f.getName() };
            guardarDoc_(f, awb, docs[f.getId()]);
            continue;
          }
          if (tipo === 'DOC' && !docs[f.getId()] && esExcel_(f) && RX_FINAL_ALERT.test(f.getName())) {
            const texto = excelATexto_(f);
            if (!texto) continue;
            docs[f.getId()] = { awb: awb, tipo: 'ALERTA', data: leerFinalAlert_(texto), nombre: f.getName() };
            guardarDoc_(f, awb, docs[f.getId()]);
            continue;
          }
          // Una "lectura ligera" (solo proveedor, nº e importe: la hacen el control de estados de cuenta o procesarVuelosAnteriores
          // cuando la factura llega antes que el vuelo) no sirve para el inventario: se vuelve a leer completa.
          const dPrev = docs[f.getId()];
          const ligera = dPrev && dPrev.data && ['FINCA', 'GUIA', 'FLETE'].indexOf(dPrev.tipo) >= 0 && !dPrev.data.tipo_doc && !dPrev.data.lineas;
          if ((dPrev && !ligera) || (f.getMimeType() !== 'application/pdf' && !esExcel) || f.getSize() > VUELOS.MAX_BYTES_PDF) continue;
          if (lecturas >= VUELOS.MAX_LECTURAS_POR_PASADA || Date.now() - t0 > 4 * 60 * 1000) break;
          let textoExcel = '';
          if (esExcel) {
            textoExcel = excelATexto_(f);
            if (!textoExcel) continue;               // no se pudo convertir (mira el registro): se reintenta en la siguiente pasada
          }
          lecturas++;
          const kgG = Object.keys(docs).map(id => docs[id]).filter(d => d.awb === awb && d.tipo === 'GUIA').map(d => Number(d.data.kg) || 0)[0] || 0;
          const r = leerDocumentoVuelo_(f, tipo, kgG, textoExcel);
          if (r && esPreAlert_(f.getName())) r._tipo = 'PREALERT';   // aviso previo del transitario: no es la Master
          docs[f.getId()] = { awb: awb, tipo: r ? r._tipo : 'ERROR', data: r || {}, nombre: f.getName() };
          guardarDoc_(f, awb, docs[f.getId()]);
          crearAccesoPago_(f, docs[f.getId()]);
        }
      }
      try { reubicarPorHawb_(docs, vuelosRecientes); } catch (e) { Logger.log('Reubicar por HAWB: ' + e); }
      try { evaluarVuelo_(awb, carpeta, semana, docs); }
      catch (e) {
        Logger.log('Vuelo ' + awb + ': ' + e);
        try { const hv = hojaVuelos_(); actualizarVuelo_(hv, filaVuelo_(hv, awb), awb, 'ERROR: ' + String(e.message || e).slice(0, 120), '', ''); } catch (e2) {}
      }
    });
  } finally { lock.releaseLock(); }
}

// ─────────────────────────────── lectura con IA ───────────────────────────────

// Master sin el peso de cada finca (la IA a veces lo salta o pone el flete como kg): segunda pregunta, solo los pesos.
function completarKgMaster_(r, blob) {
  const fs = r.fincas || [];
  if (!fs.length || fs.some(f => Number(f.kg) > 0)) return;
  if (Number(r.kg) && Number(r.flete_usd) && Math.abs(Number(r.kg) - Number(r.flete_usd)) < 0.01) r.kg = 0;   // kg = flete: dato malo
  const p = iaJson_(
    'Commercial Master Invoice de un envío de flores. Para CADA finca de la tabla dame su PESO en kg (columna WEIGHT / Gross Weight / Peso / KG de esa fila; ' +
    'en la de SAFTEC es el número que va justo antes del código HTS 0603…, p. ej. 50.00, 135.00). Responde SOLO JSON: ' +
    '{"total_kg":n,"fincas":[{"finca":"nombre tal cual","hawb":"","kg":n}]}. La suma debe dar el peso bruto total del envío. ' +
    'Fincas: ' + fs.map(f => f.finca + (f.hawb ? ' (' + f.hawb + ')' : '')).join('; '), blob, 'application/pdf', 800);
  if (!p || !p.fincas) return;
  const norm = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  fs.forEach(f => {
    const m = p.fincas.find(x => (x.hawb && f.hawb && norm(x.hawb) === norm(f.hawb))) ||
              p.fincas.find(x => norm(x.finca).slice(0, 8) === norm(f.finca).slice(0, 8));
    if (m && Number(m.kg) > 0) f.kg = Number(m.kg);
  });
  if (Number(p.total_kg) > 0 && !(Number(r.kg) > 0)) r.kg = Number(p.total_kg);
}

function leerDocumentoVuelo_(file, tipo, kgGuia, textoExcel) {
  const blob = textoExcel ? null : file.getBlob();
  if (tipo === 'DOC') {
    const r = iaJson_(
      'Documento de un envío aéreo de flores (Ecuador/Colombia → España) para ROSAS DE BUSCAFLOR. Clasifícalo y extrae datos. ' +
      (kgGuia >= 50 ? 'DATO: el peso REAL total de este vuelo según la guía es ' + kgGuia + ' kg; si es un recibo de bodega, la suma de los kg ' +
        'de los embarcadores debe dar aproximadamente eso (si te sale bastante menos, estás leyendo el PESO VOLUMEN; usa la columna de peso real). ' : '') +
      'Responde SOLO JSON:\n{"tipo_doc":"MASTER|FLETE|GUIA|PESOS|OTRO","transitario":"","numero":"nº de factura si es FLETE","fecha":"AAAA-MM-DD","awb":"075-XXXXXXXX","pais":"EC|CO",' +
      '"total_piezas":n,"total_full":n,"kg":n,"flete_usd":n,"tarifa_kg":n,"cargos":[{"codigo":"","usd":n}],"fincas":[{"finca":"","hawb":"","factura":"","piezas":n,"full":n,"kg":n,"tallos":n,"usd":n}]}\n' +
      'MASTER = Commercial Master Invoice, factura comercial consolidada o Consolidation Report con la lista de fincas del envío ' +
      '(puede venir dentro de un PDF junto a certificados); flete_usd = TOTAL FREIGHT COST si aparece, si no 0. ' +
      'En la MASTER: una entrada por finca, copiando su nombre letra a letra; tallos = columna STEMS/TALLOS; piezas = CAJAS (Pcs/Boxes) ' +
      'de esa finca; kg = PESO de esa finca en kg (columna Gross Weight / Peso bruto / KG; si solo hay peso neto, ese), 0 si no aparece; ' +
      'la suma de kg de las fincas debe dar el peso total de la Master (en la Master de SAFTEC cada fila de finca va así: FULL, PCS, WEIGHT en kg ' +
      '(p. ej. 50.00 o 135.00), código HTS 0603…, FLOR, STEMS, precio, total, HAWB…: el kg es el número que va justo antes del código 0603); ' +
      'el "kg" de arriba es el PESO BRUTO total (p. ej. "536 K"), NUNCA el importe del flete; factura = nº de factura de la finca SOLO si aparece (nunca la partida arancelaria 0603…); total_piezas = total de CAJAS; ' +
      'no incluyas la fila de totales ni al comprador ROSAS DE BUSCAFLOR. ' +
      'FLETE = factura o liquidación de cobro del transitario por el flete aéreo (flete_usd = total a pagar). ' +
      'GUIA = guía aérea AWB (flete_usd = TOTAL PREPAID: flete + todos los cargos, no solo el flete; kg = PESO TASABLE TOTAL de la guía ("Chargeable Weight", el que se multiplica por la tarifa; p. ej. 1533), NUNCA "AV.CW" ni "AV.GW", ' +
      'que son el peso medio por caja; total_piezas = "No. of Pieces"; fecha = fecha del vuelo; ' +
      'tarifa_kg = "Rate/Charge" por kg; cargos = cada uno de los "Other Charges" con su código de 3 letras (FEC, MCC, MAA, CHC, XDC, AWC…) y su importe total en USD). ' +
      'PESOS = recibo de bodega / informe con el peso de cada finca o embarcador: rellena fincas[] con UNA entrada por embarcador ' +
      '(finca = nombre del EMBARCADOR, piezas = total de piezas del embarcador, kg = su PESO REAL total en kg, sumando todas sus líneas ' +
      'o usando su fila de total; NO uses el peso volumen ni las medidas de la caja en cm). La suma de kg debe dar el peso total del recibo. ' +
      'OTRO = cualquier otro documento.',
      blob, 'application/pdf', 3000);
    if (!r) return null;
    r._tipo = ['MASTER', 'FLETE', 'GUIA', 'PESOS'].indexOf(r.tipo_doc) >= 0 ? r.tipo_doc : 'DOC';
    if (r._tipo === 'MASTER' && blob) completarKgMaster_(r, blob);
    return r;
  }
  const prompt =
    'Factura de una finca de flores (Ecuador/Colombia) a ROSAS DE BUSCAFLOR. Responde SOLO JSON:\n' +
    '{"finca":"nombre comercial del VENDEDOR que emite la factura, tal como sale en la CABECERA del PDF (nunca el cliente ROSAS DE BUSCAFLOR, ni el remitente del correo: ' +
    'Cantiza Growers y Valthomig mandan desde el mismo correo y hay que poner la que firma el PDF) en MAYÚSCULAS sin S.A./S.A.S./CIA LTDA","numero":"","fecha":"AAAA-MM-DD","awb":"075-XXXXXXXX","hawb":"",' +
    '"piezas":n,"full":n,"tallos":n,"total_usd":n,"lineas":[{"tipo":"ROSAS|PANICULATA|CLAVEL|ALSTROEMERIA|HORTENSIAS|OTROS",' +
    '"variedad":"MAYÚSCULAS","medida":"cm como texto, vacío si la línea no la indica","paquetes":n,"tallos_paquete":n,"usd_tallo":n}]}\n' +
    'Reglas: une las líneas iguales (misma variedad, medida y precio). Si una caja surtida (MIX/MIXED BOX) detalla su composición, ' +
    'crea una línea por cada variedad/color con sus paquetes (alstroemeria: nombre del color + SELECT, ej. "PINK SELECT"). ' +
    'Clavel e HORTENSIAS: tallos_paquete = 1 y paquetes = nº de tallos (en hortensia "QBx25" es la caja, no un ramo); variedad tipo "FANCY BLANCO". Si el precio viene por bunch, divídelo ' +
    'entre los tallos del bunch. En variedad y medida NO uses . # $ / [ ] (sustitúyelos por "-").\n' +
    '"piezas" = nº de CAJAS del envío (columna BOX, PIECES, BXS o "Total Pieces"), NUNCA los ramos: en las facturas de Cantiza ' +
    'Growers y Valthomig la columna "BOX" son las cajas (p. ej. 1 HB) y "BUNCH QTY" los ramos (p. ej. 8). "full" = cajas full equivalentes ' +
    '("Number in Fulls", "Full Boxes"; una HB = 0,5).\n' +
    'MUY IMPORTANTE: "paquetes" = nº de RAMOS/BUNCHES de esa línea (NO cajas, NO piezas). "tallos_paquete" = tallos por ramo ' +
    '(normalmente 25 en rosas; 10, 12 o 20 en otras flores), NUNCA el total de tallos de la línea. "usd_tallo" = precio de UN tallo: ' +
    'si la factura ya da el precio por tallo (p. ej. 0,30) NO lo dividas. "medida" = largo del tallo en cm (40-120 en rosas); ' +
    'si no aparece, déjala vacía (no pongas los tallos por ramo). OJO: hay fincas (Rosalinda y otras) que no escriben la medida, ' +
    'sino que tienen una COLUMNA por largo (cabeceras 120 110 100 90 80 70 60 50 40) y ponen el nº de ramos debajo de la que toca: ' +
    'entonces la medida de la línea es la CABECERA de la columna donde está su número de ramos (cada línea puede ir en una distinta). ' +
    'Comprueba antes de responder que para cada línea ' +
    'paquetes × tallos_paquete × usd_tallo = importe de la línea, y que la suma de todas las líneas da el total de tallos y el total USD. ' +
    'Cargos que NO son flor (documentos, cajas, handling…): una línea tipo OTROS con variedad = el concepto, paquetes 1, tallos_paquete 1 y ' +
    'usd_tallo = su importe; no los cuentes en "tallos". Si la factura no dice los tallos por ramo, en rosas son 25.' +
    (textoExcel ? '\n\nLa factura viene en una HOJA DE CÁLCULO. Este es su contenido, fila a fila (celdas separadas por " | "):\n' + textoExcel : '') +
    pistaFarmKN_(file);                                   // copia del FARM INVOICES de K+N: solo la factura de esa finca
  let r = iaJson_(prompt, blob, 'application/pdf', 8000, VUELOS.MODELO_FACTURAS);
  if (!r) return null;
  // Copia del FARM INVOICES en la que no está la finca: queda anotada como "otro documento" y no se vuelve a leer
  if (RX_FARM_KN.test(file.getName()) && !r.numero && !(Number(r.total_usd) > 0)) { r._tipo = 'DOC'; return r; }
  repararFactura_(r);
  let c = cuadreFactura_(r);
  if (!c.ok) {
    // Segunda lectura diciéndole a la IA en qué se ha equivocado
    const r2 = iaJson_(prompt + '\n\nATENCIÓN: en una primera lectura tus líneas sumaban ' + c.tallos + ' tallos y ' +
      c.usd.toFixed(2) + ' USD, pero la factura dice ' + (r.tallos || '?') + ' tallos y ' + (r.total_usd || '?') +
      ' USD. Vuelve a leerla con cuidado (paquetes = ramos, no cajas; precio por tallo).', blob, 'application/pdf', 8000, VUELOS.MODELO_FACTURAS);
    if (r2) {
      repararFactura_(r2);
      const c2 = cuadreFactura_(r2);
      if (c2.ok || c2.error < c.error) { r = r2; c = c2; }
    }
  }
  // Rosas sin medida (Rosalinda 17747: la medida va por columnas 120…40 y la IA no la vio): una lectura más solo para eso
  const sinMedida = x => (x.lineas || []).filter(l => String(l.tipo || 'ROSAS').toUpperCase() === 'ROSAS' && !String(l.medida || '').trim()).length;
  const sm = sinMedida(r);
  if (sm > 0) {
    const r3 = iaJson_(prompt + '\n\nATENCIÓN: en una primera lectura dejaste ' + sm + ' líneas de rosas SIN MEDIDA. Busca el largo en cm de cada ' +
      'línea: si la factura tiene columnas con los largos como cabecera (120 110 100 90 80 70 60 50 40), la medida es la cabecera de la ' +
      'columna donde aparece el número de ramos de esa línea. Mantén el mismo detalle de líneas, paquetes y precios.', blob, 'application/pdf', 8000, VUELOS.MODELO_FACTURAS);
    if (r3) {
      repararFactura_(r3);
      const c3 = cuadreFactura_(r3);
      if (sinMedida(r3) < sm && (c3.ok || !c.ok)) { r = r3; c = c3; }
    }
  }
  if (!c.ok) r._aviso = 'Factura ' + corto_(r.finca) + ' ' + (r.numero || '') + ': las líneas suman ' + c.tallos + ' tallos / ' +
    c.usd.toFixed(2) + ' USD y la factura dice ' + (r.tallos || '?') + ' tallos / ' + (r.total_usd || '?') + ' USD. Revísala.';
  r._tipo = 'FINCA';
  return r;
}

/** Suma de tallos e importe de las líneas frente a los totales de la factura */
function cuadreFactura_(r) {
  let tallos = 0, usd = 0;
  (r.lineas || []).forEach(l => {
    const st = Number(l.paquetes || 0) * Number(l.tallos_paquete || 1);
    tallos += st; usd += st * Number(l.usd_tallo || 0);
  });
  const T = Number(r.tallos) || 0, U = Number(r.total_usd) || 0;
  const eT = T ? Math.abs(tallos - T) / T : 0, eU = U ? Math.abs(usd - U) / U : 0;
  return { ok: eT <= 0.01 && eU <= 0.02, tallos: tallos, usd: usd, error: eT + eU };
}

/**
 * Corrige errores típicos de lectura antes de usar la factura:
 *  1) "tallos_paquete" con el TOTAL de la línea (100, 300…) en vez de los tallos por ramo → se rehace el ramo (x25 en rosas).
 *  2) Precio por tallo dividido otra vez entre el ramo (0,012 en vez de 0,30): si los tallos cuadran y el importe no,
 *     se escalan los precios para que sumen el total de la factura.
 *  3) Medida con los tallos por ramo (25) en rosas → sin medida ("?").
 */
// Línea de flor que la IA marcó como OTROS (Solpacific 001246069: "MONDIAL 40 · 12 ramos x25" como OTROS): los cargos sueltos
// van con 1 paquete de 1 tallo; si trae ramos de varios tallos es flor → el tipo de la factura (o ROSAS).
function corregirTipoOtros_(r) {
  const tipos = (r.lineas || []).map(l => String(l.tipo || '').toUpperCase()).filter(t => t && t !== 'OTROS');
  const tipoFactura = tipos.length ? tipos.sort((a, b) => tipos.filter(x => x === b).length - tipos.filter(x => x === a).length)[0] : 'ROSAS';
  (r.lineas || []).forEach(l => {
    if (String(l.tipo || '').toUpperCase() === 'OTROS' && Number(l.tallos_paquete || 1) >= 5 && Number(l.usd_tallo || 0) < 5) l.tipo = tipoFactura;
  });
}

function repararFactura_(r) {
  corregirTipoOtros_(r);
  // Cajas leídas como ramos (Cantiza/Valthomig: "1 HB … BUNCH 8" → piezas 8): si las piezas son los ramos de la factura
  // y hay cajas full, las piezas salen de las full (media caja HB = 0,5 full).
  const ramos = (r.lineas || []).filter(l => !/OTROS/i.test(l.tipo || '')).reduce((a, l) => a + Number(l.paquetes || 0), 0);
  const full = Number(r.full) || 0;
  if (Number(r.piezas) > 2 && Number(r.piezas) === ramos && full > 0 && full * 4 < Number(r.piezas)) r.piezas = Math.max(1, Math.round(full * 2));
  (r.lineas || []).forEach(l => {
    const tipo = String(l.tipo || 'ROSAS').toUpperCase();
    let paq = Number(l.paquetes || 0), tp = Number(l.tallos_paquete || 1);
    if (tipo !== 'CLAVEL' && tp > 60) {                       // tp es en realidad el total de tallos de la línea
      const st = tp;
      const porRamo = paq > 1 && st % paq === 0 && st / paq >= 5 && st / paq <= 50 ? st / paq : (tipo === 'ROSAS' ? 25 : 0);
      if (porRamo && st % porRamo === 0) { l.tallos_paquete = porRamo; l.paquetes = st / porRamo; }
    }
    if (tipo === 'ROSAS' && Number(l.medida) > 0 && Number(l.medida) < 30) l.medida = '';
  });
  const c = cuadreFactura_(r);
  const T = Number(r.tallos) || 0, U = Number(r.total_usd) || 0;
  if (U > 0 && c.usd > 0 && (!T || Math.abs(c.tallos - T) / T <= 0.01)) {
    // solo si el error es "precio dividido entre el ramo" (factor ≈ 10, 12, 20, 25…); si no, se deja para la 2ª lectura
    const k = U / c.usd;
    const tps = (r.lineas || []).map(l => Number(l.tallos_paquete || 1)).filter(x => x > 1);
    if (Math.abs(k - 1) > 0.02 && tps.some(tp => Math.abs(k - tp) / tp < 0.03)) {
      (r.lineas || []).forEach(l => { l.usd_tallo = Number(l.usd_tallo || 0) * k; });
    }
  }
}

// ─────────────────────────────── facturas en Excel ───────────────────────────────

function esExcel_(f) {
  return ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].indexOf(f.getMimeType()) >= 0 ||
    /\.xlsx?$/i.test(f.getName());
}

/**
 * Convierte un Excel (.xls / .xlsx) en texto para que lo lea la IA: hace una copia temporal como Hoja de cálculo de Google,
 * lee sus celdas y borra la copia. Necesita el servicio "Drive API" activado en el editor (Servicios → + → Drive API → Añadir).
 */
function excelATexto_(file) {
  let tmpId = null;
  try {
    const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '/copy', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ name: '_tmp lectura ' + file.getName(), mimeType: 'application/vnd.google-apps.spreadsheet' })
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('No se pudo convertir el Excel "' + file.getName() + '" (' + res.getResponseCode() + '). ' +
        'Activa el servicio Drive API: en el editor, Servicios → + → Drive API → Añadir. Detalle: ' + res.getContentText().slice(0, 300));
      return '';
    }
    tmpId = JSON.parse(res.getContentText()).id;
    const out = [];
    SpreadsheetApp.openById(tmpId).getSheets().forEach(sh => {
      if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) return;
      out.push('--- Hoja: ' + sh.getName() + ' ---');
      sh.getRange(1, 1, Math.min(sh.getLastRow(), 400), Math.min(sh.getLastColumn(), 40)).getDisplayValues().forEach(fila => {
        const celdas = fila.map(c => String(c).trim()).filter(c => c);
        if (celdas.length) out.push(celdas.join(' | '));
      });
    });
    return out.join('\n').slice(0, 30000);
  } catch (e) {
    Logger.log('Error leyendo el Excel "' + file.getName() + '": ' + e);
    return '';
  } finally {
    if (tmpId) { try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) {} }
  }
}

/** Prueba: ejecuta esta función para ver qué lee el sistema del primer Excel que encuentre en las "Facturas fincas" recientes. */
function probarExcel() {
  let hecho = false;
  carpetasAwbRecientes_().forEach(({ awb, carpeta }) => {
    const subs = carpeta.getFolders();
    while (subs.hasNext() && !hecho) {
      const sub = subs.next();
      if (!RX_SUB.FINCAS.test(sub.getName())) continue;
      const files = sub.getFiles();
      while (files.hasNext() && !hecho) {
        const f = files.next();
        if (!esExcel_(f)) continue;
        hecho = true;
        const t = excelATexto_(f);
        Logger.log('Vuelo ' + awb + ' · ' + f.getName() + '\n' + (t || '(no se pudo convertir)'));
        if (t) Logger.log(JSON.stringify(leerDocumentoVuelo_(f, 'FINCA', 0, t), null, 1));
      }
    }
  });
  if (!hecho) Logger.log('No hay ningún Excel en las carpetas "Facturas fincas" de los vuelos recientes.');
}

// ─────────────────────────────── cuadre y generación ───────────────────────────────

function evaluarVuelo_(awb, carpeta, semana, docs) {
  const mios = Object.keys(docs).filter(id => docs[id].awb === awb).map(id => Object.assign({ id: id }, docs[id]));
  // FARM INVOICES de K+N (FarmInvoicesKN.gs): si la factura de la finca ya llegó por su cuenta, manda esa y la copia no cuenta
  quitarCopiasFarmKN_(awb, mios);
  const notaFarm = notaFarmKN_(mios);
  // Master: si hay varias (K+N manda varios informes), manda el Consolidation Report (CR). Los pre-alert ya vienen como PREALERT.
  const esCR = d => /(^|[_ ])CR[_ ]|consolidation/i.test(d.nombre || '');
  const esAWB = d => /(^|[_ ])AWB[_ ]/i.test(d.nombre || '') && !/DOCAWB/i.test(d.nombre || '');
  let master = mios.find(d => d.tipo === 'MASTER' && esCR(d)) || mios.find(d => d.tipo === 'MASTER');
  // La misma factura dos veces en la carpeta (la finca la reenvió): se cuenta UNA sola vez, aunque la IA haya leído
  // importes distintos en cada copia (Plazoleta 179277: 2.016 y 1.961,60). Vale la copia más reciente (el reenvío suele ser
  // la corregida). Mismo proveedor = mismo nombre o alias.
  const vistas = {};
  let fincas = mios.filter(d => d.tipo === 'FINCA').map(d => d.data).reverse().filter(f => {
    const n = String(f.numero || '').replace(/\D/g, '').replace(/^0+/, '');
    if (!n) return true;
    const k = nombreProveedor_(f.finca) + '|' + n + '|' + String(f.hawb || '').toUpperCase();   // con HAWB: Quimbiamba pone siempre 001005
    if (vistas[k]) return false;
    return (vistas[k] = true);
  }).reverse();
  fincas.forEach(corregirTipoOtros_);                    // también en las facturas ya leídas
  // Facturas que la finca puso en esta guía pero que NO vuelan en ella (no caben, se quedan en el cuarto frío para el siguiente
  // vuelo…): si la Master o la Final Alert traen el HAWB de cada finca y el de la factura no está, la factura no entra en este
  // inventario. Queda pendiente y, cuando su HAWB aparezca en otro vuelo, reubicarPorHawb_ la pasa sola a ese vuelo.
  let notaFuera = '';
  const hv0 = hawbsDelVuelo_(mios);
  if (hv0) {
    const fuera = fincas.filter(f => { const h = normHawb_(f.hawb); return h.length >= 5 && !hv0.set[h]; });
    if (fuera.length) {
      fincas = fincas.filter(f => fuera.indexOf(f) < 0);
      notaFuera = 'No van en este vuelo (su HAWB no está en la ' + hv0.fuente + '), así que no cuentan en el inventario: ' +
        fuera.map(f => corto_(f.finca) + ' ' + (f.numero || '') + ' (HAWB ' + f.hawb + ', ' + (f.piezas || '?') + ' cajas, ' + (f.tallos || '?') + ' tallos)').join('; ') +
        '. Cuando aparezcan en la Master o la Final Alert de otro vuelo, se pasarán solas a ese vuelo.';
    }
  }
  const hv = hojaVuelos_();
  const fila = filaVuelo_(hv, awb);
  const estadoPrevio = fila ? String(hv.getRange(fila, 4).getValue()) : '';

  // Nombre de la carpeta con el transitario ("AWB 075-68009852 · Kuehne+Nagel") en cuanto se sabe por la Master o la guía
  ponerTransitarioCarpeta_(carpeta, awb, mios);

  // Sin Master Invoice (Saftec no la manda adjunta: hay que bajarla de su enlace): si las facturas de las fincas suman
  // exactamente las cajas de la guía, el vuelo está completo y se hace el inventario con ellas. Cuando llegue la Master, se rehace.
  // Vuelo de Saftec sin Master: se baja del enlace "Download Farm Invoices" (…/attachs/075-6808 1042/inv.pdf),
  // por si el correo del pre-alert no se pudo abrir. Se lee en la siguiente pasada.
  if (!master && esVueloSaftec_(carpeta, mios) && bajarMasterSaftecVuelo_(awb, carpeta)) {
    actualizarVuelo_(hv, fila, awb, 'MASTER DE SAFTEC DESCARGADA (se lee en la próxima pasada)', '', '');
    return;
  }
  let sinMaster = '';
  // NO hay inventarios provisionales (Javier, 19-11-2026): el inventario solo se hace cuando están TODAS las facturas de
  // las fincas y la del flete. Si falta alguna y ya ha llegado la guía, UN aviso por correo con lo que falta.
  const parcial = null;
  const guiaLlegada = mios.find(d => d.tipo === 'GUIA');
  // La Final Alert (Logike) dice qué HAWB vuelan: cada HAWB tiene que tener su factura. Se cruza por HAWB, no por nombre
  // (Cantiza Growers y Valthomig son del mismo grupo y facturan desde el mismo remitente).
  const faltanAlerta = faltanPorAlerta_(mios, fincas);
  if (!master) {
    const g0 = mios.find(d => d.tipo === 'GUIA' && esAWB(d) && Number(d.data.total_piezas) > 0) ||
               mios.find(d => d.tipo === 'GUIA' && Number(d.data.total_piezas) > 0);
    const cajasGuia = g0 ? Number(g0.data.total_piezas) : 0;
    const cajasFact = Math.round(fincas.reduce((a, f) => a + (Number(f.piezas) || 0), 0) * 100) / 100;
    const faltanCajas = cajasGuia && fincas.length ? Math.round((cajasGuia - cajasFact) * 100) / 100 : 0;
    if (!cajasGuia || !fincas.length || faltanCajas < -0.01) {
      actualizarVuelo_(hv, fila, awb, 'SIN MASTER INVOICE' + (cajasGuia ? ' (facturas: ' + cajasFact + ' de ' + cajasGuia + ' cajas de la guía)' : ''), '', '');
      return;
    }
    if (faltanCajas > 0.01 || faltanAlerta.length) {
      const lineas = faltanAlerta.length
        ? faltanAlerta.map(f => '· ' + f.finca + ' — HAWB ' + f.hawb + (f.piezas ? ', ' + f.piezas + ' cajas' : ''))
        : ['· Facturas de ' + faltanCajas + ' cajas: las fincas suman ' + cajasFact + ' de las ' + cajasGuia + ' cajas de la guía (no hay Master para saber de quién son).'];
      avisarFaltan_(hv, fila, awb, semana, 'FALTAN FACTURAS (' + cajasFact + ' de ' + cajasGuia + ' cajas)', lineas, guiaLlegada);
      return;
    }
    master = { id: 'SIN_MASTER', data: { pais: g0.data.pais, transitario: g0.data.transitario, total_piezas: cajasGuia, sin_master: true,
      fincas: fincas.map(f => ({ finca: f.finca, hawb: f.hawb || '', factura: f.numero || '', piezas: Number(f.piezas) || 0,
        full: Number(f.full) || 0, kg: 0, tallos: Number(f.tallos) || 0, usd: Number(f.total_usd) || 0 })) } };
    sinMaster = parcial ? '' : 'Hecho SIN Master Invoice: las ' + fincas.length + ' facturas de fincas suman ' + cajasFact +
      ' cajas, las mismas que la guía. Si subes la Master a "Documentos vuelo", el inventario se rehace con ella.';
  }
  const m = normalizarMaster_(master.data, mios);

  // ¿Están todas las fincas de la Master?
  // 1º las facturas que casan exactamente con una línea (HAWB, nº o tallos+importe);
  // 2º una línea sin pareja exacta se da por cubierta si hay una factura LIBRE de esa misma finca
  //    (la Master mal leída: AGRINGA 280 tallos ≈ factura Agrinag 250). La diferencia sale como aviso en el inventario.
  const usadas = fincas.filter(f => (m.fincas || []).some(mf => casa_(mf, f)));
  //    …siempre que la diferencia sea pequeña (≤ 15 %): si faltan muchos tallos es que falta OTRA factura de esa finca.
  const casiCubierta = mf => {
    const libres = fincas.filter(f => usadas.indexOf(f) < 0 && mismaFinca_(mf.finca, f.finca));
    if (!libres.length) return false;
    const T = Number(mf.tallos) || 0, U = Number(mf.usd) || 0;
    const t = libres.reduce((a, f) => a + (Number(f.tallos) || 0), 0), u = libres.reduce((a, f) => a + (Number(f.total_usd) || 0), 0);
    return T > 0 ? Math.abs(t - T) <= 0.15 * T : (U > 0 ? Math.abs(u - U) <= 0.15 * U : true);
  };
  // 3º Master con datos de relleno (CR de K+N del 075-68013201: "200 STEMS · 0,22 · 44 USD" para 125 cajas de clavel y alstro):
  //    si la Master trae UNA sola finca y sus facturas suman exactamente las cajas de la guía (o las de la Master), el vuelo
  //    está completo: se hace el inventario con las facturas y se avisa de que la Master no sirve para cuadrar tallos/importe.
  const gCajas = mios.find(d => d.tipo === 'GUIA' && esAWB(d) && Number(d.data.total_piezas) > 0) ||
                 mios.find(d => d.tipo === 'GUIA' && Number(d.data.total_piezas) > 0);
  const cajasGuiaM = gCajas ? Number(gCajas.data.total_piezas) : 0;
  let notaMaster = '';
  const porCajas = mf => {
    if ((m.fincas || []).length !== 1) return false;
    const libres = fincas.filter(f => mismaFinca_(mf.finca, f.finca));
    const cajas = Math.round(libres.reduce((a, f) => a + (Number(f.piezas) || 0), 0) * 100) / 100;
    if (!libres.length || !cajas) return false;
    const ok = (cajasGuiaM && Math.abs(cajas - cajasGuiaM) < 0.01) || Math.abs(cajas - Number(mf.piezas || 0)) < 0.01;
    if (ok) notaMaster = 'La Master Invoice de ' + mf.finca + ' trae datos que no cuadran (' + (mf.tallos || '?') + ' tallos, ' +
      (mf.usd || '?') + ' USD), pero las ' + libres.length + ' facturas suman ' + cajas + ' cajas, las mismas que la guía: ' +
      'el inventario se ha hecho con las facturas.';
    return ok;
  };
  ponerHawbAlerta_(m.fincas || [], mios);                 // HAWB de cada finca de la Master sacado de la Final Alert
  const faltan = (m.fincas || []).filter(mf => !cubierta_(mf, fincas) && !casiCubierta(mf) && !porCajas(mf));
  // …y lo que la Final Alert dice que vuela y no tiene factura (aunque la Master lo dé por cubierto con otra del grupo)
  faltanAlerta.forEach(a => {
    if (!faltan.some(f => normHawb_(f.hawb) === normHawb_(a.hawb))) faltan.push({ finca: a.finca, hawb: a.hawb, piezas: a.piezas });
  });
  if (faltan.length) {
    // Kuehne+Nagel: antes de avisar, las que faltan se sacan del FARM INVOICES del correo de K+N (Invos la manda tarde).
    // Se leen en la próxima pasada; si con ellas ya están todas, sale el inventario.
    if (guiaLlegada && esVueloKN_(carpeta, mios) && sacarDeFarmInvoicesKN_(awb, carpeta, faltan) > 0) {
      actualizarVuelo_(hv, fila, awb, 'FACTURAS SACADAS DEL FARM INVOICES DE K+N (se leen en la próxima pasada)', '', '');
      return;
    }
    // Sin inventario hasta que estén todas. Un solo aviso, cuando llega la guía; después, silencio hasta que esté listo.
    avisarFaltan_(hv, fila, awb, semana, 'FALTAN: ' + faltan.map(f => corto_(f.finca) + (f.hawb ? ' ' + f.hawb : '')).join(', '),
      faltan.map(f => '· ' + f.finca + ' — factura ' + (f.factura || '?') + ', HAWB ' + (f.hawb || '?') +
        (f.piezas ? ', ' + f.piezas + ' cajas' : '') + (f.tallos ? ', ' + f.tallos + ' tallos' : '') + (f.usd ? ', ' + f.usd + ' USD' : '')),
      guiaLlegada);
    return;
  }

  // Flete: factura del transitario > total de la Master > cargos de la guía (provisional)
  // Si el transitario manda una factura corregida (Logike LC-17690 dos veces), vale la ÚLTIMA
  const docFlete = mios.filter(d => d.tipo === 'FLETE' && Number(d.data.flete_usd) > 0).pop();
  const docGuia = mios.find(d => d.tipo === 'GUIA' && esAWB(d) && Number(d.data.flete_usd) > 0) || mios.find(d => d.tipo === 'GUIA' && Number(d.data.flete_usd) > 0);
  let fleteUsd = 0, origenFlete = '', provisional = false;
  if (docFlete) { fleteUsd = totalFactura_(docFlete.data); origenFlete = 'factura del transitario'; }
  // El "flete" de la Master solo vale si es creíble (0,8–8 USD/kg). La de Saftec trae a veces una línea "613 K 214.55"
  // (0,35 USD/kg, un cargo por kilo) que NO es el flete aéreo: entonces manda la guía (provisional) o la factura de Saftec.
  else if (Number(m.flete_usd) > 0 && fleteCreible_(Number(m.flete_usd), (docGuia && Number(docGuia.data.kg)) || Number(m.kg) || 0)) {
    fleteUsd = Number(m.flete_usd); origenFlete = 'Master Invoice';
  }
  else if (docGuia) {
    fleteUsd = Number(docGuia.data.flete_usd);
    // Kuehne+Nagel (Colombia) no manda factura de flete: se paga por la GUÍA, así que su Total Prepaid es DEFINITIVO
    const esKN = m.pais === 'CO' || /kuehne|k\s*\+\s*n/i.test(String(m.transitario || '') + ' ' + String(docGuia.data.transitario || ''));
    origenFlete = esKN ? 'Total Prepaid de la guía AWB (K+N se paga por la guía)' : 'cargos de la guía AWB (falta la factura del transitario)';
    provisional = !esKN;
  }
  // Sin factura del transitario (y no es K+N, que se paga por la guía): no se hace inventario provisional, se avisa y se espera
  if (!fleteUsd || provisional) {
    avisarFaltan_(hv, fila, awb, semana, 'FALTA FACTURA DEL FLETE',
      ['· Factura del flete del transitario (' + (m.transitario || (guiaLlegada && guiaLlegada.data.transitario) || 'transitario') + ')' +
        (provisional ? ': la guía dice ' + fleteUsd + ' USD, pero el inventario se hace con la factura.' : '')],
      guiaLlegada, 'FLETE:');
    return;
  }

  const estado = 'DEFINITIVO';
  const firma = mios.map(d => d.id).sort().join(',');
  const firmaPrevia = fila ? String(hv.getRange(fila, 6).getValue()) : '';
  if (firma === firmaPrevia && estadoPrevio === 'INVENTARIO ' + estado) return;

  // Pesos por finca: el recibo de bodega de K+N ("<guía>_<número>.pdf" o "Recibo bodega…") antes que cualquier otro informe
  const esRecibo = d => /recibo.*bodega|warehouse|(^|_)\d{3}-?\d{8}_\d{6,}\.pdf$/i.test(d.nombre || '');
  const pesos = mios.find(d => d.tipo === 'PESOS' && esRecibo(d)) || mios.find(d => d.tipo === 'PESOS');
  let kgGuia = docGuia ? Number(docGuia.data.kg) || 0 : (mios.find(d => d.tipo === 'GUIA') || { data: {} }).data.kg || 0;
  // Peso de la guía mal leído (p. ej. 29,062 = "AV.CW", el peso medio por caja, en vez de los 1.533 kg tasables):
  // un flete solo es creíble entre 0,8 y 8 USD/kg. Si la guía no lo es y el recibo de bodega sí, manda el recibo.
  const kgRecibo = pesos ? ((pesos.data || {}).fincas || []).reduce((a, x) => a + Number(x.kg || 0), 0) : 0;
  const creible = k => k > 0 && fleteUsd / k >= 0.8 && fleteUsd / k <= 8;
  if (!creible(kgGuia) && creible(kgRecibo)) {
    kgGuia = kgRecibo;
    if (docGuia) docGuia.data = Object.assign({}, docGuia.data, { kg: kgRecibo });
  }
  // Recibo de bodega que no cuadra con la guía: se relee UNA vez (ya con el peso de la guía como pista)
  if (pesos && kgGuia && pais_(m) === 'COL') {
    const kgP = kgRecibo;
    const props = PropertiesService.getScriptProperties(), marca = 'PESOS_RELEIDO_' + pesos.id;
    if (Math.abs(kgP - kgGuia) / kgGuia > 0.05 && !props.getProperty(marca)) {
      props.setProperty(marca, '1');
      borrarDoc_(pesos.id); delete docs[pesos.id];
      actualizarVuelo_(hv, fila, awb, 'RELEYENDO RECIBO DE BODEGA', '', '');
      return;
    }
  }
  const guiaDoc = docGuia || mios.find(d => d.tipo === 'GUIA');
  if (pesos && pesos.data && pesos.data.fincas) ponerHawbAlerta_(pesos.data.fincas, mios);   // DIM de Logike: sin HAWB → de la Final Alert
  const res = crearInventario_(awb, carpeta, semana, m, fincas, fleteUsd, origenFlete, estado, pesos ? pesos.data : null, Number(kgGuia) || 0,
    guiaDoc ? guiaDoc.data : null, parcial);
  actualizarVuelo_(hv, fila, awb, 'INVENTARIO ' + estado, res.url, firma);
  firebaseVuelo_(awb, { guia: awb, semana: String(semana).split(' ')[0], origen: pais_(m) === 'COL' ? 'Colombia' : 'Ecuador',
    transitario: nombreTransitario_(m.transitario), cajas: Number(m.total_piezas) || null,
    inventario: { estado: estado, url: res.url } });
  MailApp.sendEmail(CONFIG.ALERT_EMAIL, '[Buzón Buscaflor] Inventario ' + estado.toLowerCase() + ': AWB ' + awb,
    'Inventario del vuelo ' + awb + ' (' + semana + '): ' + res.url + '\n\nEstado: ' + estado +
    (provisional ? ' — el flete sale de la guía; se actualizará solo cuando llegue la factura del transitario.' : '') +
    (sinMaster ? '\n\n' + sinMaster : '') +
    (notaMaster ? '\n\n' + notaMaster : '') +
    (notaFuera ? '\n\n' + notaFuera : '') +
    (notaFarm ? '\n\n' + notaFarm : '') +
    (res.avisos.length ? '\n\nRevisa:\n· ' + res.avisos.join('\n· ') : ''));
}

// ─────────────────────── factura con la guía equivocada (se corrige por el HAWB) ───────────────────────
/**
 * La finca a veces pone en la factura la guía (MAWB) de OTRO vuelo: Floranrosa 001038217 decía 075-69143616, pero su
 * HAWB S1447587 viaja en la Master de 075-69143631. Manda el HAWB: si la Master del vuelo asignado no lo trae y la Master
 * de UN solo vuelo distinto sí, la factura se pasa a ese vuelo (registro, carpeta "Facturas fincas" y nombre del acceso
 * en "Pendientes de pago"/"Pagadas" del proveedor). Los dos inventarios se rehacen solos, porque cambian sus documentos.
 */
function reubicarPorHawb_(docs, vuelos) {
  const norm = h => String(h || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const enMaster = {}, conMaster = {};
  Object.keys(docs).forEach(id => {
    const d = docs[id];
    if ((d.tipo !== 'MASTER' && d.tipo !== 'ALERTA') || !d.awb) return;
    conMaster[d.awb] = true;
    ((d.data || {}).fincas || []).forEach(mf => {
      const h = norm(mf.hawb);
      if (h.length >= 5) (enMaster[h] = enMaster[h] || {})[d.awb] = true;
    });
  });
  Object.keys(docs).forEach(id => {
    const d = docs[id];
    if (d.tipo !== 'FINCA' || !d.awb) return;
    const h = norm((d.data || {}).hawb);
    if (h.length < 5 || !enMaster[h] || enMaster[h][d.awb]) return;      // sin HAWB, o ya está en su vuelo
    if (!conMaster[d.awb] && Object.keys(enMaster[h]).length !== 1) return;
    const otros = Object.keys(enMaster[h]).filter(a => a !== d.awb);
    if (otros.length !== 1) return;                                       // dudoso: se deja como está
    try {
      if (DriveApp.getFileById(id).isTrashed()) return;                   // la borraste: no se mueve
      moverFacturaDeVuelo_(id, d, d.awb, otros[0], vuelos);
    } catch (e) { Logger.log('No se pudo pasar de vuelo ' + (d.nombre || id) + ': ' + e); }
  });
}

const RX_FINAL_ALERT = /final\s*alert/i;
const RX_DIM = /(^|[_\s-])DIM([_\s.-]|$)/i;

/**
 * DIM de Logike (Excel "DIM 3141.xlsx"): una fila por finca con "FINCA | full | piezas | largo | ancho | alto | piezas | PESO | VOLUMEN".
 * El PESO (kg reales de bodega) es el penúltimo número de la fila de la finca. Devuelve un documento PESOS.
 */
function leerDim_(texto) {
  const fincas = [];
  String(texto || '').split('\n').forEach(linea => {
    const c = linea.split('|').map(x => x.trim()).filter(x => x);
    if (c.length < 4 || !/[A-Za-z]{3}/.test(c[0]) || /total|fincas|consignee|piezas|largo|^mad$/i.test(c[0])) return;
    const nums = c.slice(1).map(x => Number(String(x).replace(',', '.'))).filter(x => !isNaN(x));
    if (nums.length < 4) return;
    const kg = nums[nums.length - 2];
    if (kg > 0) fincas.push({ finca: c[0], piezas: nums[1] || 0, kg: kg });
  });
  return { tipo_doc: 'PESOS', fincas: fincas, kg: fincas.reduce((a, f) => a + f.kg, 0) };
}
function normHawb_(h) { return String(h || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Filas de la Final Alert del vuelo (las que vuelan, con su HAWB). [] si no hay. */
function filasAlerta_(mios) {
  const out = [];
  mios.filter(d => d.tipo === 'ALERTA').forEach(d => ((d.data || {}).fincas || []).forEach(f => {
    if (normHawb_(f.hawb).length >= 5 && !out.some(x => normHawb_(x.hawb) === normHawb_(f.hawb))) out.push(f);
  }));
  return out;
}
/**
 * HAWB de la Final Alert que no tienen factura. Manda el HAWB: una factura con HAWB solo cubre el suyo. Una factura SIN HAWB
 * cubre una fila de su misma finca (y, en un grupo, de su misma empresa: Cantiza Growers ≠ Valthomig).
 */
function faltanPorAlerta_(mios, fincas) {
  const filas = filasAlerta_(mios);
  if (!filas.length) return [];
  const libres = fincas.filter(f => normHawb_(f.hawb).length < 5);
  return filas.filter(a => {
    const h = normHawb_(a.hawb);
    if (fincas.some(f => normHawb_(f.hawb) === h)) return false;
    const i = libres.findIndex(f => mismaFinca_(a.finca, f.finca));
    if (i >= 0) { libres.splice(i, 1); return false; }
    return true;
  });
}
/**
 * Pone el HAWB de la Final Alert en las filas (Master, DIM de Logike) que no lo traen, casando por el nombre EXACTO del
 * embarcador (la Final Alert y el DIM de Logike usan el mismo: "VALTHOMIG S.A", "CANTIZA GROWERS S.A.").
 */
function ponerHawbAlerta_(filas, mios) {
  const al = filasAlerta_(mios);
  if (!al.length) return;
  const k = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  filas.forEach(x => {
    if (normHawb_(x.hawb).length >= 5) return;
    let c = al.filter(a => k(a.finca) === k(x.finca));
    if (!c.length) c = al.filter(a => mismaFinca_(a.finca, x.finca));
    if (c.length === 1) x.hawb = c[0].hawb;
  });
}
/**
 * Aviso de que faltan facturas (o la del flete): solo cuando ya ha llegado la guía y UNA vez por guía (la columna 5 de
 * "Vuelos" guarda a qué guía se avisó). Sin guía, solo se apunta el estado en "Vuelos".
 */
function avisarFaltan_(hv, fila, awb, semana, estado, lineas, guia, prefijo) {
  const clave = (prefijo || '') + (guia ? guia.id : '');
  const previo = fila ? String(hv.getRange(fila, 5).getValue()) : '';
  if (!guia || previo === clave) { actualizarVuelo_(hv, fila, awb, estado, '', ''); return; }
  MailApp.sendEmail(CONFIG.ALERT_EMAIL, '[Buzón Buscaflor] Ha llegado la guía y faltan facturas: AWB ' + awb,
    'Ha llegado la guía del vuelo ' + awb + ' (' + semana + ') y faltan estas facturas:\n\n' + lineas.join('\n') +
    '\n\nNo hago inventario hasta que estén todas (no hay inventarios provisionales). Súbelas a "Facturas fincas" (o ' +
    '"Documentos vuelo" la del flete) de la carpeta del vuelo, o reenvíalas a facturasbuscaflor@. ' +
    'No volveré a avisarte: te escribiré cuando el inventario esté listo.');
  actualizarVuelo_(hv, fila, awb, estado, '', '', clave);
}
/**
 * Proveedor de una factura o fila tal como sale en el inventario. En un grupo (Grupo Cantiza) es la EMPRESA que emite
 * la factura según el PDF (Cantiza Growers, Valthomig…, por el nombre o por la serie del nº), nunca el remitente del correo.
 */
function provFactura_(f) {
  const p = nombreProveedor_(f.finca);
  return empresaGrupo_(p, f.finca, f.numero || f.factura) || p;
}

/**
 * Final Alert de Logike (Excel): una fila por finca con "Export Name | Product | DAE | HAWB | Temp. | FULL | piezas…".
 * Devuelve { fincas: [{ finca, hawb, piezas }] }. Las piezas son las del cuarto frío si vienen (las que vuelan).
 */
function leerFinalAlert_(texto) {
  const fincas = [];
  String(texto || '').split('\n').forEach(linea => {
    const c = linea.split('|').map(x => x.trim()).filter(x => x);
    const iH = c.findIndex(x => /^[A-Z]{1,3}\d{6,9}$/i.test(x));
    if (iH < 1) return;
    const finca = c.find(x => /[A-Za-z]{3}/.test(x) && !/^(ROSAS|FLORES|CLAVEL|PANICULATA|HYPERICUM)$/i.test(x)) || '';
    if (!finca || /export name|consignee|mawb|hawb/i.test(finca)) return;
    const nums = c.slice(iH + 1).map(x => Number(String(x).replace(',', '.'))).filter(x => !isNaN(x) && x > 0);
    fincas.push({ finca: finca, hawb: c[iH].toUpperCase(), piezas: nums.length ? nums[nums.length - 1] : 0 });
  });
  return { tipo_doc: 'ALERTA', fincas: fincas };
}

/**
 * HAWB de lo que vuela de verdad en un vuelo: la Final Alert si la hay; si no, la Master cuando TODAS sus líneas traen HAWB
 * (la de Saftec sí; la factura comercial de Logike y el CR de K+N no). null si no se sabe.
 */
function hawbsDelVuelo_(mios) {
  const al = mios.filter(d => d.tipo === 'ALERTA' && ((d.data || {}).fincas || []).length);
  if (al.length) {
    const set = {};
    al.forEach(d => d.data.fincas.forEach(f => { const h = normHawb_(f.hawb); if (h.length >= 5) set[h] = true; }));
    return { set: set, fuente: 'Final Alert del transitario' };
  }
  const ms = mios.filter(d => d.tipo === 'MASTER' && ((d.data || {}).fincas || []).length);
  for (const m of ms) {
    const fs = m.data.fincas;
    if (fs.every(f => normHawb_(f.hawb).length >= 5)) {
      const set = {};
      fs.forEach(f => { set[normHawb_(f.hawb)] = true; });
      return { set: set, fuente: 'Master Invoice' };
    }
  }
  return null;
}

/**
 * Total a pagar de una factura de flete. La IA a veces deja en flete_usd SOLO la línea del flete aéreo (Saftec 7489601:
 * 2.507,28 en vez de 2.952,03; Logike LC-17720: 6.088,80 en vez de 6.788,10) y pone el resto en "cargos".
 * Si los cargos no incluyen la línea del flete (AWB / AFR / FREIGHT) y no suman ya el total, el total es flete + cargos.
 */
function totalFactura_(d) {
  const flete = Number((d || {}).flete_usd) || 0;
  const cargos = ((d || {}).cargos || []).filter(c => Number(c.usd) > 0);
  if (!cargos.length) return flete;
  const suma = cargos.reduce((a, c) => a + Number(c.usd), 0);
  if (Math.abs(suma - flete) <= Math.max(1, 0.01 * flete)) return flete;              // los cargos ya son el desglose del total
  const traeFlete = cargos.some(c => /^(AWB|AFR|FRT|FREIGHT|FLETE|AIR)/i.test(String(c.codigo || '')) || Math.abs(Number(c.usd) - flete) < 0.01 * flete);
  if (traeFlete) return Math.max(flete, suma);
  return Math.round((flete + suma) * 100) / 100;
}

function moverFacturaDeVuelo_(id, d, deAwb, aAwb, vuelos) {
  const destino = vuelos.find(v => v.awb === aAwb);
  if (!destino) return;                                                   // el vuelo correcto aún no tiene carpeta
  const file = DriveApp.getFileById(id);
  let sub = null;
  const subs = destino.carpeta.getFolders();
  while (subs.hasNext() && !sub) { const x = subs.next(); if (RX_SUB.FINCAS.test(x.getName())) sub = x; }
  if (!sub) sub = destino.carpeta.createFolder('Facturas fincas');
  file.moveTo(sub);
  // registro (Docs IA): columna AWB y la guía dentro de los datos
  d.awb = aAwb; d.data = Object.assign({}, d.data, { awb: aAwb });
  const sh = hojaDocs_();
  if (sh.getLastRow() > 1) {
    const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) {
      sh.getRange(i + 2, 2).setValue(aAwb);
      let json = JSON.stringify(d.data); if (json.length > 45000) json = json.slice(0, 45000);
      sh.getRange(i + 2, 5).setValue(json);
    }
  }
  // acceso de pago del proveedor: "fecha · AWB <viejo> · Fra N · importe" → con la guía buena
  const ruta = rutaProveedor_((d.data || {}).finca, (d.data || {}).numero);
  const prov = ruta.join(' / ');
  if (prov) ['Pendientes de pago', 'Pagadas'].forEach(cp => {
    try {
      const c = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor'].concat(ruta, [cp]));
      const it = c.getFiles();
      while (it.hasNext()) {
        const x = it.next(), n = x.getName();
        if (n.indexOf(' · AWB ' + deAwb + ' · Fra ' + (d.data.numero || '')) >= 0) x.setName(n.replace(' · AWB ' + deAwb, ' · AWB ' + aAwb));
      }
    } catch (e) { Logger.log('Acceso de pago ' + prov + ': ' + e); }
  });
  Logger.log('Factura ' + (d.data.finca || '') + ' ' + (d.data.numero || '') + ' (HAWB ' + d.data.hawb + '): del vuelo ' + deAwb +
    ' al ' + aAwb + ', que es donde la trae la Master.');
  try {
    MailApp.sendEmail(CONFIG.ALERT_EMAIL, '[Buzón Buscaflor] Factura cambiada de vuelo: ' + (d.data.finca || '') + ' ' + (d.data.numero || ''),
      'La factura ' + (d.data.numero || '') + ' de ' + (d.data.finca || '') + ' decía la guía ' + deAwb + ', pero su HAWB ' + d.data.hawb +
      ' viaja en la Master del vuelo ' + aAwb + '. La he pasado a ese vuelo; los inventarios de los dos vuelos se rehacen solos.');
  } catch (e) {}
}

// ─────────────────────────── Master de Saftec (enlace "Download Farm Invoices") ───────────────────────────
// Saftec no adjunta la Commercial Master Invoice: la deja en https://tracking.saftec.com.ec/attachs/075-6808%201042/inv.pdf
function esVueloSaftec_(carpeta, mios) {
  return /saftec/i.test(carpeta.getName()) ||
    mios.some(d => /saftec/i.test(String((d.data || {}).transitario || '') + ' ' + String(d.nombre || '')));
}

/** Enlaces posibles a la Master: los del correo (también dentro de los enlaces protegidos de Outlook) y el de la guía. */
function urlsMasterSaftec_(awb, texto) {
  const out = [];
  const add = u => { if (!u) return; u = String(u).replace(/&amp;/g, '&').replace(/ /g, '%20'); if (out.indexOf(u) < 0) out.push(u); };
  const t = String(texto || '');
  (t.match(/https?:\/\/tracking\.saftec\.com\.ec\/attachs\/[^"'<>]*?inv\.pdf/gi) || []).forEach(add);
  (t.match(/url=(https?%3A%2F%2Ftracking\.saftec\.com\.ec[^&"'<>]*)/gi) || []).forEach(x => {
    try { const u = decodeURIComponent(x.replace(/^url=/i, '')); if (/inv\.pdf/i.test(u)) add(u); } catch (e) {}
  });
  const d = String(awb || '').replace(/\D/g, '');
  if (d.length === 11) add('https://tracking.saftec.com.ec/attachs/' + d.slice(0, 3) + '-' + d.slice(3, 7) + '%20' + d.slice(7) + '/inv.pdf');
  return out;
}

/** Descarga un PDF; null si no responde o lo que llega no es un PDF. */
function bajarPdf_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const bytes = res.getBlob().getBytes();
    const esPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    if (res.getResponseCode() === 200 && esPdf) return bytes;
    Logger.log('PDF ' + url + ': HTTP ' + res.getResponseCode() + (esPdf ? '' : ' (no es un PDF)'));
  } catch (e) { Logger.log('PDF ' + url + ': ' + e); }
  return null;
}

/** Baja la Master de un vuelo de Saftec a "Documentos vuelo". Como mucho 12 intentos (uno por pasada). */
function bajarMasterSaftecVuelo_(awb, carpeta) {
  const props = PropertiesService.getScriptProperties(), k = 'SAFTEC_MASTER_' + awb;
  const intentos = Number(props.getProperty(k) || 0);
  if (intentos >= 12) return false;
  const nombre = 'MASTER AWB ' + awb + '.pdf';
  const it = carpeta.getFoldersByName('Documentos vuelo');
  const destino = it.hasNext() ? it.next() : carpeta.createFolder('Documentos vuelo');
  if (destino.getFilesByName(nombre).hasNext()) return false;          // ya está: falta leerla o no era la Master
  props.setProperty(k, String(intentos + 1));
  for (const u of urlsMasterSaftec_(awb, '')) {
    const bytes = bajarPdf_(u);
    if (bytes) { destino.createFile(Utilities.newBlob(bytes, 'application/pdf', nombre)); return true; }
  }
  return false;
}

/** A mano: baja ya la Master de Saftec de las guías de la lista (la carpeta del vuelo tiene que existir). */
const AWB_MASTER_SAFTEC = ['075-68081042'];
function bajarMasterSaftec() {
  AWB_MASTER_SAFTEC.forEach(awb => {
    const f = typeof buscarCarpetaAwb_ === 'function' ? buscarCarpetaAwb_(awb) : null;
    if (!f) { Logger.log(awb + ': no encuentro la carpeta del vuelo'); return; }
    PropertiesService.getScriptProperties().deleteProperty('SAFTEC_MASTER_' + awb);
    Logger.log(awb + ': ' + (bajarMasterSaftecVuelo_(awb, f) ? 'Master descargada en Documentos vuelo. Ejecuta revisarVuelos.' : 'no se pudo (mira el registro) o ya estaba.'));
  });
}

function fleteCreible_(usd, kg) { return !kg || (usd / kg >= 0.8 && usd / kg <= 8); }

/**
 * Corrige errores típicos al leer una Master consolidada (p. ej. Ecuador Cargo / Logike):
 *  - la fila de TOTALES o el comprador (ROSAS DE BUSCAFLOR) leídos como si fueran una finca → fuera
 *  - la partida arancelaria (0603…) o el mismo número en todas las filas leído como "factura" → vacío
 *  - los TALLOS leídos en la columna de piezas → se pasan a tallos
 *  - total_piezas con el total de tallos (8625 en vez de 37 cajas) → piezas de la guía o de las facturas
 */
function normalizarMaster_(data, mios) {
  const m = JSON.parse(JSON.stringify(data || {}));
  const filas = (m.fincas || []).filter(f => !/BUSCAFLOR|^\s*TOTAL/i.test(String(f.finca || '')));
  const facts = filas.map(f => String(f.factura || '').trim());
  const repetida = filas.length > 2 && facts.every(x => x && x === facts[0]);
  filas.forEach(f => {
    if (repetida || /^0?603\d/.test(String(f.factura || '').replace(/\s/g, ''))) f.factura = '';
    if (!(Number(f.tallos) > 0) && Number(f.piezas) >= 50) { f.tallos = Number(f.piezas); f.piezas = 0; }
  });
  // Cajas (full) y piezas cruzadas: una finca nunca tiene más cajas full que piezas (las piezas son los bultos; 4 cuartos = 1 full)
  filas.forEach(f => {
    const pz = Number(f.piezas) || 0, fu = Number(f.full) || 0;
    if (pz > 0 && fu > pz) { f.piezas = fu; f.full = pz; }
  });
  if (Number(m.total_full) > Number(m.total_piezas) && Number(m.total_piezas) > 0) { const t = m.total_full; m.total_full = m.total_piezas; m.total_piezas = t; }
  m.fincas = filas;
  const tallosM = filas.reduce((a, f) => a + (Number(f.tallos) || 0), 0);
  const tp = Number(m.total_piezas) || 0;
  // CAJAS DEL VUELO = bultos de la GUÍA (AWB), sea cual sea el tipo de caja (full, half, quarter…). Siempre manda la guía.
  const conPiezas = d => d.tipo === 'GUIA' && Number((d.data || {}).total_piezas) > 0;
  const guia = (mios || []).find(d => conPiezas(d) && /(^|[_ ])AWB[_ ]/i.test(d.nombre || '') && !/DOCAWB/i.test(d.nombre || '')) ||
               (mios || []).find(conPiezas);
  if (guia) { m.total_piezas = Number(guia.data.total_piezas); return m; }
  const piezasFilas = filas.reduce((a, f) => a + (Number(f.piezas) || 0), 0);
  if (tp && tallosM && tp * 50 > tallosM) {            // nadie mete menos de 50 tallos por caja: eso no son cajas
    if (piezasFilas && piezasFilas * 50 <= tallosM) { m.total_piezas = piezasFilas; return m; }
    const facturas = (mios || []).filter(d => d.tipo === 'FINCA').reduce((a, d) => a + (Number((d.data || {}).piezas) || 0), 0);
    m.total_piezas = guia ? Number(guia.data.total_piezas) : (facturas || 0);
  }
  return m;
}

/**
 * Variedades escritas de forma distinta por cada finca (BRIGTHON / BRIGHTON, CANDELIGHT / CANDLELIGHT):
 * se unifican con la forma más usada (en este vuelo y en vuelos anteriores) para que el stock no se parta.
 * Solo nombres de 6+ letras que se diferencian en UNA letra (o dos letras cambiadas de orden).
 */
function variedadesCanonicas_(fincas, precios, avisos) {
  const peso = {};
  Object.keys(precios || {}).forEach(k => { const v = k.split('|')[1]; if (v) peso[v] = (peso[v] || 0) + 1000; });
  fincas.forEach(f => (f.lineas || []).forEach(l => {
    const v = limpiarClave_(l.variedad);
    if (v) peso[v] = (peso[v] || 0) + Number(l.paquetes || 0) * Number(l.tallos_paquete || 1);
  }));
  const nombres = Object.keys(peso), cache = {};
  return (tipo, v) => {
    if (!v || v.length < 6) return v;
    if (cache[v] !== undefined) return cache[v];
    let mejor = v;
    nombres.forEach(n => {
      if (n !== v && n.length >= 6 && peso[n] > peso[mejor] && distancia_(n, v) <= 1) mejor = n;
    });
    if (mejor !== v) avisos.push('Variedad "' + v + '" unificada como "' + mejor + '".');
    return (cache[v] = mejor);
  };
}

/** Distancia de edición (para nombres mal leídos: AGRINGA ≈ AGRINAG, NATURFLOR ≈ NATUFLOR) */
function distancia_(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // letras cambiadas de orden
  }
  return d[a.length][b.length];
}

function ponerTransitarioCarpeta_(carpeta, awb, mios) {
  if (carpeta.getName() !== 'AWB ' + awb) return;                      // ya lo tiene (o lo has renombrado tú)
  const conocidos = ['Kuehne+Nagel', 'Saftec', 'Logike'];
  const orden = ['MASTER', 'FLETE', 'PREALERT', 'GUIA'];
  for (const t of orden) {
    for (const d of mios.filter(x => x.tipo === t)) {
      const n = nombreTransitario_((d.data || {}).transitario);
      if (conocidos.indexOf(n) >= 0) { carpeta.setName('AWB ' + awb + ' · ' + n); return; }
    }
  }
}

function claveNombre_(s) {
  const w = String(s || '').toUpperCase().replace(/[^A-ZÑ ]/g, ' ').split(/\s+/).filter(x => x && !PALABRAS_GENERICAS.test(x));
  return w[0] || '';
}
function corto_(s) {
  const k = claveNombre_(s);
  return k ? k.charAt(0) + k.slice(1).toLowerCase() : String(s || '');
}
function casa_(mf, f) {
  const d = x => String(x || '').replace(/\D/g, '');
  const hm = normHawb_(mf.hawb), hf = normHawb_(f.hawb);
  if (hm.length >= 5 && hf.length >= 5) return hm === hf;        // con HAWB en los dos, manda el HAWB
  if (mf.hawb && f.hawb && String(mf.hawb).toUpperCase() === String(f.hawb).toUpperCase()) return true;
  if (mf.factura && f.numero && d(f.numero).length >= 4 && (d(mf.factura).indexOf(d(f.numero)) >= 0 || d(f.numero).indexOf(d(mf.factura)) >= 0)) return true;
  return Number(mf.tallos) > 0 && Number(mf.tallos) === Number(f.tallos) && Math.abs(Number(mf.usd) - Number(f.total_usd)) <= Math.max(1, 0.02 * Number(mf.usd));
}
/** Líneas de la Master agrupadas por proveedor, con las facturas que les corresponden */
function gruposMaster_(m, fincas) {
  const g = {};
  (m.fincas || []).forEach(mf => {
    const prov = nombreProveedor_(mf.finca);
    const x = g[prov] || (g[prov] = { prov: prov, T: 0, U: 0, lineas: [] });
    x.T += Number(mf.tallos) || 0; x.U += Number(mf.usd) || 0; x.lineas.push(mf);
  });
  return Object.values(g).map(x => {
    x.suyas = fincas.filter(f => nombreProveedor_(f.finca) === x.prov || x.lineas.some(mf => casa_(mf, f) || mismaFinca_(mf.finca, f.finca)));
    return x;
  });
}

/**
 * Antes de calcular el inventario:
 *  1) Cargos sueltos en una factura (1-2 "tallos" con importe ≥ 5 USD, p. ej. cajas o gastos): no son flor,
 *     se quitan del stock y su importe se reparte entre los tallos de esa factura.
 *  2) Si el IMPORTE de un proveedor cuadra con la Master pero los TALLOS no, se corrigen los tallos con la Master.
 */
function prepararFincas_(m, fincas) {
  const out = [];
  const st = l => Number(l.paquetes || 0) * Number(l.tallos_paquete || 1);
  const tallos = f => (f.lineas || []).reduce((a, l) => a + st(l), 0);
  fincas.forEach(f => {
    const cargos = (f.lineas || []).filter(l => st(l) > 0 && st(l) <= 2 && st(l) * Number(l.usd_tallo || 0) >= 5);
    if (!cargos.length) return;
    const imp = cargos.reduce((a, l) => a + st(l) * Number(l.usd_tallo || 0), 0);
    f.lineas = f.lineas.filter(l => cargos.indexOf(l) < 0);
    const s = tallos(f);
    if (s > 0) f.lineas.forEach(l => { l.usd_tallo = Number(l.usd_tallo || 0) + imp / s; });
    out.push(nombreProveedor_(f.finca) + ' ' + (f.numero || '') + ': cargo de ' + imp.toFixed(2) + ' USD (' +
      cargos.map(l => l.variedad).join(', ') + ') repartido en sus ' + s + ' tallos, no se cuenta como stock.');
  });
  gruposMaster_(m, fincas).forEach(gm => {
    const t = gm.suyas.reduce((a, f) => a + tallos(f), 0);
    const u = gm.suyas.reduce((a, f) => a + Number(f.total_usd || 0), 0);
    // Si las líneas de la factura ya suman los tallos que la propia factura declara, la factura manda:
    // el error está en la lectura de la Master, no se toca el stock (solo se avisa).
    const declarados = gm.suyas.reduce((a, f) => a + (Number(f.tallos) || 0), 0);
    if (gm.T && t && declarados && Math.abs(t - declarados) <= 0.01 * declarados) {
      if (Math.abs(t - gm.T) > 0.01 * gm.T) out.push(gm.prov + ': la Master dice ' + gm.T + ' tallos y la factura ' + t + '; se usa la factura.');
      return;
    }
    if (gm.T && gm.U && t && Math.abs(u - gm.U) <= Math.max(0.5, 0.01 * gm.U) && Math.abs(t - gm.T) > 0.01 * gm.T) {
      const k = gm.T / t;
      gm.suyas.forEach(f => (f.lineas || []).forEach(l => {
        l.paquetes = Math.round(Number(l.paquetes || 0) * k * 100) / 100;
        l.usd_tallo = Number(l.usd_tallo || 0) / k;
      }));
      out.push(gm.prov + ': tallos corregidos con la Master (' + t + ' → ' + gm.T + '); comprueba la factura.');
    }
  });
  return out;
}

function mismaFinca_(a, b) {
  // mismo grupo pero distinta empresa (Cantiza Growers ≠ Valthomig): no es la misma finca
  const ea = empresaGrupo_(nombreProveedor_(a), a, ''), eb = empresaGrupo_(nombreProveedor_(b), b, '');
  if (ea && eb && ea !== eb) return false;
  const ka = claveNombre_(a), kb = claveNombre_(b);
  if ((ka && ka === kb) || nombreProveedor_(a) === nombreProveedor_(b)) return true;   // nombre o alias (Singha = The Farm Direct…)
  // palabras pegadas en la Master ("MONTEROSASLIMITADA C.L." = Monterosas): una clave empieza por la otra
  if (ka.length >= 6 && kb.length >= 6 && (ka.indexOf(kb) === 0 || kb.indexOf(ka) === 0)) return true;
  // nombre mal leído por la IA (una o dos letras cambiadas) en nombres de 6 letras o más
  return ka.length >= 6 && kb.length >= 6 && distancia_(ka, kb) <= 2;
}
function cubierta_(mf, fincas) {
  if (fincas.some(f => casa_(mf, f))) return true;
  // varias facturas de la misma finca (p. ej. Valthomig ×2, Invos ×2): cuadran por tallos o por importe
  const hm = normHawb_(mf.hawb);
  const suyas = fincas.filter(f => mismaFinca_(mf.finca, f.finca) && !(hm.length >= 5 && normHawb_(f.hawb).length >= 5 && normHawb_(f.hawb) !== hm));
  if (!suyas.length) return false;
  const tallos = suyas.reduce((a, f) => a + Number(f.tallos || 0), 0);
  const usd = suyas.reduce((a, f) => a + Number(f.total_usd || 0), 0);
  const T = Number(mf.tallos) || 0, U = Number(mf.usd) || 0;
  return (T > 0 && Math.abs(tallos - T) <= 0.01 * T) || (U > 0 && Math.abs(usd - U) <= Math.max(1, 0.03 * U));
}

function pais_(m) { return (m.pais === 'CO' || /kuehne|k\+n/i.test(m.transitario || '')) ? 'COL' : 'ECU'; }
function borrarDoc_(id) {
  const sh = hojaDocs_();
  for (let i = sh.getLastRow(); i >= 2; i--) if (sh.getRange(i, 1).getValue() === id) sh.deleteRow(i);
}

function crearInventario_(awb, carpeta, semana, m, fincas, fleteUsd, origenFlete, estado, pesos, kgGuia, guia, parcial) {
  const avisosPrevios = prepararFincas_(m, fincas);      // cargos sueltos y tallos corregidos con la Master, ANTES de calcular
  const pais = (m.pais === 'CO' || /kuehne|k\+n/i.test(m.transitario || '')) ? 'COL' : 'ECU';
  const tallosF = f => (f.lineas || []).reduce((b, l) => b + Number(l.paquetes || 0) * Number(l.tallos_paquete || 1), 0);
  const tallosTot = fincas.reduce((a, f) => a + tallosF(f), 0);
  // Con facturas que faltan (provisional), el flete y Vallinoto se reparten entre los tallos de TODO el vuelo
  const tallosRef = tallosTot + (parcial ? Number(parcial.tallosFaltan) || 0 : 0);
  const piezas = Number(m.total_piezas) || fincas.reduce((a, f) => a + Number(f.piezas || 0), 0);
  const palets = Math.ceil(piezas / VUELOS.CAJAS_PALET[pais]);
  const vallEur = VUELOS.GASTOS_VALLINOTO + VUELOS.VALLINOTO_CAJA * piezas;   // Vallinoto estimado del vuelo
  const vall = palets * VUELOS.PALET_EUR + vallEur;
  const vlT = vall / tallosRef;                                   // Vallinoto + palet (lo que suma al coste)
  const vaT = vallEur / tallosRef;                                // solo Vallinoto (despacho, entrega, THC, paletización)
  const paT = palets * VUELOS.PALET_EUR / tallosRef;              // solo palet Madrid → Sevilla (Brivio)
  const fleteEur = fleteUsd / VUELOS.FX;
  const avisos = avisosPrevios.slice();
  if (parcial && parcial.nota) avisos.unshift(parcial.nota);
  revisarGuia_(pais, guia, fleteUsd).forEach(a => avisos.push(a));

  // Flete por tallo de cada finca, repartido por kg: Colombia con el recibo de bodega; Ecuador con los kg de cada finca
  // en la Commercial Master Invoice (Javier, 01-11 y 11-11-2026). Si falta el peso de alguna finca, plano por tallo y aviso.
  let fuentePesos = (pesos && pesos.fincas && pesos.fincas.length) ? pesos.fincas : (m.fincas || []);
  let kgTot = fuentePesos.reduce((a, x) => a + Number(x.kg || 0), 0);
  const porPeso = pais === 'COL' || kgTot > 0;
  if (pais === 'COL' && kgTot && kgGuia && Math.abs(kgTot - kgGuia) / kgGuia > 0.05) {
    avisos.push('Los pesos del recibo de bodega suman ' + Math.round(kgTot) + ' kg y la guía ' + kgGuia +
      ' kg: no se ha podido repartir el flete por kg (se reparte por cajas full del Consolidation Report o, si no las hay, por tallo). Revisa el recibo de bodega.');
    kgTot = 0;
  }
  // Colombia sin recibo de bodega (o con uno que no cuadra): se reparte por CAJAS (full) de cada finca según el
  // Consolidation Report, que es como lo calcula K+N (peso medio por caja full de la guía).
  let porCajas = false;
  if (pais === 'COL' && !kgTot) {
    const cajas = (m.fincas || []).map(x => Object.assign({}, x, { kg: Number(x.full) || 0 }));
    const tot = cajas.reduce((a, x) => a + x.kg, 0);
    if (tot > 0) { fuentePesos = cajas; kgTot = tot; porCajas = true; }
  }
  // Filas del recibo (o de la Master) que son de una factura: por HAWB, nombre o alias (Invos = Aguata + Success…)
  // 1º por HAWB (si la fila lo trae o se lo ha puesto la Final Alert); 2º por nombre/alias, sin tocar filas con OTRO HAWB.
  const filasDe = f => {
    const h = normHawb_(f.hawb);
    if (h.length >= 5) {
      const porH = fuentePesos.filter(x => normHawb_(x.hawb) === h);
      if (porH.length) return { ps: porH, soloEsta: true };
    }
    const prov = provFactura_(f), k = claveNombre_(f.finca);
    const otroHawb = x => h.length >= 5 && normHawb_(x.hawb).length >= 5 && normHawb_(x.hawb) !== h;
    let ps = fuentePesos.filter(x => !otroHawb(x) && (casa_(x, f) || provFactura_(x) === prov || (k && claveNombre_(x.finca) === k && !empresaGrupo_(nombreProveedor_(x.finca), x.finca, ''))));
    let soloEsta = false;
    if (!ps.length) {           // último recurso: nº de piezas único
      const c = fuentePesos.filter(x => Number(x.piezas) > 0 && Number(x.piezas) === Number(f.piezas));
      if (c.length === 1) { ps = c; soloEsta = true; }
    }
    return { ps, soloEsta };
  };
  // Peso que no es de ninguna factura (una finca del recibo con otro nombre, p. ej. "Flores Milonga"): su flete no se
  // pierde, se reparte entre todas en proporción a su peso. Queda el aviso para añadir el alias.
  if (pais === 'ECU' && !kgTot) avisos.push('Flete repartido por tallo (no por peso): ' + (m.sin_master ? 'no hay Master Invoice.' : 'la Master no trae el peso de cada finca.'));
  if (pais === 'ECU' && kgTot) {
    const sinKg = fincas.filter(f => !filasDe(f).ps.reduce((a, x) => a + Number(x.kg || 0), 0));
    if (sinKg.length) {
      avisos.push('Flete repartido por tallo (no por peso): la Master no trae el peso de ' +
        sinKg.map(f => f.finca).filter((x, i, a) => a.indexOf(x) === i).join(', ') + '. Revisa la Master o añade el alias en "Alias fincas".');
      kgTot = 0;
    }
  }
  if (porPeso && kgTot) {
    const usadas = new Set();
    fincas.forEach(f => filasDe(f).ps.forEach(x => usadas.add(x)));
    const sueltas = fuentePesos.filter(x => !usadas.has(x) && Number(x.kg) > 0);
    const kgUsado = fuentePesos.filter(x => usadas.has(x)).reduce((a, x) => a + Number(x.kg || 0), 0);
    if (sueltas.length && kgUsado > 0 && !parcial) {          // con facturas que faltan, su peso es el de ellas: no se reparte
      avisos.push('Flete: ' + sueltas.map(x => x.finca + ' (' + x.kg + ' kg)').join(', ') + ' no casa con ninguna factura; ' +
        'su parte se reparte entre todas. Si es de una finca conocida, añade el alias en "Alias fincas".');
      kgTot = kgUsado;
    }
  }
  // Cada fila de peso (finca de la Master / recibo / DIM) se reparte UNA sola vez entre TODAS las facturas que caen en ella,
  // en proporción a sus tallos. Antes, si una finca mandaba dos facturas con el mismo HAWB (Natuflor/Agrinag 90647 y 80156
  // en la 075-69146965), cada factura se llevaba los kg enteros de la fila y el flete se contaba dos veces.
  const filasPorFactura = new Map(), tallosFila = new Map();
  fincas.forEach(f => {
    const ps = filasDe(f).ps;
    filasPorFactura.set(f, ps);
    ps.forEach(x => tallosFila.set(x, (tallosFila.get(x) || 0) + tallosF(f)));
  });
  const fleteTallo = f => {
    if (!porPeso || !kgTot) return fleteEur / tallosRef;
    const ps = filasPorFactura.get(f) || filasDe(f).ps;
    // €/tallo de la factura = Σ (flete de cada fila ÷ tallos de todas las facturas de esa fila)
    let eurTallo = 0;
    ps.forEach(x => { const t = tallosFila.get(x) || tallosF(f); if (Number(x.kg) > 0 && t > 0) eurTallo += fleteEur * Number(x.kg) / kgTot / t; });
    return eurTallo > 0 ? eurTallo : fleteEur / tallosRef;
  };

  // Agrupación STOCK: tipo + variedad + medida
  const grupos = {};
  const precios = cargarPrecios_();
  const bm = { santos: { FANCY: 0, SELECT: 0, DESBOTONADO: 0 }, fija: 0, preciosFija: {} };   // clavel de Benchmark: Santos / orden fija
  const canon = variedadesCanonicas_(fincas, precios, avisos);
  fincas.forEach(f => (f.lineas || []).forEach(l => {
    const tipo = String(l.tipo || 'ROSAS').toUpperCase();
    const variedadFactura = canon(tipo, limpiarClave_(l.variedad));
    let variedad = variedadFactura;
    let medida = limpiarClave_(String(l.medida || '').replace(/\s*CM\s*$/i, '')) || (tipo === 'ROSAS' ? '?' : '-');
    // Alstroemeria y clavel: el GRADO (Fancy, Select, Super, Perfection) va en la columna MEDIDA y sale del nombre
    // ("FANCY WHITE" → White · Fancy; "PINK SELECT" → Pink · Select)
    if (tipo === 'ALSTROEMERIA' || tipo === 'CLAVEL') {
      const gr = gradoDe_(variedadFactura);
      if (gr.grado && gr.resto) { variedad = gr.resto; medida = gr.grado; }
    }
    const st = Number(l.paquetes || 0) * Number(l.tallos_paquete || 1), usd = Number(l.usd_tallo || 0);
    if (tipo === 'CLAVEL' && /BENCHMARK/i.test(String(f.finca || ''))) clavelBenchmark_(bm, variedadFactura, st, usd, f.numero, avisos);
    // Clavel e hortensia se venden por TALLO (la hortensia viene en cajas "QBx25", pero no en ramos)
    const tp = VUELOS.POR_TALLO.indexOf(tipo) >= 0 ? 1 : (VUELOS.UNIDAD[tipo] || Number(l.tallos_paquete || 1));
    const k = tipo + '|' + variedad + '|' + medida;
    const g = grupos[k] || (grupos[k] = { tipo, variedad, medida, tp, paq: 0, st: 0, fob: 0, fl: 0, prov: [] });
    g.paq += st / tp; g.st += st; g.fob += st * usd / VUELOS.FX; g.fl += st * fleteTallo(f);
    const pv = provFactura_(f); if (g.prov.indexOf(pv) < 0) g.prov.push(pv);
    // aviso de precio respecto al último vuelo de esa finca
    const kp = claveNombre_(f.finca) + '|' + variedad + '|' + medida, ant = precios[kp];
    if (ant && ant.awb !== awb && ant.usd > 0 && Math.abs(usd - ant.usd) / ant.usd > VUELOS.AVISO_PRECIO) {
      avisos.push(pv + ' ' + variedad + ' ' + medida + ': ' + ant.usd.toFixed(2) + ' → ' + usd.toFixed(2) + ' USD/tallo (' +
        (usd > ant.usd ? '+' : '') + Math.round((usd - ant.usd) / ant.usd * 100) + ' %, antes en AWB ' + ant.awb + ')');
    }
    if (estado === 'DEFINITIVO') precios[kp] = { usd: usd, awb: awb };
  }));
  if (estado === 'DEFINITIVO') guardarPrecios_(precios);

  // Hoja de Google en la carpeta del AWB
  // Se construye en una hoja temporal y se guarda como EXCEL (.xlsx) en la carpeta del AWB
  const nombre = 'INVENTARIO AWB ' + awb;
  // Hojas temporales que hayan quedado de una pasada que se cortó: fuera antes de crear otra
  try {
    const viejas = DriveApp.getFilesByName(nombre + ' (temporal)');
    while (viejas.hasNext()) { try { viejas.next().setTrashed(true); } catch (e) {} }
  } catch (e) {}
  const ss = SpreadsheetApp.create(nombre + ' (temporal)');
  try {                                                       // la hoja temporal se borra SIEMPRE, aunque algo falle
  const sh = ss.getSheets()[0];
  sh.setName('Stock');

  const r4 = x => Math.round(x * 10000) / 10000;
  const es = (x, d) => x.toFixed(d).replace('.', ',');
  sh.getRange('A1:L1').merge().setValue((estado === 'PROVISIONAL' ? 'PROVISIONAL · ' : '') + 'INVENTARIO STOCK · AWB ' + awb + ' · ' +
      (pais === 'COL' ? 'COLOMBIA' : 'ECUADOR') + ' (' + String(m.transitario || '').toUpperCase() + ') · ' + piezas + ' CAJAS · ' + semana + ' · EUR/USD ' + VUELOS.FX.toFixed(4).replace('.', ','))
    .setFontWeight('bold').setFontSize(11).setFontFamily('Arial');
  // Los inventarios de vuelo (Ecuador y Colombia) llevan los colores de la plantilla: título y secciones en verde, cabeceras en gris
  const color = true;
  if (color) sh.getRange('A1:L1').setBackground('#1A3A2A').setFontColor('#FFFFFF');
  else sh.getRange('A1:L1').setBorder(null, null, true, null, null, null);
  // Fila 2: datos editables. Si cambias PALETS (o €/palet, Vallinoto), todas las filas se recalculan solas.
  sh.getRange('A2:J2').setValues([['PALETS', palets, '€/PALET', VUELOS.PALET_EUR, 'VALLINOTO €', vallEur, 'TALLOS VUELO', Math.round(tallosRef), '', '← cambia los palets definitivos y se recalcula']])
    .setFontSize(9).setFontFamily('Arial');
  sh.getRange('A2').setFontWeight('bold'); sh.getRange('C2').setFontWeight('bold'); sh.getRange('E2').setFontWeight('bold'); sh.getRange('G2').setFontWeight('bold');
  sh.getRange('B2').setFontWeight('bold').setFontSize(11).setBorder(true, true, true, true, false, false, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM).setHorizontalAlignment('center');
  sh.getRange('D2').setNumberFormat('0.00').setBorder(true, true, true, true, false, false);
  sh.getRange('F2').setNumberFormat('0.00').setBorder(true, true, true, true, false, false);
  sh.getRange('J2').setFontStyle('italic').setFontSize(8);
  let r = 3;
  const orden = ['ROSAS', 'PANICULATA', 'ALSTROEMERIA', 'CLAVEL', 'HORTENSIAS'];
  const tipos = [...new Set(Object.values(grupos).map(g => g.tipo))].sort((a, b) => (orden.indexOf(a) + 99) % 99 - (orden.indexOf(b) + 99) % 99);
  const NC = 10 + VUELOS.MARGENES.length;   // columnas de la tabla
  tipos.forEach(t => {
    const items = Object.values(grupos).filter(g => g.tipo === t).sort((a, b) =>
      a.variedad.localeCompare(b.variedad) || (Number(b.medida) || 0) - (Number(a.medida) || 0));
    // tallos por ramo del grupo = el más habitual (por tallos), para que una línea rara no cambie la cabecera
    const pesoTp = {};
    items.forEach(g => { pesoTp[g.tp] = (pesoTp[g.tp] || 0) + g.st; });
    const tp = Number(Object.keys(pesoTp).sort((a, b) => pesoTp[b] - pesoTp[a])[0]) || 1;
    const porTallo = tp === 1, u = porTallo ? 'TALLO' : 'PAQ';
    sh.getRange(r, 1, 1, NC).setFontWeight('bold').setFontFamily('Arial');
    if (color) sh.getRange(r, 1, 1, NC).setBackground('#2D5A3D').setFontColor('#FFFFFF');
    else sh.getRange(r, 1, 1, NC).setBorder(true, true, true, true, false, false);
    sh.getRange(r, 1).setValue(t); r++;
    const uu = porTallo ? '€/tallo' : '€/paq';
    sh.getRange(r, 1, 1, NC).setValues([['TIPO', 'VARIEDAD', 'MEDIDA', porTallo ? 'TALLOS' : 'PAQ x' + tp, 'PROVEEDOR',
      'FOB', 'FLETE', 'VALLINOTO', 'PALET', 'COSTE ' + uu].concat(VUELOS.MARGENES.map(x => 'VENTA ' + Math.round(x * 100) + '% ' + uu))])
      .setFontWeight('bold').setFontSize(9).setFontFamily('Arial').setWrap(false)
      .setHorizontalAlignment('center').setBorder(true, true, true, true, true, true);
    if (color) sh.getRange(r, 1, 1, NC).setBackground('#EFEFEF');
    r++;
    const vals = items.map(g => {
      const fob = g.fob / g.st, fl = g.fl / g.st;
      const coste = (fob + fl + vlT) * tp;
      return [t, titulo_(g.variedad), g.medida, porTallo ? g.st : Math.round(g.st / tp * 100) / 100, g.prov.map(titulo_).join(', '), fob, fl, vaT, paT, coste]
        .concat(VUELOS.MARGENES.map(x => coste / (1 - x)));   // precio de venta para ganar ese margen sobre la venta
    });
    sh.getRange(r, 1, vals.length, NC).setValues(vals).setFontSize(9).setFontFamily('Arial').setBorder(true, true, true, true, true, true);
    // Vallinoto, palet, coste y precio con FÓRMULAS que dependen de la fila 2 (palets definitivos editables)
    sh.getRange(r, 8, vals.length, NC - 7).setFormulas(vals.map((_, i) => {
      const f = r + i;
      // sin redondeos: el Excel guarda el valor exacto y solo lo MUESTRA con 4 / 2 decimales
      return ['=$F$2/$H$2', '=$B$2*$D$2/$H$2', '=(F' + f + '+G' + f + '+H' + f + '+I' + f + ')*' + tp]
        .concat(VUELOS.MARGENES.map(x => '=J' + f + '*100/' + Math.round((1 - x) * 100)));   // solo enteros: el visor del móvil falla con decimales
    }));
    sh.getRange(r, 6, vals.length, 5).setNumberFormat('0.0000');
    sh.getRange(r, 11, vals.length, NC - 10).setNumberFormat('0.00').setFontWeight('bold');
    r += vals.length;
  });

  fincas.forEach(f => { if (f._aviso) avisos.push(f._aviso); });
  // tallos de cada proveedor: facturas frente a la Master / CR (agrupado: Floranrosa con 2 HAWB, Invos con 2 cultivos…)
  gruposMaster_(m, fincas).forEach(gm => {
    const t = gm.suyas.reduce((a, f) => a + tallosF(f), 0);
    if (gm.T && gm.suyas.length && Math.abs(t - gm.T) > 0.01 * gm.T) avisos.push(gm.prov + ': las facturas suman ' + t + ' tallos y la Master dice ' + gm.T);
    if (!gm.suyas.length) avisos.push(gm.prov + ': está en la Master y no se ha encontrado su factura');
  });
  const fobUsd = fincas.reduce((a, f) => a + Number(f.total_usd || 0), 0);
  const fobMaster = (m.fincas || []).reduce((a, x) => a + Number(x.usd || 0), 0);
  if (Math.abs(fobUsd - fobMaster) > 0.5) avisos.push('FOB facturas ' + fobUsd.toFixed(2) + ' USD ≠ Master ' + fobMaster.toFixed(2) + ' USD (diferencia ' + (fobUsd - fobMaster).toFixed(2) + ')');
  if (Object.values(grupos).some(g => g.medida === '?')) avisos.push('Hay rosas sin medida en la factura (marcadas "?"): complétalas.');
  const notas = [
    'Importes por tallo; FOB medio ponderado por tallos cuando hay varios proveedores.',
    'FOB, flete, Vallinoto y palet en €/tallo. Venta X% = precio para ganar ese margen sobre la venta: ' + VUELOS.MARGENES.map(x => Math.round(x * 100) + '% = coste ÷ ' + String(Math.round((1 - x) * 100) / 100).replace('.', ',')).join('; ') + ' (sin IVA).',
    'Flete aéreo ' + es(fleteUsd, 2) + ' USD (' + origenFlete + ') / ' + String(VUELOS.FX).replace('.', ',') + ' = ' + es(fleteEur, 2) + ' EUR' +
      (porPeso && kgTot ? (porCajas ? ', repartido por cajas (full) de cada finca según el Consolidation Report.' : ', repartido por kg de cada finca' + (pais === 'ECU' ? ' (Master Invoice, ' + es(kgTot, 0) + ' kg).' : '.')) : ' ÷ ' + tallosTot + ' tallos = ' + es(fleteEur / tallosTot, 4) + ' €/tallo.'),
  ].concat(notaBenchmark_(bm)).concat(kgGuia ? ['Flete todo incluido: ' + es(fleteUsd / kgGuia, 2) + ' USD/kg (' + es(kgGuia, 0) + ' kg tasables).'] : []).concat([
    'Vallinoto (estimado): ' + VUELOS.GASTOS_VALLINOTO + ' € + ' + es(VUELOS.VALLINOTO_CAJA, 2) + ' € × ' + piezas + ' cajas = ' + es(vallEur, 2) + ' EUR ÷ ' + Math.round(tallosRef) +
      ' tallos = ' + es(vaT, 4) + ' €/tallo. Cuando llegue la factura de Vallinoto, puedes poner el importe real en F2 (sin el IVA de aduana).',
    'Palet Brivio (Madrid → Sevilla): ' + piezas + ' cajas ÷ ' + VUELOS.CAJAS_PALET[pais] + ' = ' + palets + ' palet(es) × ' + es(VUELOS.PALET_EUR, 2) + ' € = ' +
      es(palets * VUELOS.PALET_EUR, 2) + ' EUR ÷ ' + tallosTot + ' tallos = ' + es(paT, 4) + ' €/tallo.',
    'FOB facturas ' + es(fobUsd, 2) + ' USD (' + es(fobUsd / VUELOS.FX, 2) + ' EUR) · Master ' + es(fobMaster, 2) + ' USD. Fincas: ' +
      fincas.map(f => corto_(f.finca) + ' ' + (f.numero || '')).join(', ') + '.'
  ]).concat(m.sin_master ? ['Sin Master Invoice: las facturas de fincas suman las ' + piezas + ' cajas de la guía; cuando llegue la Master se rehace.'] : [])
    .concat(avisos.map(a => 'REVISAR: ' + a));
  r++;
  notas.forEach(n => { sh.getRange(r, 1).setValue(n).setFontSize(8).setFontFamily('Arial'); r++; });
  [16, 20, 9, 9, 26, 9, 9, 11, 9, 13].concat(VUELOS.MARGENES.map(() => 14)).forEach((w, i) => sh.setColumnWidth(i + 1, w * 7));
  SpreadsheetApp.flush();
  const xlsx = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  }).getBlob().setName(nombre + '.xlsx');
  // Sustituye la versión anterior. Si es de otra cuenta (p. ej. la subiste tú), no se puede borrar: se aparta con otro nombre.
  const prev = carpeta.getFilesByName(nombre + '.xlsx');
  while (prev.hasNext()) {
    const p = prev.next();
    try { p.setTrashed(true); }
    catch (e) {
      try { p.setName(nombre + ' (anterior ' + fmt_(new Date(), 'dd-MM HH.mm') + ').xlsx'); }
      catch (e2) { Logger.log('No se pudo apartar ' + p.getName() + ': ' + e2); }
    }
  }
  const f = carpeta.createFile(xlsx);
  return { url: f.getUrl(), avisos: avisos };
  } finally {
    try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) { Logger.log('Hoja temporal sin borrar: ' + e); }
  }
}

/** UNA VEZ: manda a la papelera las hojas "INVENTARIO AWB … (temporal)" que hayan quedado de pasadas cortadas. */
function limpiarTemporales() {
  const it = DriveApp.searchFiles("title contains '(temporal)' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false");
  let n = 0;
  while (it.hasNext()) {
    const f = it.next();
    if (!/^INVENTARIO AWB .*\(temporal\)/.test(f.getName())) continue;
    try { f.setTrashed(true); n++; } catch (e) { Logger.log('No se pudo borrar ' + f.getName() + ': ' + e); }
  }
  Logger.log('Hojas temporales a la papelera: ' + n);
}

/**
 * Clavel de Benchmark, línea a línea: SANTOS si va a precio de campaña (fancy 0,20 · select 0,21 · desbotonados 0,30 USD);
 * a cualquier otro precio es ORDEN FIJA. Avisa si una línea se factura por encima del precio cerrado de su tipo.
 */
/** Grado de alstroemeria / clavel en el nombre de la variedad → { grado: 'Fancy'|'Select'|'Super'|'Perfection'|'', resto } */
function gradoDe_(v) {
  const s = String(v || '').toUpperCase();
  const G = [[/\bSUPER\s*-?\s*SELECT\b|\bSUPERSELECT\b|\bSUPER\b/, 'Super'], [/\bPERFECTION\b|\bPERF\b/, 'Perfection'],
             [/\bFANCY\b|\bFCY\b/, 'Fancy'], [/\bSELECT\b|\bSEL\b/, 'Select']];
  for (const [rx, grado] of G) {
    if (rx.test(s)) return { grado, resto: s.replace(rx, ' ').replace(/^[\s-]+|[\s-]+$/g, '').replace(/\s+/g, ' ').trim() };
  }
  return { grado: '', resto: s };
}

function clavelBenchmark_(bm, variedad, tallos, usd, numero, avisos) {
  const P = VUELOS.BENCHMARK_SANTOS, v = String(variedad || '').toUpperCase(), igual = (a, b) => Math.abs(a - b) < 0.0006;
  const clase = /DESBOT|DISBUD/.test(v) ? 'DESBOTONADO' : /SELECT|\bSEL\b/.test(v) ? 'SELECT' : /FANCY|FCY/.test(v) ? 'FANCY' : '';
  const campana = Object.keys(P).filter(k => igual(usd, P[k]));
  if (campana.length) {
    bm.santos[clase && campana.indexOf(clase) >= 0 ? clase : campana[0]] += tallos;
  } else {
    bm.fija += tallos;
    bm.preciosFija[usd.toFixed(3)] = true;
  }
  const tope = clase ? P[clase] : P.SELECT;
  if (usd > tope + 0.0006 && !(campana.length && !clase)) {
    const a = 'Clavel Benchmark ' + variedad + ' a ' + usd.toFixed(3).replace('.', ',') + ' USD/tallo: por encima del precio cerrado (' +
      (clase ? clase.toLowerCase() + ' ' : '') + String(tope.toFixed(2)).replace('.', ',') + ' USD). Factura ' + (numero || '?') + '.';
    if (avisos.indexOf(a) < 0) avisos.push(a);
  }
}
function notaBenchmark_(bm) {
  const S = bm.santos, totalSantos = S.FANCY + S.SELECT + S.DESBOTONADO;
  if (!totalSantos && !bm.fija) return [];
  const P = VUELOS.BENCHMARK_SANTOS, n = x => String(x.toFixed(2)).replace('.', ',');
  const partes = [];
  if (S.FANCY) partes.push('fancy ' + S.FANCY + ' a ' + n(P.FANCY));
  if (S.SELECT) partes.push('select ' + S.SELECT + ' a ' + n(P.SELECT));
  if (S.DESBOTONADO) partes.push('desbotonados ' + S.DESBOTONADO + ' a ' + n(P.DESBOTONADO));
  const pf = Object.keys(bm.preciosFija).sort().map(x => x.replace('.', ',').replace(/0$/, ''));
  return ['Clavel Benchmark — SANTOS: ' + totalSantos + ' tallos' + (partes.length ? ' (' + partes.join(' · ') + ' USD)' : '') +
    ' · ORDEN FIJA: ' + bm.fija + ' tallos' + (pf.length ? ' (a ' + pf.join(' / ') + ' USD; no resta del pedido de Santos)' : '') + '.'];
}

/** "PINK X-PRESSION" → "Pink X-Pression" · "Benchmark Growers" se queda igual (formato Título en VARIEDAD y PROVEEDOR) */
function titulo_(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s\-(,])([a-záéíóúüñ])/g, (m, a, b) => a + b.toUpperCase());
}

/**
 * Comprueba la guía aérea contra lo pactado y devuelve los avisos para el inventario.
 *  · Colombia (K+N): tarifa 1,37 / 1,41 USD/kg + recargo Santos según la fecha del vuelo; FEC 0,24 USD/kg; MCC 25, MAA 30, CHC 12.
 *  · Ecuador: tarifa de referencia 3,10 USD/kg.
 * Si la guía se leyó antes de este cambio (sin tarifa ni cargos) solo se informa del USD/kg todo incluido.
 */
function revisarGuia_(pais, g, fleteUsd) {
  const out = [];
  if (!g) return out;
  const kg = Number(g.kg) || 0, n2 = x => Number(x).toFixed(2).replace('.', ','), n3 = x => Number(x).toFixed(3).replace('.', ',');
  if (!kg) return out;
  const tarifa = Number(g.tarifa_kg) || 0;
  const cargos = {};
  (g.cargos || []).forEach(c => { const k = String(c.codigo || '').toUpperCase().trim(); if (k) cargos[k] = (cargos[k] || 0) + (Number(c.usd) || 0); });
  if (pais !== 'COL') {
    if (tarifa && Math.abs(tarifa - VUELOS.TARIFA_ECUADOR) > 0.05)
      out.push('Guía: tarifa ' + n2(tarifa) + ' USD/kg; la habitual de Ecuador es ' + n2(VUELOS.TARIFA_ECUADOR) + ' USD/kg (¿recargo de Santos?).');
    return out;
  }
  const K = VUELOS.KN, fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(g.fecha || '')) ? g.fecha : '';
  const tramo = fecha ? K.SANTOS.find(t => fecha >= t.desde && fecha <= t.hasta) : null;
  const recargo = tramo ? tramo.usd : 0;
  if (tarifa) {
    const ok = K.TARIFAS.some(t => Math.abs(tarifa - (t + recargo)) < 0.006);
    if (ok && kg >= 1100 && Math.abs(tarifa - (K.TARIFAS[1] + recargo)) < 0.006) {
      out.push('Guía K+N: tarifa ' + n2(tarifa) + ' USD/kg, que es la de vuelo pequeño (' + n2(K.TARIFAS[1]) + (recargo ? ' + ' + n2(recargo) + ' Santos' : '') +
        ') en un vuelo de ' + Math.round(kg) + ' kg; con la de vuelo grande (' + n2(K.TARIFAS[0]) + ') serían ' +
        n2((K.TARIFAS[1] - K.TARIFAS[0]) * kg) + ' USD menos.');
    }
    if (!ok) {
      const base = kg > 1000 ? K.TARIFAS[0] : K.TARIFAS[1];
      out.push('Guía K+N: tarifa ' + n2(tarifa) + ' USD/kg; se esperaba ' + n2(base + recargo) + ' (' + n2(base) +
        (recargo ? ' + ' + n2(recargo) + ' de recargo Santos' : ', sin recargo Santos en esa fecha') + '). Diferencia ' +
        n2((tarifa - base - recargo) * kg) + ' USD.');
    }
  }
  if (Object.keys(cargos).length) {
    const fec = cargos.FEC || 0;
    if (Math.abs(fec - K.FEC * kg) > 1) out.push('Guía K+N: combustible (FEC) ' + n2(fec) + ' USD = ' + n3(fec / kg) + ' USD/kg; lo habitual es ' +
      n2(K.FEC) + ' USD/kg (' + n2(K.FEC * kg) + ' USD). Diferencia ' + n2(fec - K.FEC * kg) + ' USD.');
    Object.keys(K.FIJOS).forEach(c => {
      if (Math.abs((cargos[c] || 0) - K.FIJOS[c]) > 0.5) out.push('Guía K+N: cargo ' + c + ' ' + n2(cargos[c] || 0) + ' USD; lo habitual son ' + n2(K.FIJOS[c]) + ' USD.');
    });
    Object.keys(cargos).forEach(c => { if (c !== 'FEC' && !K.FIJOS[c]) out.push('Guía K+N: cargo no habitual ' + c + ' de ' + n2(cargos[c]) + ' USD.'); });
  }
  return out;
}

// Pre-alert / pre-aviso del transitario (K+N, Saftec…): lista de fincas y piezas ANTES del vuelo.
// Se guarda en "Documentos vuelo" como referencia, pero no sirve para cuadrar (no trae tallos ni importes).
// También el PDF con TODAS las facturas de fincas que manda K+N ("Facturas fincas KN (todas)"): es solo referencia,
// las facturas que cuentan son las de cada finca en "Facturas fincas".
function esPreAlert_(nombre) { return /pre[\s_-]?alert|pre[\s_-]?aviso|prealerta|facturas fincas kn/i.test(String(nombre || '')); }

function limpiarClave_(s) { return String(s || '').toUpperCase().replace(/[.#$\/\[\]]/g, '-').trim(); }

// ─────────────────────────── facturas por proveedor (accesos directos) ───────────────────────────
// 01 Importación / Por proveedor / <Proveedor> / Pendientes de pago | Pagadas
// Son ACCESOS DIRECTOS a la factura original (que sigue en la carpeta del vuelo): no se duplica nada.
// Al pagar, arrastra el acceso directo de "Pendientes de pago" a "Pagadas".
function crearAccesoPago_(file, doc, destino) {
  if (!doc) return;
  const d = doc.data || {};
  const nom = String(file.getName() || '');
  // Transitarios (Kuehne+Nagel, Saftec, Logike): en su carpeta va UNA línea por vuelo, la GUÍA, que es lo que se mira.
  //  · K+N: la guía "AWB_…" (Total Prepaid). Saftec: "…_awb.pdf". Logike: el PDF "… AWB 075-… ROSAS DE BUSCAFLOR" (su guía/Master).
  //  · Cuando llega la factura del transitario, esa línea añade su número y su importe (lo que se paga):
  //      "2026-10-14 · AWB 075-69143082 · Guía · Fra LC-17636 · 3502,80 USD"
  //  Nunca el Consolidation Report, el recibo de bodega, EXR, FAL ni fitosanitarios.
  const tr = ['GUIA', 'MASTER', 'FLETE'].indexOf(doc.tipo) >= 0 ? transitarioDoc_(doc, nom) : '';
  const conGuia = ['Kuehne+Nagel', 'Saftec', 'Logike'].indexOf(tr) >= 0;
  const flete = doc.tipo === 'FLETE' ? totalFactura_(d) : (Number(d.flete_usd) || 0);   // factura: el TOTAL, no solo la línea del flete
  const esGuia = conGuia && flete > 0 && !/DOCAWB/i.test(nom) &&
    ((doc.tipo === 'GUIA' && /(^|[_ ])AWB([_ .]|$)/i.test(nom)) || (tr === 'Logike' && doc.tipo === 'MASTER' && /AWB\s*0?75/i.test(nom)));
  const esFacturaTr = conGuia && doc.tipo === 'FLETE' && flete > 0;
  if (doc.tipo !== 'FINCA' && doc.tipo !== 'FLETE' && !esGuia) return;
  const prov = doc.tipo === 'FINCA' ? nombreProveedor_(d.finca) : (conGuia ? tr : nombreTransitario_(d.transitario));
  if (!prov) return;
  // Grupo Cantiza: cada factura en la carpeta de su empresa (Cantiza Flores, Cantiza Growers o Valthomig)
  const emp = doc.tipo === 'FINCA' ? empresaGrupo_(prov, d.finca, d.numero) : '';
  const base = [FOLDERS.IMPORTACION, 'Por proveedor', prov].concat(emp ? [emp] : []);
  const pend = getOrCreatePath_(base.concat(['Pendientes de pago']));
  const pag = getOrCreatePath_(base.concat(['Pagadas']));
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha || '')) ? d.fecha : fmt_(file.getDateCreated(), 'yyyy-MM-dd');
  const usd = n => (Number(n) || 0).toFixed(2).replace('.', ',') + ' USD';

  if (esGuia || esFacturaTr) {
    const marca = ' · AWB ' + doc.awb + ' · Guía';
    const existente = buscarPorTexto_(pend, marca) || buscarPorTexto_(pag, marca);
    const fra = esFacturaTr ? String(d.numero || '').trim() : '';
    if (existente) {
      // ya está la línea del vuelo: la factura le añade su número e importe (o corrige el importe si se leyó mal)
      const nuevo = existente.getName().slice(0, 10) + marca + ' · Fra ' + fra + ' · ' + usd(flete);
      if (fra && existente.getName() !== nuevo) {
        try { existente.setName(nuevo); }
        catch (e) { Logger.log('No se pudo renombrar ' + existente.getName() + ': ' + e); }
      }
      return;
    }
    // primera noticia del vuelo (normalmente la guía; si la factura llega antes, la línea se crea con ella)
    const sc = DriveApp.createShortcut(file.getId());
    sc.moveTo(destino === 'Pagadas' ? pag : pend);
    sc.setName(fecha + marca + (fra ? ' · Fra ' + fra : '') + ' · ' + usd(flete));
    return;
  }

  const importe = doc.tipo === 'FINCA' ? (Number(d.total_usd) || 0) : totalFactura_(d);
  const nombre = fecha + ' · AWB ' + doc.awb + ' · Fra ' + (d.numero || '?') + ' · ' + usd(importe);
  if (pend.getFilesByName(nombre).hasNext() || pag.getFilesByName(nombre).hasNext()) return; // ya existe
  // ya existe con otro importe (se leyó mal y se ha corregido): se renombra, no se duplica
  const marcaFra = ' · AWB ' + doc.awb + ' · Fra ' + (d.numero || '?') + ' · ';
  const viejo = d.numero ? (buscarPorTexto_(pend, marcaFra) || buscarPorTexto_(pag, marcaFra)) : null;
  if (viejo) { try { viejo.setName(nombre); } catch (e) {} return; }
  const sc = DriveApp.createShortcut(file.getId());
  sc.moveTo(destino === 'Pagadas' ? pag : pend);
  sc.setName(nombre);
}

/** Transitario de un documento (por el nombre del archivo o lo leído): Kuehne+Nagel, Saftec, Logike o ''. */
function transitarioDoc_(doc, nom) {
  const d = doc.data || {}, t = String(d.transitario || '');
  if (/saftec/i.test(nom) || /saftec/i.test(t)) return 'Saftec';
  if (/logike/i.test(nom) || /logike|ecuador cargo/i.test(t)) return 'Logike';
  if (nombreTransitario_(t) === 'Kuehne+Nagel' || /kuehne|k\+n/i.test(nom) || d.pais === 'CO') return 'Kuehne+Nagel';
  return '';
}

function buscarPorTexto_(carpeta, txt) {
  const it = carpeta.getFiles();
  while (it.hasNext()) { const f = it.next(); if (f.getName().indexOf(txt) >= 0) return f; }
  return null;
}

/**
 * UNA VEZ: pone la línea de la GUÍA de cada vuelo en las carpetas de Kuehne+Nagel, Saftec y Logike
 * (con el nº e importe de la factura del transitario si ya llegó) y quita los accesos antiguos de solo factura.
 * Si el acceso antiguo estaba en "Pagadas", la línea de la guía también va a "Pagadas".
 */
function rehacerAccesosTransitarios() {
  const docs = cargarDocs_();
  const ids = Object.keys(docs).filter(id => docs[id].awb && ['GUIA', 'MASTER', 'FLETE'].indexOf(docs[id].tipo) >= 0);
  ids.sort((a, b) => (docs[a].tipo === 'FLETE' ? 1 : 0) - (docs[b].tipo === 'FLETE' ? 1 : 0));   // guías primero
  ids.forEach(id => {
    try { const f = DriveApp.getFileById(id); if (!f.isTrashed()) crearAccesoPago_(f, Object.assign({ nombre: f.getName() }, docs[id])); }
    catch (e) { Logger.log('Doc ' + id + ': ' + e); }
  });
  let quitados = 0;
  ['Kuehne+Nagel', 'Saftec', 'Logike'].forEach(tr => {
    let pend, pag;
    try {
      pend = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor', tr, 'Pendientes de pago']);
      pag = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor', tr, 'Pagadas']);
    } catch (e) { return; }
    [pend, pag].forEach(carpeta => {
      const it = carpeta.getFiles(), viejos = [];
      while (it.hasNext()) viejos.push(it.next());
      viejos.forEach(f => {
        const m = f.getName().match(/· AWB ([\d-]+) · Fra /);
        if (!m || /Guía/.test(f.getName()) || f.getMimeType() !== 'application/vnd.google-apps.shortcut') return;
        const marca = ' · AWB ' + m[1] + ' · Guía';
        const nueva = buscarPorTexto_(pend, marca) || buscarPorTexto_(pag, marca);
        if (!nueva) return;
        if (carpeta === pag) { try { nueva.moveTo(pag); } catch (e) {} }
        try { f.setTrashed(true); quitados++; } catch (e) { Logger.log('No se pudo quitar ' + f.getName() + ': ' + e); }
      });
    });
  });
  Logger.log('Hecho. Accesos antiguos de solo factura quitados: ' + quitados);
}

// Nombre de la carpeta del proveedor: usa la pestaña "Alias fincas" (nombre en el papel → nombre Buscaflor);
// si no hay alias, la primera palabra significativa del nombre.
let _alias = null;
function nombreProveedor_(finca) {
  if (!_alias) {
    _alias = [];
    const sh = getRegistro_().getSheetByName('Alias fincas');
    if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
      .forEach(r => { if (r[0] && r[1]) _alias.push([String(r[0]).toUpperCase(), String(r[1])]); });
    // Alias fijos (además de los de la hoja)
    [['LUZ OF ROSES', 'Luz of Roses'], ['YANEZ', 'Luz of Roses'], ['ILUSIONES', 'Quimbiamba'], ['QUIMBIAMBA', 'Quimbiamba'],
     ['AMN', 'Much Flowers'], ['ALMANTI', 'Much Flowers'], ['MUCH FLOWERS', 'Much Flowers'],
     ['ZIPP', 'Plazoleta Bazzani'], ['PLAZOLETA', 'Plazoleta Bazzani'], ['CANTIZA', 'Grupo Cantiza'], ['VALTHOMIG', 'Grupo Cantiza'], ['NATUFLOR', 'Agrinag'], ['AGRINAG', 'Agrinag'], ['ROSALINDA', 'Rosalinda'], ['ERMESPLUTARCO', 'Rosalinda'], ['SOLPACIFIC', 'Valleverde'], ['INTERNATIONAL FLOWER HOLDING', 'Much Flowers'], ['VALLEVERDE', 'Valleverde'], ['MILAGRO', 'Milagro'],
     ['ANDEAN FIELDS', 'Andean Fields'], ['SURANDINA', 'Surandina'], ['INVOS', 'Invos Flowers'],
     // la comercializadora factura con un nombre y el transitario/bodega usa el del cultivo
     ['SINGHA', 'The Farm Direct'], ['FARM DIRECT', 'The Farm Direct'], ['CULTIVOS DEL NORTE', 'Andean Fields'],
     ['AGUATA', 'Invos Flowers'], ['SUCCESS FLOWERS', 'Invos Flowers'], ['MILONGA', 'Invos Flowers'], ['EXPORTCALAS', 'Much Flowers'],
     ['BENCHMARK', 'Benchmark Growers']]
      .forEach(a => { if (!_alias.some(x => x[0] === a[0])) _alias.push(a); });
    _alias.sort((a, b) => b[0].length - a[0].length);
  }
  const f = String(finca || '').toUpperCase();
  const hit = _alias.find(a => f.indexOf(a[0]) >= 0);
  return hit ? hit[1] : corto_(finca);
}

// ─────────────────────────── grupos con varias empresas (Grupo Cantiza) ───────────────────────────
// Dentro de la carpeta del grupo, una subcarpeta por empresa, cada una con su "Pendientes de pago" y "Pagadas":
//   01 Importación / Por proveedor / Grupo Cantiza / Cantiza Flores | Cantiza Growers | Valthomig / Pendientes de pago | Pagadas
// La empresa se saca del nombre de la factura y, si no, de su serie: 15… Cantiza Flores · 25… Valthomig · 35… Cantiza Growers.
// Los pagos se hacen al grupo (un solo pago a Valthomig cubre facturas de las tres), así que las transferencias y
// los estados de cuenta van a "Grupo Cantiza / Transferencias" y "Grupo Cantiza / Estados de cuenta",
// y el cruce de pagos busca las facturas en las tres empresas.
const GRUPOS_EMPRESAS = {
  'Grupo Cantiza': [
    { nombre: 'Cantiza Flores',  rx: /CANTIZA\s*FLORES/i,  serie: /^15\d{6}$/ },
    { nombre: 'Cantiza Growers', rx: /CANTIZA\s*GROWERS/i, serie: /^35\d{6}$/ },
    { nombre: 'Valthomig',       rx: /VALTHOMIG/i,         serie: /^25\d{6}$/ }
  ]
};

/** Empresa dentro del grupo ('' si el proveedor no es un grupo o no se sabe). */
function empresaGrupo_(prov, finca, numero) {
  const lista = GRUPOS_EMPRESAS[prov];
  if (!lista) return '';
  const num = String(numero || '').replace(/\D/g, '');
  const porSerie = lista.find(e => e.serie.test(num));
  if (porSerie) return porSerie.nombre;                       // la serie manda (no se equivoca)
  const porNombre = lista.find(e => e.rx.test(String(finca || '')));
  return porNombre ? porNombre.nombre : '';
}

/** Carpetas bajo "Por proveedor" para la factura de una finca: ['Floranrosa'] o ['Grupo Cantiza', 'Valthomig']. */
function rutaProveedor_(finca, numero) {
  const prov = nombreProveedor_(finca);
  if (!prov) return [];
  const emp = empresaGrupo_(prov, finca, numero);
  return emp ? [prov, emp] : [prov];
}

/**
 * UNA VEZ: separa lo que ya hay en "Por proveedor / Grupo Cantiza" en Cantiza Flores, Cantiza Growers y Valthomig.
 * Las facturas (Pendientes de pago y Pagadas) van a la empresa que les toca, los estados de cuenta a
 * "Grupo Cantiza / Estados de cuenta" y los justificantes de "Pagadas / Transferencias" a "Grupo Cantiza / Transferencias".
 */
function separarGrupoCantiza() {
  const grupo = 'Grupo Cantiza';
  const raiz = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor', grupo]);
  const docs = cargarDocs_();
  const hija = (c, n) => { const it = c.getFoldersByName(n); return it.hasNext() ? it.next() : c.createFolder(n); };
  const vacia = c => !c.getFiles().hasNext() && !c.getFolders().hasNext();
  let movidas = 0, eecc = 0, sinSaber = [];
  // las tres empresas con sus dos carpetas, aunque aún no tengan nada dentro
  GRUPOS_EMPRESAS[grupo].forEach(e => ['Pendientes de pago', 'Pagadas'].forEach(sub => hija(hija(raiz, e.nombre), sub)));
  hija(raiz, 'Transferencias'); hija(raiz, 'Estados de cuenta');
  ['Pendientes de pago', 'Pagadas'].forEach(sub => {
    const it = raiz.getFoldersByName(sub);
    if (!it.hasNext()) return;
    const carpeta = it.next();
    // justificantes de pago: se quedan en el grupo
    const tr = carpeta.getFoldersByName('Transferencias');
    while (tr.hasNext()) {
      const t = tr.next(), dest = hija(raiz, 'Transferencias'), fs = t.getFiles();
      while (fs.hasNext()) fs.next().moveTo(dest);
      if (vacia(t)) t.setTrashed(true);
    }
    const lista = [], fs = carpeta.getFiles();
    while (fs.hasNext()) lista.push(fs.next());
    lista.forEach(f => {
      const nom = f.getName();
      if (/statement|estado de cuenta|estado_de_cuenta|eecc/i.test(nom)) { f.moveTo(hija(raiz, 'Estados de cuenta')); eecc++; return; }
      let finca = '', numero = (nom.match(/· Fra\s+([\w-]+)/) || [])[1] || '';
      try {
        const id = f.getMimeType() === 'application/vnd.google-apps.shortcut' ? f.getTargetId() : f.getId();
        const d = (docs[id] || {}).data || {};
        finca = d.finca || ''; numero = numero || d.numero || '';
      } catch (e) {}
      const emp = empresaGrupo_(grupo, finca, numero);
      if (!emp) { sinSaber.push(nom); return; }
      f.moveTo(hija(hija(raiz, emp), sub)); movidas++;
    });
    if (vacia(carpeta)) carpeta.setTrashed(true);
  });
  Logger.log('Facturas separadas: ' + movidas + ' · Estados de cuenta: ' + eecc +
    (sinSaber.length ? ' · Sin saber la empresa (se quedan en Grupo Cantiza): ' + sinSaber.join(' | ') : ''));
}

/**
 * UNA VEZ: ordena "Por proveedor": une carpetas con el mismo nombre y las que por alias son el mismo
 * proveedor (p. ej. Valthomig → Grupo Cantiza), quita accesos directos repetidos y borra las carpetas vacías.
 */
function limpiarPorProveedor() {
  const raiz = getOrCreatePath_([FOLDERS.IMPORTACION, 'Por proveedor']);
  const destinoDe = {};                       // nombre final → carpeta
  const carpetas = [];
  const it = raiz.getFolders();
  while (it.hasNext()) carpetas.push(it.next());
  carpetas.sort((a, b) => a.getDateCreated() - b.getDateCreated());   // la más antigua se queda
  let movidos = 0, repetidos = 0, borradas = 0;
  carpetas.forEach(c => {
    const final = nombreTransitario_(c.getName()) === 'Kuehne+Nagel' ? 'Kuehne+Nagel' : nombreProveedor_(c.getName());
    if (!destinoDe[final]) {
      destinoDe[final] = c;
      if (c.getName() !== final) c.setName(final);
      return;
    }
    const dest = destinoDe[final];
    ['Pendientes de pago', 'Pagadas'].forEach(sub => {
      const o = c.getFoldersByName(sub); if (!o.hasNext()) return;
      const origen = o.next();
      const d = dest.getFoldersByName(sub); const destSub = d.hasNext() ? d.next() : dest.createFolder(sub);
      const fs = origen.getFiles();
      while (fs.hasNext()) {
        const f = fs.next();
        if (destSub.getFilesByName(f.getName()).hasNext()) { f.setTrashed(true); repetidos++; }
        else { f.moveTo(destSub); movidos++; }
      }
    });
    c.setTrashed(true); borradas++;
  });
  // repetidos dentro de una misma carpeta
  Object.values(destinoDe).forEach(dest => ['Pendientes de pago', 'Pagadas'].forEach(sub => {
    const d = dest.getFoldersByName(sub); if (!d.hasNext()) return;
    const vistos = {}, fs = d.next().getFiles();
    while (fs.hasNext()) { const f = fs.next(); if (vistos[f.getName()]) { f.setTrashed(true); repetidos++; } else vistos[f.getName()] = 1; }
  }));
  Logger.log('Movidos: ' + movidos + ' · Repetidos eliminados: ' + repetidos + ' · Carpetas unidas y borradas: ' + borradas);
}

function nombreTransitario_(t) {
  const x = String(t || '').toUpperCase();
  if (/KUEHNE|K\s*\+\s*N/.test(x)) return 'Kuehne+Nagel';
  if (/SAFTEC/.test(x)) return 'Saftec';
  if (/LOGIKE/.test(x)) return 'Logike';
  return corto_(t);
}

/**
 * UNA SOLA VEZ: crea los accesos directos "Por proveedor" de los vuelos de las últimas N semanas
 * (anteriores a la instalación). No genera inventarios. Si se corta por tiempo, vuelve a ejecutarla:
 * sigue donde iba sin repetir nada (cada PDF se lee una sola vez y los accesos no se duplican).
 *
 * PAGADAS_ANTES_DE: los vuelos de semanas que empiezan antes de esta fecha van directos a "Pagadas".
 *   Déjalo vacío ('') para que todo vaya a "Pendientes de pago".
 */
const ANTERIORES = { SEMANAS: 6, PAGADAS_ANTES_DE: '' };   // ej. '2026-09-07'

function procesarVuelosAnteriores() {
  const t0 = Date.now();
  const docs = cargarDocs_();
  const corte = ANTERIORES.PAGADAS_ANTES_DE ? new Date(ANTERIORES.PAGADAS_ANTES_DE) : null;
  const hoy = new Date(), vistas = {};
  let hechos = 0;
  for (let w = 0; w < ANTERIORES.SEMANAS; w++) {
    const fechaSem = new Date(hoy.getTime() - w * 7 * 86400000);
    const s = semana_(fechaSem);
    if (vistas[s.anio + s.nombre]) continue; vistas[s.anio + s.nombre] = 1;
    let sem;
    try {
      const it = getOrCreatePath_([FOLDERS.IMPORTACION, String(s.anio)]).getFoldersByName(s.nombre);
      if (!it.hasNext()) continue;
      sem = it.next();
    } catch (e) { continue; }
    // lunes de esa semana
    const lunes = new Date(fechaSem); lunes.setHours(0, 0, 0, 0); lunes.setDate(lunes.getDate() - ((lunes.getDay() + 6) % 7));
    const destino = (corte && lunes < corte) ? 'Pagadas' : 'Pendientes de pago';
    // Recorre todo lo que cuelga de la semana: carpetas "AWB …" (estructura nueva) y
    // carpetas por fecha / transitario (estructura antigua, el AWB se lee del propio documento)
    const pila = [{ carpeta: sem, awb: '', tipo: 'RAIZ' }];
    while (pila.length) {
      const nodo = pila.pop();
      const subs = nodo.carpeta.getFolders();
      while (subs.hasNext()) {
        const sub = subs.next(), n = sub.getName();
        const mm = n.match(/^AWB\s+(\d{3}-\d{8})(\s|$)/);
        const tipo = RX_SUB.FINCAS.test(n) ? 'FINCA' : (RX_SUB.DOCS.test(n) || RX_SUB.TRANSPORTE.test(n)) ? 'DOC' : 'RAIZ';
        pila.push({ carpeta: sub, awb: mm ? mm[1] : nodo.awb, tipo: mm ? 'RAIZ' : tipo });
      }
      const files = nodo.carpeta.getFiles();
      while (files.hasNext()) {
        if (Date.now() - t0 > 5 * 60 * 1000) { Logger.log('Tiempo agotado (' + hechos + ' leídos): vuelve a ejecutar procesarVuelosAnteriores.'); return; }
        const f = files.next();
        if (f.getMimeType() !== 'application/pdf' || f.getSize() > VUELOS.MAX_BYTES_PDF) continue;
        if (!docs[f.getId()]) {
          const r = (nodo.tipo === 'RAIZ' || !nodo.awb) ? leerFacturaLigera_(f) : leerDocumentoVuelo_(f, nodo.tipo);
          const awb = nodo.awb || (r && r.awb) || '';
          docs[f.getId()] = { awb: awb, tipo: r ? r._tipo : 'ERROR', data: r || {}, nombre: f.getName() };
          guardarDoc_(f, awb, docs[f.getId()]);
          hechos++;
        }
        if (docs[f.getId()].awb) crearAccesoPago_(f, docs[f.getId()], destino);
      }
    }
  }
  Logger.log('Hecho (' + hechos + ' documentos leídos). Revisa 01 Importación / Por proveedor.');
}

// Lectura rápida (solo lo necesario para el acceso directo) de PDFs sueltos de vuelos antiguos
function leerFacturaLigera_(file) {
  const r = iaJson_(
    'Documento de un envío de flores a ROSAS DE BUSCAFLOR. Responde SOLO JSON: {"tipo":"FINCA|FLETE|GUIA|OTRO",' +
    '"proveedor":"nombre comercial en MAYÚSCULAS (en GUIA: el agente/transitario emisor)","numero":"nº de factura","fecha":"AAAA-MM-DD",' +
    '"importe_usd":n,"pais":"EC|CO","awb":"075-XXXXXXXX"}. FINCA = factura de una finca de flores; FLETE = factura o liquidación de un transitario por el ' +
    'flete aéreo; GUIA = guía aérea AWB (importe_usd = TOTAL PREPAID: flete + todos los cargos); OTRO = el resto (certificados, listas de empaque, master invoice…).', file.getBlob(), 'application/pdf', 300);
  if (!r) return null;
  const m = String(r.awb || '').match(/(\d{3})[-\s]?(\d{4})[-\s]?(\d{4})/);
  const awb = m ? m[1] + '-' + m[2] + m[3] : '';
  if (r.tipo === 'FINCA') return { _tipo: 'FINCA', finca: r.proveedor, numero: r.numero, fecha: r.fecha, total_usd: r.importe_usd, awb: awb };
  if (r.tipo === 'FLETE') return { _tipo: 'FLETE', transitario: r.proveedor, numero: r.numero, fecha: r.fecha, flete_usd: r.importe_usd, awb: awb };
  if (r.tipo === 'GUIA') return { _tipo: 'GUIA', transitario: r.proveedor, fecha: r.fecha, flete_usd: r.importe_usd, pais: r.pais, awb: awb };
  return { _tipo: 'DOC' };
}

/**
 * Vuelve a leer las facturas de fincas de un vuelo y regenera su inventario.
 * Uso: cambia el AWB de abajo y ejecuta releerVuelo desde el editor; después ejecuta revisarVuelos
 * (dos veces si hay más de 6 facturas, o espera a las pasadas automáticas).
 */
const AWB_A_RELEER = ['075-69143502', '075-69143616', '075-69144961', '075-67345600', '075-69143104'];   // guías a regenerar (ahora: flete mal leído); ejecuta releerVuelo
const ARCHIVOS_A_RELEER = [];   // id de Drive de facturas sueltas a releer, p. ej. ['1OHvNfvywr_dfcPm5J0FURUZUzWCoWmcn'], y ejecuta releerVuelo
// Qué documentos se vuelven a leer: 'FINCA' (facturas), 'PESOS' (recibo de bodega), 'ERROR' (lecturas fallidas)
const TIPOS_A_RELEER = ['ERROR'];   // con solo 'ERROR' no se vuelve a leer nada bueno: únicamente se regenera el inventario
function releerVuelo() {
  const sh = hojaDocs_(), hv = hojaVuelos_();
  // Archivos sueltos para volver a leer (por su id de Drive): se borra su lectura y el vuelo se regenera
  ARCHIVOS_A_RELEER.forEach(id => {
    for (let i = sh.getLastRow(); i >= 2; i--) {
      const r = sh.getRange(i, 1, 1, 4).getValues()[0];
      if (r[0] !== id) continue;
      const fila = filaVuelo_(hv, r[1]);
      if (fila) hv.getRange(fila, 6).setValue('');
      sh.deleteRow(i);
      Logger.log('Para releer: ' + r[3] + ' (vuelo ' + r[1] + ')');
    }
  });
  AWB_A_RELEER.forEach(awb => {
    let borradas = 0;
    for (let i = sh.getLastRow(); i >= 2; i--) {
      const r = sh.getRange(i, 1, 1, 3).getValues()[0];
      if (r[1] === awb && TIPOS_A_RELEER.indexOf(r[2]) >= 0) { sh.deleteRow(i); borradas++; }
    }
    const fila = filaVuelo_(hv, awb);
    if (fila) hv.getRange(fila, 6).setValue('');          // borra la firma para que se regenere el inventario
    Logger.log('Documentos de ' + awb + ' para releer: ' + borradas);
  });
  Logger.log('Ahora ejecuta revisarVuelos varias veces (lee 6 facturas por pasada) hasta que lleguen los emails de inventario.');
}

/**
 * Rehace los inventarios de los vuelos de las últimas REHACER_SEMANAS semanas (1 = solo la semana actual) con los
 * valores actuales de VUELOS (p. ej. el palet a 100 €). No vuelve a leer ninguna factura: solo borra la firma del vuelo
 * para que revisarVuelos genere el Excel otra vez. Después ejecuta revisarVuelos (o espera a la siguiente pasada).
 */
const REHACER_SEMANAS = 1;
const REHACER_RELEER_MASTER = false;   // true: vuelve a leer la Master de esos vuelos (para el peso por finca de Ecuador)
function rehacerInventariosRecientes() {
  const hv = hojaVuelos_();
  const validas = {}, hoy = new Date();
  for (let i = 0; i < REHACER_SEMANAS; i++) validas[semana_(new Date(hoy.getTime() - i * 7 * 86400000)).nombre] = 1;
  const hechos = [];
  carpetasAwbRecientes_().forEach(({ awb, semana }) => {
    if (!validas[semana]) return;
    const fila = filaVuelo_(hv, awb);
    if (fila) { hv.getRange(fila, 6).setValue(''); hechos.push(awb + ' (' + semana + ')'); }
    if (REHACER_RELEER_MASTER) {          // la Master se vuelve a leer para sacar los kg de cada finca (Ecuador)
      const sh = hojaDocs_();
      for (let i = sh.getLastRow(); i >= 2; i--) {
        const r = sh.getRange(i, 1, 1, 3).getValues()[0];
        if (r[1] === awb && r[2] === 'MASTER') sh.deleteRow(i);
      }
    }
  });
  Logger.log(hechos.length ? 'Inventarios a rehacer: ' + hechos.join(', ') + '. Ahora ejecuta revisarVuelos.' : 'No hay vuelos con inventario en esas semanas.');
}

// ─────────────────────────────── carpetas y hojas ───────────────────────────────

function carpetasAwbRecientes_() {
  const desdeTxt = PropertiesService.getScriptProperties().getProperty('VUELOS_DESDE');
  const desde = desdeTxt ? new Date(desdeTxt) : new Date();
  const out = [], semanas = {}, hoy = new Date();
  for (let i = 0; i < VUELOS.SEMANAS; i++) {
    const s = semana_(new Date(hoy.getTime() - i * 7 * 86400000));
    semanas[s.anio + '|' + s.nombre] = s;
  }
  Object.values(semanas).forEach(s => {
    let sem;
    try {
      const it = getOrCreatePath_([FOLDERS.IMPORTACION, String(s.anio)]).getFoldersByName(s.nombre);
      if (!it.hasNext()) return;
      sem = it.next();
    } catch (e) { return; }
    const fo = sem.getFolders();
    while (fo.hasNext()) {
      const c = fo.next(), mm = c.getName().match(/^AWB\s+(\d{3}-\d{8})(\s|$)/);
      if (mm && c.getDateCreated() >= desde) out.push({ awb: mm[1], carpeta: c, semana: s.nombre }); // vuelos anteriores a la instalación: se ignoran
    }
  });
  return out;
}

function hojaVuelos_() {
  const ss = getRegistro_();
  let sh = ss.getSheetByName('Vuelos');
  if (!sh) {
    sh = ss.insertSheet('Vuelos');
    sh.appendRow(['AWB', 'Actualizado', 'Inventario', 'Estado', 'Aviso Master', 'Firma docs']);
    sh.getRange(1, 1, 1, 6).setFontWeight('bold'); sh.setFrozenRows(1); sh.hideColumns(5, 2);
  }
  return sh;
}
function hojaDocs_() {
  const ss = getRegistro_();
  let sh = ss.getSheetByName('Docs IA');
  if (!sh) {
    sh = ss.insertSheet('Docs IA');
    sh.appendRow(['FileId', 'AWB', 'Tipo', 'Archivo', 'Datos (JSON)', 'Leído']);
    sh.getRange(1, 1, 1, 6).setFontWeight('bold'); sh.setFrozenRows(1);
  }
  return sh;
}
function hojaPrecios_() {
  const ss = getRegistro_();
  let sh = ss.getSheetByName('Precios');
  if (!sh) {
    sh = ss.insertSheet('Precios');
    sh.appendRow(['Finca|Variedad|Medida', 'USD/tallo', 'Último AWB']);
    sh.getRange(1, 1, 1, 3).setFontWeight('bold'); sh.setFrozenRows(1);
  }
  return sh;
}
function cargarPrecios_() {
  const sh = hojaPrecios_(), out = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => { if (r[0]) out[r[0]] = { usd: Number(r[1]), awb: String(r[2]) }; });
  return out;
}
function guardarPrecios_(p) {
  const sh = hojaPrecios_();
  const vals = Object.keys(p).sort().map(k => [k, p[k].usd, p[k].awb]);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  if (vals.length) sh.getRange(2, 1, vals.length, 3).setValues(vals);
}
function cargarDocs_() {
  const sh = hojaDocs_(), out = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(r => {
    if (!r[0] || r[2] === 'ERROR') return;          // los errores se reintentan en la siguiente pasada
    let data = {}; try { data = JSON.parse(r[4]); } catch (e) {}
    const tipo = (r[2] !== 'ERROR' && esPreAlert_(r[3])) ? 'PREALERT' : r[2];
    // La IA a veces pone como finca al CLIENTE (Rosas de Buscaflor): se usa el proveedor del nombre del archivo
    if (tipo === 'FINCA' && (!data.finca || /BUSCAFLOR/i.test(data.finca))) {
      const m = String(r[3] || '').match(/^\d{4}-\d{2}-\d{2}_([^_]+)_/);
      if (m && !/BUSCAFLOR/i.test(m[1])) data.finca = m[1].toUpperCase();
    }
    // Remitente de un grupo (cantiza@mg.unosof.com → "Grupo Cantiza"): la finca es la EMPRESA del PDF, por la serie del nº
    if (tipo === 'FINCA' && GRUPOS_EMPRESAS[nombreProveedor_(data.finca)] && !empresaGrupo_(nombreProveedor_(data.finca), data.finca, '')) {
      const e = empresaGrupo_(nombreProveedor_(data.finca), data.finca, data.numero);
      if (e) data.finca = e.toUpperCase();
    }
    out[r[0]] = { awb: r[1], tipo: tipo, data: data, nombre: String(r[3] || '') };
  });
  return out;
}
function guardarDoc_(file, awb, d) {
  let json = JSON.stringify(d.data);
  if (json.length > 45000) json = json.slice(0, 45000);
  hojaDocs_().appendRow([file.getId(), awb, d.tipo, file.getName(), json, new Date()]);
}
function filaVuelo_(sh, awb) {
  if (sh.getLastRow() < 2) return 0;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] === awb) return i + 2;
  return 0;
}
function actualizarVuelo_(sh, fila, awb, estado, url, firma, avisoMaster) {
  const vals = [[awb, new Date(), url || (fila ? sh.getRange(fila, 3).getValue() : ''), estado,
    avisoMaster || (fila ? sh.getRange(fila, 5).getValue() : ''), firma || (fila ? sh.getRange(fila, 6).getValue() : '')]];
  if (fila) sh.getRange(fila, 1, 1, 6).setValues(vals); else sh.appendRow(vals[0]);
}

/** Marca en la app de pedidos (Firebase buscaflor/vuelos/<guía>) el inventario del vuelo. Solo añade/cambia esos campos. */
function firebaseVuelo_(awb, datos) {
  try {
    const url = 'https://stock-buscaflor-default-rtdb.europe-west1.firebasedatabase.app/buscaflor/vuelos/' + awb + '.json' + fbAuth_();
    const r = UrlFetchApp.fetch(url, { method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify(Object.assign({ actualizado: new Date().toISOString() }, datos)) });
    if (r.getResponseCode() !== 200) Logger.log('Firebase vuelo ' + awb + ': ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  } catch (e) { Logger.log('Firebase vuelo ' + awb + ': ' + e); }
}