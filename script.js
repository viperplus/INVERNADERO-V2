// ===== CONFIG =====
const CHANNEL_ID = 3459966;
const READ_API_KEY = "JH3QB293XILPIPEU";
const WRITE_API_KEY = "26WLI6BZBLUCFSZN";

const APPS_SCRIPT_FOTOS_URL =
  "https://script.google.com/macros/s/AKfycbzIu6ETc3UhdBa4IuNQdCEbYrAurNugTP-MI-cDt_M_Z1dS5WS_rYazAGTp5oXnU1RH0w/exec";

const POLL_DATOS_MS = 10000;
const POLL_FOTO_MS = 10000;
const POLL_IFRAME_MS = 60000;
const MAX_ANTIGUEDAD_S = 120;
const FAN_MAX_MS = 1200000;  // 20 min en ms (debe coincidir con ESP32)

const API_URL =
  "https://api.thingspeak.com/channels/" + CHANNEL_ID +
  "/feeds.json?api_key=" + READ_API_KEY + "&results=10";

// ----- Countdown ventilador -----
let fanOnTimestamp = null;  // cuándo se prendió el ventilador (local)
let fanCountdownInterval = null;

const elem = (id) => document.getElementById(id);

// ----- Estado + sensores (ThingSpeak) -----
async function cargarDatos() {
  try {
    const resp = await fetch(API_URL + "&t=" + Date.now(), { cache: "no-store" });
    const texto = await resp.text();

    if (!texto.trim().startsWith("{")) {
      elem("dot").className = "dot vacio";
      elem("estado").textContent = "Esperando la primera lectura del ESP32...";
      elem("hora").textContent = "";
      return;
    }

    const data = JSON.parse(texto);
    const feeds = data.feeds || [];
    if (feeds.length === 0) {
      elem("dot").className = "dot vacio";
      elem("estado").textContent = "Esperando la primera lectura del ESP32...";
      elem("hora").textContent = "";
      return;
    }

    // Buscar la última entrada que tenga datos de sensores (field1)
    let d = null;
    for (let i = feeds.length - 1; i >= 0; i--) {
      if (feeds[i].field1 && feeds[i].field1 !== "") {
        d = feeds[i];
        break;
      }
    }

    // Si no hay entrada con sensores, usar la última (para mostrar comandos)
    if (!d) d = feeds[feeds.length - 1];

    const temp = parseFloat(d.field1);
    const hum  = parseFloat(d.field2);
    const co2  = parseFloat(d.field3);
    const lux  = parseFloat(d.field4);
    const suelo = parseFloat(d.field5);

    if (isNaN(temp) && isNaN(hum)) {
      elem("dot").className = "dot vacio";
      elem("estado").textContent = "Sin datos de sensores...";
      elem("hora").textContent = "";
      return;
    }

    if (!isNaN(temp))  elem("temp").textContent  = temp.toFixed(1) + " \u00b0C";
    if (!isNaN(hum))   elem("hum").textContent   = hum.toFixed(1) + " %";
    if (!isNaN(co2))   elem("co2").textContent   = Math.round(co2) + " ppm";
    if (!isNaN(lux))   elem("luz").textContent   = Math.round(lux) + " lx";
    if (!isNaN(suelo)) elem("suelo").textContent = Math.round(suelo) + " %";

    // Comandos: field6=ventilador(0/1/2), field7=bomba(0/1)
    // field6: 0=todo OFF, 1=ventilador+válvula, 2=solo válvula
    let fanVal = null, pumpVal = null, valveVal = null;
    for (let i = feeds.length - 1; i >= 0; i--) {
      if (fanVal === null && feeds[i].field6 !== null && feeds[i].field6 !== "") {
        fanVal = parseInt(feeds[i].field6);
      }
      if (pumpVal === null && feeds[i].field7 !== null && feeds[i].field7 !== "") {
        pumpVal = parseInt(feeds[i].field7);
      }
      if (fanVal !== null && pumpVal !== null) break;
    }
    const fanOn   = fanVal === 1;
    const valveOn = fanVal === 1 || fanVal === 2;
    const pumpOn  = pumpOffTimer ? false : pumpVal === 1;
    elem("fanState").textContent   = fanOn ? "ON" : "--";
    elem("valveState").textContent = valveOn ? "ON" : "--";
    elem("pumpState").textContent  = pumpOn ? "ON" : "--";
    elem("fanToggle").checked   = fanOn;
    elem("valveToggle").checked = valveOn;
    elem("pumpToggle").checked  = pumpOn;
    elem("aspasFan").classList.toggle("girando", fanOn);
    elem("valveAnim").classList.toggle("valvula-abierta", valveOn);
    elem("pumpAnim").classList.toggle("bombeando", pumpOn);

    // Sync countdown: si el ventilador está ON pero no tenemos timestamp, estimar
    if (fanOn && !fanOnTimestamp) {
      // No sabemos exactamente cuándo se prendió, estimar 5 min restantes
      fanOnTimestamp = Date.now() - (FAN_MAX_MS - 300000);
      iniciarCountdown();
    } else if (!fanOn && fanOnTimestamp) {
      fanOnTimestamp = null;
      detenerCountdown();
    }

    const ts = new Date(d.created_at).getTime();
    const antiguedad = (Date.now() - ts) / 1000;
    const alDia = antiguedad < MAX_ANTIGUEDAD_S;

    elem("dot").className = "dot " + (alDia ? "ok" : "vacio");
    elem("estado").textContent = alDia ? "En linea" : "Sin datos recientes";
    elem("hora").textContent = "Ultima lectura: " + new Date(ts).toLocaleTimeString();

    // Diagnostico profundo
    generarDiagnostico(feeds, temp, hum, co2, lux);
  } catch (e) {
    elem("dot").className = "dot error";
    elem("estado").textContent = "Error de conexion";
    elem("hora").textContent = e.message;
  }
}

// ----- Controles -----
function thingSpeakWrite(campo, valor, ok, fail) {
  fetch("https://api.thingspeak.com/update?api_key=" + WRITE_API_KEY + "&" + campo + "=" + valor)
    .then(r => r.text())
    .then(entrada => {
      if (entrada && entrada !== "0") {
        if (ok) ok();
      } else {
        if (fail) fail();
      }
    })
    .catch(() => { if (fail) fail(); });
}

function mostrarMsg(txt, tipo) {
  const el = elem("ctrlMsg");
  el.textContent = txt;
  el.className = "ctrl-msg " + tipo;
  clearTimeout(mostrarMsg._t);
  mostrarMsg._t = setTimeout(() => { el.textContent = ""; el.className = "ctrl-msg"; }, 4000);
}

function controlFan(ON) {
  elem("fanState").textContent = "...";
  // Prender: field6=1 (ventilador+válvula)
  // Apagar: field6=0 (todo OFF, incluyendo válvula)
  thingSpeakWrite("field6", ON ? 1 : 0,
    () => {
      elem("fanState").textContent = ON ? "ON" : "--";
      elem("aspasFan").classList.toggle("girando", ON);
      if (ON) {
        elem("valveState").textContent = "ON";
        elem("valveToggle").checked = true;
        elem("valveAnim").classList.add("valvula-abierta");
        fanOnTimestamp = Date.now();
        iniciarCountdown();
      } else {
        elem("valveState").textContent = "--";
        elem("valveToggle").checked = false;
        elem("valveAnim").classList.remove("valvula-abierta");
        fanOnTimestamp = null;
        detenerCountdown();
      }
      mostrarMsg(ON ? "Ventilador encendido (20 min máx)" : "Ventilador apagado", "ok");
    },
    () => {
      elem("fanState").textContent = ON ? "--" : "ON";
      elem("fanToggle").checked = !ON;
      mostrarMsg("No se pudo enviar. Esperá 15s.", "error");
    }
  );
}

function iniciarCountdown() {
  detenerCountdown();
  actualizarCountdown();
  fanCountdownInterval = setInterval(actualizarCountdown, 1000);
}

function detenerCountdown() {
  clearInterval(fanCountdownInterval);
  fanCountdownInterval = null;
  elem("fanCountdown").textContent = "";
}

function actualizarCountdown() {
  if (!fanOnTimestamp) { detenerCountdown(); return; }
  const restante = Math.max(0, FAN_MAX_MS - (Date.now() - fanOnTimestamp));
  const min = Math.floor(restante / 60000);
  const seg = Math.floor((restante % 60000) / 1000);
  if (restante <= 0) {
    detenerCountdown();
    elem("fanCountdown").textContent = "Apagado automáticamente";
    return;
  }
  elem("fanCountdown").textContent = "Auto-apagado en " + min + ":" + String(seg).padStart(2, "0");
  // Si quedan menos de 3 min, cambiar color a rojo
  elem("fanCountdown").style.color = restante < 180000 ? "#ef4444" : "#eab308";
}

function controlValve(ON) {
  elem("valveState").textContent = "...";
  // Si se prende válvula sin ventilador, field6=2
  // Si se prende con ventilador, field6=1 (ya está prendido)
  // Si se apaga válvula y ventilador está ON, field6=1
  // Si se apaga todo, field6=0
  const fanOn = elem("fanToggle").checked;
  let field6val = 0;
  if (fanOn && ON) field6val = 1;       // ambos ON
  else if (fanOn && !ON) field6val = 1; // ventilador sigue ON
  else if (!fanOn && ON) field6val = 2; // solo válvula
  thingSpeakWrite("field6", field6val,
    () => {
      elem("valveState").textContent = ON ? "ON" : "--";
      elem("valveAnim").classList.toggle("valvula-abierta", ON);
      mostrarMsg(ON ? "Válvula abierta" : "Válvula cerrada", "ok");
    },
    () => {
      elem("valveState").textContent = ON ? "--" : "ON";
      elem("valveToggle").checked = !ON;
      mostrarMsg("No se pudo enviar. Esperá 15s.", "error");
    }
  );
}

function controlPump(ON) {
  elem("pumpState").textContent = "...";
  if (pumpOffTimer) { clearTimeout(pumpOffTimer); pumpOffTimer = null; }
  thingSpeakWrite("field7", ON ? 1 : 0,
    () => {
      elem("pumpState").textContent = ON ? "ON" : "OFF";
      elem("pumpAnim").classList.toggle("bombeando", ON);
      mostrarMsg(ON ? "Bomba encendida (3s)" : "Bomba apagada", "ok");
      if (ON) {
        pumpOffTimer = setTimeout(() => {
          elem("pumpState").textContent = "OFF";
          elem("pumpToggle").checked = false;
          elem("pumpAnim").classList.remove("bombeando");
          pumpOffTimer = null;
        }, 3000);
      }
    },
    () => {
      elem("pumpState").textContent = ON ? "OFF" : "ON";
      elem("pumpToggle").checked = !ON;
      mostrarMsg("No se pudo enviar. Esperá 15s.", "error");
    }
  );
}

function capturarFoto() {
  mostrarMsg("Enviando pedido de foto...", "enviando");
  thingSpeakWrite("field8", 1,
    () => { mostrarMsg("Foto solicitada. Esperá ~20s.", "ok"); },
    () => { mostrarMsg("No se pudo enviar. Esperá 15s.", "error"); }
  );
  setTimeout(() => { ultimoIdFoto = null; esperarFotoNueva(); }, 15000);
}

// ----- Foto de Drive (Apps Script) -----
let ultimoIdFoto = null;
let esperandoFotoNueva = false;
let pumpOffTimer = null;

// Chequeo liviano: solo pide id y fecha (pocos bytes)
async function consultarMeta() {
  try {
    const resp = await fetch(APPS_SCRIPT_FOTOS_URL + "?accion=ultimaMeta&camara=cam01&t=" + Date.now(), { cache: "no-store" });
    const texto = await resp.text();
    if (!texto.trim().startsWith("{")) return null;
    const meta = JSON.parse(texto);
    if (!meta.success) return null;
    return meta;
  } catch (e) {
    return null;
  }
}

// Descarga la foto completa en base64 (método pesado)
async function traerUltimaCompleta() {
  const resp = await fetch(APPS_SCRIPT_FOTOS_URL + "?accion=ultima&camara=cam01&t=" + Date.now(), { cache: "no-store" });
  return resp.json();
}

function mostrarFoto(id, creada) {
  ultimoIdFoto = id;
  elem("foto").dataset.reintentos = "0";
  elem("foto").src = "https://lh3.googleusercontent.com/d/" + id + "=w800";
  elem("fotoFecha").textContent =
    creada ? "Última foto: " + new Date(creada).toLocaleString() : "Última foto";
}

// Reintentos si la imagen no carga
elem("foto").addEventListener("error", () => {
  const src = elem("foto").src || "";
  if (!src || src.indexOf("data:image") === 0) return;

  const reintentos = parseInt(elem("foto").dataset.reintentos || "0", 10);
  const idActual = ultimoIdFoto;

  if (reintentos < 1 && idActual && src.indexOf("lh3.googleusercontent.com") >= 0) {
    elem("foto").dataset.reintentos = String(reintentos + 1);
    setTimeout(() => {
      if (ultimoIdFoto === idActual) {
        elem("foto").src = "https://drive.google.com/thumbnail?id=" + idActual + "&sz=w1200";
      }
    }, 3000);
    return;
  }

  // Último recurso: descargar base64 desde Apps Script
  if (!APPS_SCRIPT_FOTOS_URL.startsWith("http")) return;
  traerUltimaCompleta()
    .then((datos) => {
      if (datos.success && datos.base64 && datos.id === idActual) {
        elem("foto").src = "data:image/jpeg;base64," + datos.base64;
        elem("fotoFecha").textContent =
          datos.creada ? "Última foto: " + new Date(datos.creada).toLocaleString() : "Última foto";
      }
    })
    .catch(() => {});
});

// Evita que las consultas se pisen
let cargandoFotoEnCurso = false;

async function cargarFoto() {
  if (cargandoFotoEnCurso) return;
  if (!APPS_SCRIPT_FOTOS_URL.startsWith("http")) return;
  if (esperandoFotoNueva) return;

  cargandoFotoEnCurso = true;
  try {
    const meta = await consultarMeta();
    if (!meta) return;
    if (!meta.success || !meta.id) {
      elem("foto").src = "";
      elem("fotoFecha").textContent = "Sin fotos todavía";
      ultimoIdFoto = null;
      return;
    }
    if (meta.id !== ultimoIdFoto) {
      mostrarFoto(meta.id, meta.creada);
    }
  } catch (e) {
    console.log("Foto: " + e.message);
  } finally {
    cargandoFotoEnCurso = false;
  }
}

// Espera a que suba la foto nueva tras una captura y la muestra apenas aparezca
async function esperarFotoNueva() {
  const idPrevio = ultimoIdFoto;
  esperandoFotoNueva = true;
  const usaMeta = (await consultarMeta()) !== null;
  const intentos = usaMeta ? 20 : 10;
  const pausa = usaMeta ? 4000 : 8000;

  for (let i = 0; i < intentos && esperandoFotoNueva; i++) {
    await new Promise((r) => setTimeout(r, pausa));
    try {
      if (usaMeta) {
        const meta = await consultarMeta();
        if (meta && meta.id && meta.id !== idPrevio) {
          mostrarFoto(meta.id, meta.creada);
          break;
        }
      } else {
        const datos = await traerUltimaCompleta();
        if (datos.success && datos.base64 && datos.id && datos.id !== idPrevio) {
          ultimoIdFoto = datos.id;
          elem("foto").src = "data:image/jpeg;base64," + datos.base64;
          elem("fotoFecha").textContent =
            "Última foto: " + new Date(datos.creada).toLocaleString();
          break;
        }
      }
    } catch (e) {}
  }
  esperandoFotoNueva = false;
}

// ----- Graficos ThingSpeak -----
function srcGrafico(f) {
  const w = Math.max(Math.floor(f.clientWidth), 250);
  let src = f.dataset.src.replace(/[?&](width|height)=\d+/g, "");
  const sep = src.includes("?") ? "&" : "?";
  return src + sep + "width=" + w + "&height=320&_=" + Date.now();
}

function refrescarGraficos() {
  document.querySelectorAll("iframe[data-reload]").forEach((f) => {
    f.src = srcGrafico(f);
  });
}

// ===== DIAGNOSTICO PROFUNDO =====
function generarDiagnostico(feeds, temp, hum, co2, lux) {
  const el = {
    score: elem("diagScore"),
    texto: elem("diagTexto"),
    recom: elem("diagRecom"),
    card: elem("diagnostico")
  };

  if (isNaN(temp) && isNaN(hum) && isNaN(co2) && isNaN(lux)) {
    el.score.textContent = "Sin datos suficientes";
    el.texto.textContent = "Se requieren al menos algunos valores de sensores para generar el analisis.";
    el.recom.textContent = "";
    el.card.className = "diagnostico verde";
    return;
  }

  // --- Contexto horario ---
  const ahora = new Date();
  const hora = ahora.getHours() + ahora.getMinutes() / 60;
  const esDeNoche = hora < 6 || hora > 20;
  const esMadrugada = hora >= 6 && hora < 8;
  const esTarde = hora >= 16 && hora < 20;
  const esMediodia = hora >= 10 && hora < 16;

  const periodo = esDeNoche ? "nocturno" : esMadrugada ? "madrugada" : esTarde ? "tarde" : "dia";

  // --- Tendencias (ultimas 5 lecturas) ---
  const ultimas = feeds.filter(f => f.field1).slice(-5);
  const proms = { temp: [], hum: [], co2: [], lux: [] };
  ultimas.forEach(f => {
    if (f.field1) proms.temp.push(parseFloat(f.field1));
    if (f.field2) proms.hum.push(parseFloat(f.field2));
    if (f.field3) proms.co2.push(parseFloat(f.field3));
    if (f.field4) proms.lux.push(parseFloat(f.field4));
  });

  const prom = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
  const tendencia = (arr) => {
    if (arr.length < 2) return 0;
    return arr[arr.length - 1] - arr[0];
  };

  const promTemp = prom(proms.temp);
  const promHum = prom(proms.hum);
  const promCo2 = prom(proms.co2);
  const promLux = prom(proms.lux);

  const tendTemp = tendencia(proms.temp);
  const tendHum = tendencia(proms.hum);
  const tendCo2 = tendencia(proms.co2);

  const diffTemp = !isNaN(promTemp) ? temp - promTemp : 0;
  const diffHum = !isNaN(promHum) ? hum - promHum : 0;
  const diffCo2 = !isNaN(promCo2) ? co2 - promCo2 : 0;

  const textoTendencia = (val, diff, unidad) => {
    if (Math.abs(diff) < 0.5) return "estable";
    if (diff > 0) return "en ascenso (" + (diff > 0 ? "+" : "") + diff.toFixed(1) + unidad + " respecto al promedio reciente)";
    return "en descenso (" + diff.toFixed(1) + unidad + " respecto al promedio reciente)";
  };

  // --- Analisis por variable ---
  let textos = [];
  let penalizacion = 0;

  // Temperatura
  if (!isNaN(temp)) {
    let rango, estado;
    if (temp < 10) { rango = "gélido"; estado = "muy por debajo del rango tolerable. Riesgo de daño por frío en la mayoría de los cultivos, especialmente especies tropicales"; penalizacion += 20; }
    else if (temp < 15) { rango = "fresco"; estado = "ligeramente bajo, el crecimiento se ralentiza y las plantas de clima cálido muestran menor actividad metabolicá"; penalizacion += 8; }
    else if (temp <= 25) { rango = "optimo"; estado = "dentro del rango ideal para la fotosíntesis, el crecimiento foliar y el desarrollo radicular"; }
    else if (temp <= 30) { rango = "cálido"; estado = "elevado pero manejable, las plantas incrementan la transpiración para regular su temperatura interna"; penalizacion += 5; }
    else { rango = "caluroso"; estado = "estrés térmico, las enzimas fotosintéticas pierden eficiencia por encima de 30°C"; penalizacion += 15; }

    let tex = "Temperatura " + temp.toFixed(1) + "°C, nivel " + rango + ". " + estado.charAt(0).toUpperCase() + estado.slice(1) + ".";
    if (Math.abs(diffTemp) > 1) {
      tex += " Tendencia " + textoTendencia(temp, diffTemp, "°C") + ".";
    }
    if (esDeNoche && temp < 12) {
      tex += " Durante la noche el descenso es esperable, pero por debajo de 10°C las plantas sensibles al frío pueden sufrir daño.";
    }
    if (esTarde && temp > 27) {
      tex += " Si no baja con el atardecer, el invernadero está reteniendo demasiado calor.";
    }
    textos.push(tex);
  }

  // Humedad
  if (!isNaN(hum)) {
    let rango, estado;
    if (hum < 30) { rango = "críticamente bajo"; estado = "estrés hídrico severo, las plantas cierran estómagos para conservar agua y el crecimiento se detiene"; penalizacion += 20; }
    else if (hum < 50) { rango = "seco"; estado = "por debajo del nivel ideal, la transpiración supera la absorción radicular y el crecimiento vegetativo se afecta"; penalizacion += 10; }
    else if (hum <= 75) { rango = "optimo"; estado = "intercambio gaseoso eficiente, sin riesgo de enfermedades fúngicas"; }
    else if (hum <= 85) { rango = "húmedo"; estado = "la evaporación foliar se ralentiza y comienza a acumularse humedad en zonas de menor ventilación"; penalizacion += 5; }
    else { rango = "riesgo de hongos"; estado = "condiciones ideales para la germinación de Botrytis y Oidium, pueden devastar el cultivo en 48-72 horas"; penalizacion += 18; }

    let tex = "Humedad " + hum.toFixed(0) + "%, nivel " + rango + ". " + estado.charAt(0).toUpperCase() + estado.slice(1) + ".";
    if (Math.abs(diffHum) > 3) {
      tex += " Tendencia " + textoTendencia(hum, diffHum, "%") + ".";
    }
    if (hum > 80 && temp > 20) {
      tex += " Combinación riesgosa: el punto de rocío se alcanza fácilmente durante la noche, provocando condensación que facilita hongos.";
    }
    textos.push(tex);
  }

  // CO2
  if (!isNaN(co2)) {
    let rango, estado;
    if (co2 < 300) { rango = "muy bajo"; estado = "por debajo del nivel atmosférico (~420 ppm), limita severamente la fotosíntesis"; penalizacion += 15; }
    else if (co2 < 400) { rango = "bajo"; estado = "ligeramente por debajo de lo normal, el carbono puede estar limitando la producción de biomasa"; penalizacion += 8; }
    else if (co2 <= 1000) { rango = "adecuado"; estado = "suficiente carbono disponible para una fotosíntesis eficiente"; }
    else if (co2 <= 1500) { rango = "elevado"; estado = "acumulación por ventilación insuficiente o alta respiración del suelo"; penalizacion += 5; }
    else { rango = "excesivo"; estado = "valores muy altos pueden provocar cierre estomatal parcial en algunas especies"; penalizacion += 15; }

    let tex = "CO₂ " + Math.round(co2) + " ppm, nivel " + rango + ". " + estado.charAt(0).toUpperCase() + estado.slice(1) + ".";
    if (Math.abs(diffCo2) > 50) {
      tex += " Tendencia " + textoTendencia(co2, diffCo2, " ppm") + ".";
    }
    if (esDeNoche && co2 > 800) {
      tex += " De noche no hay fotosíntesis, el CO₂ se acumula. Se normaliza al amanecer cuando las plantas reanuden la absorción.";
    }
    if (esMediodia && co2 < 500) {
      tex += " A esta hora las plantas necesitan más carbono; si el invernadero está cerrado, la reserva se agota rápido.";
    }
    textos.push(tex);
  }

  // Luz
  if (!isNaN(lux)) {
    let estado, pen = 0;
    if (esDeNoche) {
      if (lux < 5) estado = "consistente con la noche, las plantas dependen de las reservas acumuladas durante el día";
      else { estado = "anómalo para la noche, verificar si hay iluminación artificial o fugas de luz externa"; pen = 5; }
    } else if (esMadrugada) {
      if (lux < 200) estado = "esperable para el amanecer, la fotosíntesis apenas comienza a activarse";
      else estado = "buena luminosidad para esta hora, las plantas están iniciando la jornada con buena intensidad";
    } else if (esMediodia) {
      if (lux < 500) { estado = "muy bajo para las horas centrales, posible obstrucción de la cubierta que limita la producción de azúcares"; pen = 12; }
      else if (lux < 5000) estado = "moderado, adecuado para cultivos de sombra pero por debajo del óptimo para especies de alta luminosidad";
      else if (lux <= 40000) estado = "adecuado para el desarrollo vegetal, fotosíntesis eficiente sin riesgo de fotoinhibición";
      else { estado = "excesivo, riesgo de quemaduras en hojas jóvenes. Considerar malla sombreadora"; pen = 10; }
    } else {
      if (lux < 300) estado = "bajo para la tarde, nubosidad densa o sombra temprana reduce la actividad fotosintética";
      else if (lux < 5000) estado = "adecuado para el cierre de la jornada, las plantas aprovechan las últimas horas de luz";
      else estado = "luminosidad intensa para esta hora, retarda el ciclo circadiano de las plantas";
    }

    penalizacion += pen;
    let tex = "Luz " + Math.round(lux) + " lux: " + estado + ".";
    if (esMediodia && lux < 1000 && lux > 0) {
      tex += " A esta hora debería ser mayor; revisar la transparencia de la cubierta.";
    }
    textos.push(tex);
  }

  // --- Correlaciones ---
  let correlaciones = [];
  if (!isNaN(temp) && !isNaN(lux)) {
    if (tendTemp > 1 && promLux > 2000) {
      correlaciones.push("Temperatura y luz suben juntas: es el efecto invernadero solar. Normal durante el día, pero si supera 30°C conviene ventilar.");
    }
    if (tendTemp > 2 && (isNaN(lux) || promLux < 100)) {
      correlaciones.push("La temperatura sube sin luz visible. No es radiación solar; verificar si hay equipos encendidos o fugas de calor.");
    }
  }
  if (!isNaN(hum) && !isNaN(temp)) {
    if (hum > 80 && temp > 22) {
      correlaciones.push("Humedad alta con temperatura moderada: alto riesgo de condensación nocturna sobre las hojas, ideal para hongos como Botrytis.");
    }
  }
  if (!isNaN(co2) && !isNaN(lux)) {
    if (co2 > 1000 && promLux < 500) {
      correlaciones.push("CO₂ alto sin luz suficiente: las plantas no lo están consumiendo. Ventilar al amanecer para restablecer el equilibrio.");
    }
  }
  if (correlaciones.length > 0) {
    textos.push(correlaciones[0]);
  }

  // --- Score ---
  let score = 100 - penalizacion;
  score = Math.max(0, Math.min(100, score));

  let nivel, clase;
  if (score > 80) { nivel = "Óptimo"; clase = "verde"; }
  else if (score > 60) { nivel = "Atención"; clase = "amarillo"; }
  else { nivel = "Alerta"; clase = "rojo"; }

  // --- Recomendaciones ---
  let recoms = [];
  if (!isNaN(hum) && hum > 80) recoms.push("Activar la ventilación para reducir la humedad acumulada.");
  if (!isNaN(co2) && co2 > 1200) recoms.push("Ventilar el invernadero para restaurar los niveles de CO₂.");
  if (!isNaN(temp) && temp > 30) recoms.push("Encender el ventilador para reducir la temperatura.");
  if (!isNaN(temp) && temp < 12 && esDeNoche) recoms.push("Proteger las plantas sensibles al frío durante la noche.");
  if (!isNaN(lux) && esMediodia && lux < 500) recoms.push("Inspeccionar la cubierta del invernadero por obstrucciones.");
  if (recoms.length === 0) recoms.push("No se requiere intervención en este momento.");

  // --- Render ---
  el.score.innerHTML = "Estado del invernadero: <span class='puntaje'>" + score + "/100</span> — " + nivel;

  // Armar items con clase según severidad
  let items = "";
  textos.forEach(t => {
    let cls = "";
    if (t.includes("gélido") || t.includes("caluroso") || t.includes("críticamente") || t.includes("riesgo de hongos") || t.includes("muy bajo") || t.includes("excesivo")) cls = " alerta";
    else if (t.includes("fresco") || t.includes("cálido") || t.includes("seco") || t.includes("húmedo") || t.includes("bajo") || t.includes("elevado") || t.includes("muy bajo")) cls = " atencion";
    items += "<li class='" + cls + "'>" + t + "</li>";
  });
  el.texto.innerHTML = "<ul>" + items + "</ul>";

  el.recom.innerHTML = "<strong>Recomendación:</strong> " + recoms.join(" ");
  el.card.className = "diagnostico " + clase;
}

// ----- Init -----
window.addEventListener("resize", refrescarGraficos);
refrescarGraficos();
setInterval(refrescarGraficos, POLL_IFRAME_MS);

cargarDatos();
setInterval(cargarDatos, POLL_DATOS_MS);

cargarFoto();
setInterval(cargarFoto, POLL_FOTO_MS);

// Guardar texto original de botones para restaurar despues de feedback
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".btn").forEach(b => {
    b.dataset.orig = b.textContent;
  });
  cargarPosts();
});

// ===== Bitacora =====
function toggleBlogForm() {
  const form = document.getElementById("blogForm");
  form.classList.toggle("oculto");
}

function cargarPosts() {
  fetch(APPS_SCRIPT_FOTOS_URL + "?accion=listarPosts&n=10&t=" + Date.now(), { cache: "no-store" })
    .then((r) => r.json())
    .then((datos) => {
      const contenedor = document.getElementById("posts");
      if (!datos.success || !datos.posts || datos.posts.length === 0) {
        contenedor.innerHTML = '<div class="sinPosts">Todavia no hay publicaciones</div>';
        return;
      }
      contenedor.innerHTML = datos.posts.map((p, i) => {
        const d = new Date(p.fecha);
        const dia = d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        const hora = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
        const img = p.imagenId
          ? '<img class="postImg" src="https://lh3.googleusercontent.com/d/' + p.imagenId + '=w800" alt="Post" onerror="this.src=\'https://drive.google.com/uc?export=view&id=' + p.imagenId + '\'">'
          : '';
        return '<div class="post">' + img +
          '<div class="postFecha">' + dia + ' · ' + hora +
          ' <button class="postBorrar" onclick="borrarPost(' + i + ')" title="Borrar">&#10005;</button></div>' +
          '<div class="postTexto">' + escapeHtml(p.texto) + '</div></div>';
      }).join("");
    })
    .catch(() => {});
}

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

document.getElementById("postImagen").addEventListener("change", function () {
  const preview = document.getElementById("blogPreview");
  if (this.files && this.files[0]) {
    const reader = new FileReader();
    reader.onload = function (e) {
      preview.innerHTML = '<img src="' + e.target.result + '" alt="Preview">';
    };
    reader.readAsDataURL(this.files[0]);
  } else {
    preview.innerHTML = "";
  }
});

function publicarPost() {
  const texto = document.getElementById("postTexto").value.trim();
  const estado = document.getElementById("postEstado");
  const archivo = document.getElementById("postImagen").files[0];

  if (!texto) { estado.textContent = "Escribi algo"; estado.className = "postEstado error"; return; }

  estado.textContent = "Publicando...";
  estado.className = "postEstado";

  if (archivo) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const b64 = e.target.result.split(",")[1];
      enviarPost({ accion: "nuevoPost", texto: texto, imagen: b64 });
    };
    reader.readAsDataURL(archivo);
  } else {
    enviarPost({ accion: "nuevoPost", texto: texto });
  }
}

function enviarPost(payload) {
  const estado = document.getElementById("postEstado");
  fetch(APPS_SCRIPT_FOTOS_URL, {
    method: "POST",
    body: JSON.stringify(payload)
  })
    .then((r) => r.json())
    .then((datos) => {
      if (datos.success) {
        estado.textContent = "Publicado!";
        estado.className = "postEstado ok";
        document.getElementById("postTexto").value = "";
        document.getElementById("postImagen").value = "";
        document.getElementById("blogPreview").innerHTML = "";
        cargarPosts();
        setTimeout(() => { document.getElementById("blogForm").classList.add("oculto"); }, 1500);
      } else {
        estado.textContent = datos.error || "Error";
        estado.className = "postEstado error";
      }
    })
    .catch(() => {
      estado.textContent = "Error de conexion";
      estado.className = "postEstado error";
    });
}

function borrarPost(i) {
  const contrasena = prompt("Contraseña para borrar:");
  if (!contrasena) return;
  fetch(APPS_SCRIPT_FOTOS_URL, {
    method: "POST",
    body: JSON.stringify({ accion: "borrarPost", index: i, contrasena: contrasena })
  })
    .then((r) => r.json())
    .then((datos) => {
      if (datos.success) cargarPosts();
      else alert(datos.error || "Error al borrar");
    })
    .catch(() => alert("Error de conexion"));
}
