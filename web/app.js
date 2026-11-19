/* BoletoTEC - frontend (HTML + ethers v6 + MetaMask). Sin build: se sube tal cual a Vercel. */
const { ethers } = window;
const CFG = window.BOLETOTEC || { redes: {}, abis: {} };
const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const DOORS_OPEN = 6 * 3600;
const DOORS_CLOSE = 12 * 3600;

// ------------------------------------------------------------ red elegida
// ?red=localhost o ?red=sepolia la fuerza; si no: localhost en tu compu (si existe), Sepolia en Vercel
function elegirRed() {
  const pedida = new URLSearchParams(location.search).get("red");
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const nombre = (pedida && CFG.redes[pedida] && pedida) || (local && CFG.redes.localhost ? "localhost" : CFG.redes.sepolia ? "sepolia" : Object.keys(CFG.redes)[0]);
  return nombre ? { key: nombre, ...CFG.redes[nombre] } : null;
}
const RED = elegirRed();

const state = { account: null, signer: null, isOwner: false, isStaff: false, events: [], metaCache: {} };
let lector; // proveedor de solo lectura (funciona aunque no conecten MetaMask)
const contratos = {};

// ------------------------------------------------------------ utilidades
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const eth = (wei) => `${Number(ethers.formatEther(wei)).toLocaleString("es-MX", { maximumFractionDigits: 6 })} ETH`;
const fecha = (ts) => new Date(Number(ts) * 1000).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
const ahora = () => Math.floor(Date.now() / 1000);
const toHttp = (uri) => (uri?.startsWith("ipfs://") ? IPFS_GATEWAY + uri.slice(7) : uri);
const linkTx = (hash) => (RED.explorer ? `<a href="${RED.explorer}/tx/${hash}" target="_blank" rel="noopener">ver transacción</a>` : short(hash));
const linkAddr = (a) => (RED.explorer ? `<a href="${RED.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>` : short(a));
const mismo = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

function toast(html, tipo = "", ms = 6000) {
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.innerHTML = html;
  $("#toasts").appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// Mensaje legible de un error de ethers / MetaMask / require() del contrato
function mensajeError(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "Cancelaste la transacción en MetaMask";
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (data && typeof data === "string") {
    for (const c of Object.values(contratos)) {
      try {
        const err = c.interface.parseError(data);
        if (err) return err.name === "Error" ? err.args[0] : err.name;
      } catch {}
    }
  }
  return e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
}

// Envia una transaccion mostrando cada estado
async function enviar(descripcion, fn) {
  if (!state.signer) return toast("Primero conecta MetaMask", "bad");
  const t = toast(`⏳ ${esc(descripcion)}: confirma en MetaMask…`, "", 0);
  try {
    const tx = await fn();
    t.innerHTML = `⛓️ ${esc(descripcion)}: esperando confirmación… ${linkTx(tx.hash)}`;
    await tx.wait();
    t.remove();
    toast(`✅ ${esc(descripcion)} ${linkTx(tx.hash)}`, "ok", 8000);
    await refrescar();
    return true;
  } catch (e) {
    t.remove();
    toast(`❌ ${esc(mensajeError(e))}`, "bad", 9000);
    return false;
  }
}

// ------------------------------------------------------------ contratos
function crearContratos(runner) {
  for (const nombre of ["Boletera", "TicketNFT", "MultiSignWallet"]) {
    contratos[nombre] = new ethers.Contract(RED.addresses[nombre], CFG.abis[nombre], runner);
  }
}
const B = () => contratos.Boletera;
const T = () => contratos.TicketNFT;
const escritura = (nombre) => contratos[nombre].connect(state.signer);

// ------------------------------------------------------------ MetaMask
async function conectar() {
  if (!window.ethereum) return mostrarSinMetaMask(true);
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await asegurarRed();
    await configurarCuenta();
  } catch (e) {
    toast(`❌ ${esc(mensajeError(e))}`, "bad");
  }
}

async function asegurarRed() {
  const hex = "0x" + RED.chainId.toString(16);
  const actual = await window.ethereum.request({ method: "eth_chainId" });
  if (actual === hex) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    // La red no esta en MetaMask: se agrega
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: RED.name, rpcUrls: [RED.rpc], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: RED.explorer ? [RED.explorer] : [] }],
    });
  }
}

async function configurarCuenta() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const cuentas = await provider.send("eth_accounts", []);
  const chain = Number(await provider.send("eth_chainId", []));
  if (!cuentas.length) {
    state.account = state.signer = null;
  } else if (chain !== RED.chainId) {
    state.account = state.signer = null;
    aviso(`MetaMask está en otra red. <button class="btn primary" id="btnCambiarRed">Cambiar a ${esc(RED.name)}</button>`);
    $("#btnCambiarRed").onclick = () => asegurarRed().then(configurarCuenta).catch((e) => toast(esc(mensajeError(e)), "bad"));
  } else {
    state.signer = await provider.getSigner();
    state.account = await state.signer.getAddress();
    aviso("");
  }
  await refrescar();
}

function mostrarSinMetaMask(forzar) {
  const enCelular = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const deepLink = `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;
  if (enCelular) {
    aviso(`Para comprar abre esta página <b>dentro de la app de MetaMask</b>. <a class="btn primary" href="${deepLink}">Abrir en MetaMask</a>`);
  } else if (forzar) {
    aviso(`No se encontró MetaMask. Instala la extensión desde <a href="https://metamask.io/download" target="_blank" rel="noopener">metamask.io</a> y recarga la página.`);
  }
}

function aviso(html) {
  $("#aviso").innerHTML = html;
  $("#aviso").classList.toggle("hidden", !html);
}

// ------------------------------------------------------------ lectura general
async function refrescar() {
  const cuentaEl = $("#cuenta");
  cuentaEl.classList.toggle("hidden", !state.account);
  $("#btnConectar").classList.toggle("hidden", !!state.account);
  if (state.account) cuentaEl.innerHTML = linkAddr(state.account);

  try {
    const [eventos, owner] = await Promise.all([B().getEvents(), B().owner()]);
    state.events = eventos.map((e, id) => ({ id, ...e.toObject() }));
    state.isOwner = mismo(owner, state.account);
    state.isStaff = state.account ? await B().isStaff(state.account) : false;
  } catch (e) {
    aviso(`No se pudo leer el contrato en ${esc(RED.name)}: ${esc(mensajeError(e))}`);
    return;
  }
  $('[data-tab="admin"]').classList.toggle("hidden", !state.isOwner);
  $('[data-tab="staff"]').classList.toggle("hidden", !(state.isOwner || state.isStaff));
  // Si la cuenta nueva ya no puede ver la pestana abierta, regresa a la cartelera
  if ($("#tabs button.active").classList.contains("hidden")) $('[data-tab="cartelera"]').click();

  await Promise.all([pintarCartelera(), pintarBoletos(), pintarReventa(), state.isOwner ? pintarAdmin() : null]);
  if ($("#historial").classList.contains("active")) pintarHistorial();
}

function estadoEvento(e) {
  const t = ahora();
  const fechaN = Number(e.date);
  if (e.canceled) return ["Cancelado", "bad"];
  if (t > fechaN + DOORS_CLOSE) return ["Terminado", ""];
  if (t >= fechaN) return ["En curso", "warn"];
  if (e.sold >= e.capacity) return ["Agotado", "bad"];
  if (t + DOORS_OPEN >= fechaN) return ["Puertas abiertas", "warn"];
  return ["En venta", "ok"];
}

// Lee la metadata en IPFS (si el evento tiene) para la imagen
async function metadata(uri) {
  if (!uri) return null;
  if (!(uri in state.metaCache)) {
    state.metaCache[uri] = fetch(toHttp(uri)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return state.metaCache[uri];
}

function poster(e) {
  const iniciales = e.name.split(/\s+/).map((p) => p[0]).join("").slice(0, 3).toUpperCase();
  return `<div class="poster" data-uri="${esc(e.uri)}">${esc(iniciales)}</div>`;
}

// Despues de pintar, pone las imagenes que tengan metadata
function cargarPosters(cont) {
  cont.querySelectorAll(".poster[data-uri]").forEach(async (el) => {
    const m = await metadata(el.dataset.uri);
    if (m?.image) {
      el.style.backgroundImage = `url("${toHttp(m.image)}")`;
      el.classList.add("img");
    }
  });
}

// ------------------------------------------------------------ cartelera
async function pintarCartelera() {
  const cont = $("#listaEventos");
  if (!state.events.length) {
    cont.innerHTML = `<div class="vacio">Todavía no hay eventos.</div>`;
    return;
  }
  cont.innerHTML = state.events
    .slice()
    .reverse()
    .map((e) => {
      const [txt, cls] = estadoEvento(e);
      const disponibles = e.capacity - e.sold;
      const sePuede = !e.canceled && ahora() < Number(e.date) && e.sold < e.capacity;
      return `<div class="card">
        ${poster(e)}
        <div class="meta"><span class="estado ${cls}">${txt}</span><span>${disponibles} de ${e.capacity} disponibles</span></div>
        <h3>${esc(e.name)}</h3>
        <div class="muted">📅 ${fecha(e.date)}</div>
        <div class="precio">${eth(e.price)}</div>
        <div class="acciones">
          <button class="btn primary" data-comprar="${e.id}" ${sePuede ? "" : "disabled"}>Comprar boleto</button>
        </div>
      </div>`;
    })
    .join("");
  cargarPosters(cont);
}

// ------------------------------------------------------------ mis boletos
async function pintarBoletos() {
  const cont = $("#listaBoletos");
  const saldoEl = $("#saldo");
  if (!state.account) {
    saldoEl.classList.add("hidden");
    cont.innerHTML = `<div class="vacio">Conecta MetaMask para ver tus boletos.</div>`;
    return;
  }
  const [ids, saldo] = await Promise.all([T().ticketsOf(state.account), B().balances(state.account)]);
  saldoEl.classList.toggle("hidden", saldo === 0n);
  saldoEl.innerHTML = `<div class="row between"><div>💰 Tienes <b>${eth(saldo)}</b> por tus reventas.</div><button class="btn primary" id="btnRetirar">Retirar a mi cuenta</button></div>`;

  if (!ids.length) {
    cont.innerHTML = `<div class="vacio">No tienes boletos. Compra uno en la cartelera.</div>`;
    return;
  }
  const boletos = await Promise.all(
    ids.map(async (id) => {
      const [eventId, usado, listing] = await Promise.all([T().eventOf(id), T().used(id), B().listings(id)]);
      return { id, e: state.events[Number(eventId)], usado, listing };
    })
  );
  cont.innerHTML = boletos
    .map(({ id, e, usado, listing }) => {
      const [txt] = estadoEvento(e);
      const tope = (e.price * e.maxResalePct) / 100n;
      const enVenta = listing.seller !== ethers.ZeroAddress;
      let estado = usado ? `<span class="estado">✔ Ya entraste</span>` : enVenta ? `<span class="estado warn">En reventa por ${eth(listing.price)}</span>` : `<span class="estado ok">Válido</span>`;
      let acciones = "";
      if (e.canceled) {
        estado = `<span class="estado bad">Evento cancelado</span>`;
        acciones = `<button class="btn primary" data-reembolso="${id}">Pedir reembolso (${eth(e.price)})</button>`;
      } else if (!usado && ahora() < Number(e.date)) {
        acciones = enVenta
          ? `<button class="btn" data-cancelar-reventa="${id}">Quitar de reventa</button>`
          : `<form class="row" data-revender="${id}"><input name="precio" type="number" step="0.0001" min="0.0001" max="${ethers.formatEther(tope)}" placeholder="Máx ${ethers.formatEther(tope)}" required /><button class="btn">Revender</button></form>`;
      }
      return `<div class="card">
        ${poster(e)}
        <div class="meta">${estado}<span>${txt}</span></div>
        <div class="boleto-num">#${id}</div>
        <h3>${esc(e.name)}</h3>
        <div class="muted">📅 ${fecha(e.date)}</div>
        <div class="acciones">${acciones}</div>
      </div>`;
    })
    .join("");
  cargarPosters(cont);
}

// ------------------------------------------------------------ reventa
async function pintarReventa() {
  const cont = $("#listaReventa");
  const [ids, items] = await B().getListings();
  if (!ids.length) {
    cont.innerHTML = `<div class="vacio">No hay boletos en reventa.</div>`;
    return;
  }
  const filas = await Promise.all(ids.map(async (id, i) => ({ id, l: items[i], e: state.events[Number(await T().eventOf(id))] })));
  cont.innerHTML = filas
    .map(({ id, l, e }) => {
      const mio = mismo(l.seller, state.account);
      const vigente = !e.canceled && ahora() < Number(e.date);
      return `<div class="card">
        ${poster(e)}
        <div class="meta"><span>Boleto #${id}</span><span>Vende ${linkAddr(l.seller)}</span></div>
        <h3>${esc(e.name)}</h3>
        <div class="muted">📅 ${fecha(e.date)} · original ${eth(e.price)}</div>
        <div class="precio">${eth(l.price)}</div>
        <div class="acciones"><button class="btn primary" data-comprar-reventa="${id}" data-precio="${l.price}" ${mio || !vigente ? "disabled" : ""}>${mio ? "Es tuyo" : "Comprar"}</button></div>
      </div>`;
    })
    .join("");
  cargarPosters(cont);
}

// ------------------------------------------------------------ staff
async function revisarBoleto(id) {
  const info = $("#infoBoleto");
  try {
    const [dueno, eventId, usado] = await Promise.all([T().ownerOf(id), T().eventOf(id), T().used(id)]);
    const e = state.events[Number(eventId)];
    const [txt, cls] = estadoEvento(e);
    info.innerHTML = `<p><b>${esc(e.name)}</b> · ${fecha(e.date)} · <span class="estado ${cls}">${txt}</span><br>
      Dueño: ${linkAddr(dueno)} · ${usado ? '<span class="estado bad">YA SE USÓ</span>' : '<span class="estado ok">Sin usar</span>'}</p>`;
  } catch (e) {
    info.innerHTML = `<p class="estado bad">El boleto #${esc(id)} no existe (o fue reembolsado).</p>`;
  }
}

// ------------------------------------------------------------ admin
async function pintarAdmin() {
  const tesoreria = await B().treasury();
  const saldoT = await lector.getBalance(tesoreria);
  $("#tesoreria").innerHTML = `Tesorería (MultiSignWallet): ${linkAddr(tesoreria)} · saldo <b>${eth(saldoT)}</b>`;
  $("#adminEventos").innerHTML = `<div class="tabla"><table>
    <tr><th>#</th><th>Evento</th><th>Vendidos</th><th>En el contrato</th><th></th></tr>
    ${state.events
      .map((e) => {
        const [txt, cls] = estadoEvento(e);
        const puedeCancelar = !e.canceled && ahora() < Number(e.date);
        const puedeRetirar = !e.withdrawn && e.collected > 0n && (e.canceled ? e.refunded === e.sold : ahora() > Number(e.date) + DOORS_CLOSE);
        return `<tr><td>${e.id}</td><td>${esc(e.name)}<br><span class="estado ${cls}">${txt}</span> <span class="muted">${fecha(e.date)}</span></td>
          <td>${e.sold}/${e.capacity}${e.canceled ? `<br><span class="muted">${e.refunded} reembolsados</span>` : ""}</td>
          <td>${e.withdrawn ? "Enviado a tesorería" : eth(e.collected)}</td>
          <td class="acciones">
            ${puedeCancelar ? `<button class="btn danger" data-cancelar-evento="${e.id}">Cancelar</button>` : ""}
            ${puedeRetirar ? `<button class="btn primary" data-retirar-evento="${e.id}">Enviar a tesorería</button>` : ""}
          </td></tr>`;
      })
      .join("")}
  </table></div>`;
}

// Reduce la imagen a 1200 px (JPEG) para que la peticion a /api/upload sea ligera
function imagenADataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, 1200 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * escala);
      c.height = Math.round(img.height * escala);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("No se pudo leer la imagen"));
    img.src = URL.createObjectURL(file);
  });
}

// Sube imagen + metadata a IPFS con la funcion /api/upload (el JWT de Pinata esta en el servidor)
async function subirImagen(nombre, descripcion, file) {
  const t = toast("🖼️ Firma el mensaje en MetaMask para subir la imagen…", "", 0);
  try {
    const message = `BoletoTEC: subir imagen ${Date.now()}`;
    const signature = await state.signer.signMessage(message);
    t.innerHTML = "⏫ Subiendo imagen a IPFS…";
    const image = await imagenADataUrl(file);
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nombre, description: descripcion, image, message, signature }),
    });
    const datos = await res.json().catch(() => ({ error: `El servidor respondió ${res.status}` }));
    if (!res.ok) throw new Error(datos.error);
    toast(`🖼️ Imagen en IPFS: <a href="${toHttp(datos.image)}" target="_blank" rel="noopener">ver</a>`, "ok");
    return datos.uri;
  } finally {
    t.remove();
  }
}

// ------------------------------------------------------------ historial
const DESCRIPCION = {
  EventCreated: (a) => `Evento #${a.eventId} creado: ${esc(a.name)} (${eth(a.price)})`,
  EventCanceled: (a) => `Evento #${a.eventId} cancelado`,
  TicketPurchased: (a) => `${linkAddr(a.buyer)} compró el boleto #${a.tokenId} del evento #${a.eventId} por ${eth(a.price)}`,
  ResaleListed: (a) => `${linkAddr(a.seller)} puso el boleto #${a.tokenId} en reventa por ${eth(a.price)}`,
  ResaleCanceled: (a) => `Boleto #${a.tokenId} retirado de reventa`,
  ResaleSold: (a) => `${linkAddr(a.buyer)} compró en reventa el boleto #${a.tokenId} a ${linkAddr(a.seller)} por ${eth(a.price)} (comisión ${eth(a.fee)})`,
  CheckedIn: (a) => `Boleto #${a.tokenId} validado en la entrada por ${linkAddr(a.staff)}`,
  Refunded: (a) => `${linkAddr(a.holder)} recibió reembolso de ${eth(a.amount)} (boleto #${a.tokenId})`,
  BalanceWithdrawn: (a) => `${linkAddr(a.account)} retiró ${eth(a.amount)} de sus reventas`,
  SentToTreasury: (a) => `Evento #${a.eventId}: ${eth(a.amount)} enviados a la tesorería`,
  StaffUpdated: (a) => `${linkAddr(a.account)} ${a.enabled ? "ahora es staff" : "ya no es staff"}`,
  TreasuryChanged: (a) => `Nueva tesorería: ${linkAddr(a.treasury)}`,
};

async function pintarHistorial() {
  const cont = $("#listaHistorial");
  cont.innerHTML = `<p class="muted">Leyendo eventos…</p>`;
  try {
    const fin = await lector.getBlockNumber();
    const logs = [];
    // Los nodos publicos limitan el rango de bloques por consulta: se lee en partes
    for (let desde = RED.deployBlock || 0; desde <= fin; desde += 40000) {
      logs.push(...(await B().queryFilter("*", desde, Math.min(desde + 39999, fin))));
    }
    const soloMios = $("#soloMios").checked && state.account;
    const filas = logs
      .filter((l) => l.fragment && DESCRIPCION[l.fragment.name])
      .filter((l) => !soloMios || l.args.some((v) => typeof v === "string" && mismo(v, state.account)))
      .reverse()
      .slice(0, 100);
    cont.innerHTML = filas.length
      ? filas.map((l) => `<div class="historial-item"><span class="tipo">${l.fragment.name}</span><span>${DESCRIPCION[l.fragment.name](l.args)} · <span class="muted">bloque ${l.blockNumber}</span> ${linkTx(l.transactionHash)}</span></div>`).join("")
      : `<p class="muted">Sin eventos todavía.</p>`;
  } catch (e) {
    cont.innerHTML = `<p class="estado bad">No se pudo leer el historial: ${esc(mensajeError(e))}</p>`;
  }
}

// ------------------------------------------------------------ eventos de la pagina
function conectarUI() {
  $("#btnConectar").onclick = conectar;

  $("#tabs").onclick = (ev) => {
    const b = ev.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === b.dataset.tab));
    if (b.dataset.tab === "historial") pintarHistorial();
  };
  $("#soloMios").onchange = pintarHistorial;

  // Botones dentro de las tarjetas (delegacion)
  document.body.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.comprar !== undefined) {
      const e = state.events[Number(d.comprar)];
      await enviar(`Comprar boleto para ${e.name}`, () => escritura("Boletera").buyTicket(e.id, { value: e.price }));
    } else if (d.comprarReventa) {
      await enviar(`Comprar boleto #${d.comprarReventa} en reventa`, () => escritura("Boletera").buyResale(d.comprarReventa, { value: BigInt(d.precio) }));
    } else if (d.cancelarReventa) {
      await enviar(`Quitar de reventa el boleto #${d.cancelarReventa}`, () => escritura("Boletera").cancelListing(d.cancelarReventa));
    } else if (d.reembolso) {
      await enviar(`Reembolso del boleto #${d.reembolso}`, () => escritura("Boletera").claimRefund(d.reembolso));
    } else if (d.cancelarEvento !== undefined) {
      if (!confirm("¿Cancelar el evento? Cada comprador podrá pedir su reembolso.")) return;
      await enviar(`Cancelar evento #${d.cancelarEvento}`, () => escritura("Boletera").cancelEvent(d.cancelarEvento));
    } else if (d.retirarEvento !== undefined) {
      await enviar(`Enviar a tesorería lo del evento #${d.retirarEvento}`, () => escritura("Boletera").withdrawToTreasury(d.retirarEvento));
    } else if (b.id === "btnRetirar") {
      await enviar("Retirar saldo de reventas", () => escritura("Boletera").withdrawBalance());
    }
  });

  document.body.addEventListener("submit", async (ev) => {
    const f = ev.target;
    if (!f.dataset.revender) return;
    ev.preventDefault();
    const precio = ethers.parseEther(f.precio.value);
    await enviar(`Revender boleto #${f.dataset.revender}`, () => escritura("Boletera").listForResale(f.dataset.revender, precio));
  });

  $("#btnRevisar").onclick = () => {
    const id = $("#formCheckin").tokenId.value;
    if (id) revisarBoleto(id);
  };
  $("#formCheckin").onsubmit = async (ev) => {
    ev.preventDefault();
    const id = ev.target.tokenId.value;
    if (await enviar(`Validar entrada del boleto #${id}`, () => escritura("Boletera").checkIn(id))) revisarBoleto(id);
  };

  $("#formEvento").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const ts = Math.floor(new Date(f.fecha.value).getTime() / 1000);
    if (ts <= ahora()) return toast("La fecha debe ser en el futuro", "bad");
    let uri = "";
    const file = f.imagen.files[0];
    if (file) {
      try {
        uri = await subirImagen(f.nombre.value, f.descripcion.value, file);
      } catch (e) {
        if (!confirm(`No se pudo subir la imagen (${mensajeError(e)}). ¿Crear el evento sin imagen?`)) return;
      }
    }
    const ok = await enviar(`Crear evento ${f.nombre.value}`, () =>
      escritura("Boletera").createEvent(f.nombre.value, ts, ethers.parseEther(f.precio.value), f.cupo.value, f.tope.value, uri)
    );
    if (ok) f.reset();
  };

  $("#formStaff").onsubmit = async (ev) => {
    ev.preventDefault();
    const valor = ev.submitter?.dataset.valor === "true";
    const cuenta = ev.target.cuenta.value.trim();
    if (!ethers.isAddress(cuenta)) return toast("Dirección inválida", "bad");
    if (await enviar(`${valor ? "Agregar" : "Quitar"} staff ${short(cuenta)}`, () => escritura("Boletera").setStaff(cuenta, valor))) ev.target.reset();
  };

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", configurarCuenta);
    window.ethereum.on?.("chainChanged", configurarCuenta);
  }
}

// ------------------------------------------------------------ arranque
async function iniciar() {
  if (!RED || !RED.addresses) {
    aviso("No hay contratos configurados. Corre <code>npm run deploy:sepolia</code> (o <code>deploy:local</code>) y recarga.");
    return;
  }
  $("#red").textContent = RED.name;
  $("#pie").innerHTML = `Boletera ${linkAddr(RED.addresses.Boletera)} · TicketNFT ${linkAddr(RED.addresses.TicketNFT)} · Tesorería ${linkAddr(RED.addresses.MultiSignWallet)}`;
  lector = new ethers.JsonRpcProvider(RED.rpc, RED.chainId, { staticNetwork: true });
  crearContratos(lector);
  conectarUI();

  if (!window.ethereum) {
    mostrarSinMetaMask(false);
    await refrescar();
    return;
  }
  await configurarCuenta(); // si ya habia dado permiso antes, entra directo
}

iniciar();
