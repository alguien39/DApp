# BoletoTEC: boletera descentralizada con NFTs

Proyecto de ejemplo del Parcial 3. Cada boleto es un NFT. La reventa tiene precio máximo y el staff valida la entrada en la puerta. Si se cancela un evento hay reembolsos, y lo recaudado se va a una tesorería multifirma. El sitio se publica en **Vercel** y se usa con MetaMask, en la computadora o en el celular.

## Arquitectura

```text
            ┌──────────────── navegador / app MetaMask ────────────────┐
            │  web/index.html + app.js (ethers v6)                     │
            └──────┬──────────────────────────────┬────────────────────┘
                   │ lee y firma tx                │ POST /api/upload (firmado)
                   ▼                               ▼
   ┌────────────── Sepolia ──────────────┐   web/api/upload.js (Vercel)
   │ Boletera ──mint/mover/usar──► TicketNFT │        │ PINATA_JWT (variable de entorno)
   │    │                                 │        ▼
   │    └──withdrawToTreasury──► MultiSignWallet │   Pinata / IPFS (imagen + metadata)
   └──────────────────────────────────────┘
```

| Contrato | Rol |
|---|---|
| `TicketNFT` (ERC-721 + Enumerable + URIStorage) | Cada boleto es un NFT. Solo la Boletera (el *minter*) puede crear, mover, marcar como usado o quemar boletos, así que no se pueden transferir directo desde la wallet. |
| `Boletera` (Ownable + ReentrancyGuard) | Eventos, compra, reventa con tope y comisión, check-in, cancelación, reembolsos y envío a la tesorería. |
| `MultiSignWallet` | Tesorería (la misma del Parcial 2). Recibe lo recaudado; para sacar dinero hacen falta aprobaciones. |

### Funciones de `Boletera`

| Quién | Función | Qué hace |
|---|---|---|
| Owner | `createEvent(name, date, price, capacity, maxResalePct, uri)` | Crea un evento. `maxResalePct` va de 100 a 200 (120 = la reventa puede costar hasta 120 %). |
| Owner | `cancelEvent(id)` | Cancela un evento antes de que empiece. |
| Owner | `setStaff(cuenta, bool)` | Da o quita permiso de check-in. |
| Owner | `withdrawToTreasury(id)` | Manda lo recaudado a la MultiSignWallet cuando termina el evento, o, si se canceló, cuando ya se hicieron todos los reembolsos. |
| Público | `buyTicket(id)` *payable* | Compra un boleto al precio exacto y recibe el NFT. |
| Público | `listForResale(tokenId, precio)` / `cancelListing` | Publica o quita un boleto de la reventa, con el tope de precio. |
| Público | `buyResale(tokenId)` *payable* | Compra en reventa. El organizador cobra la comisión (`resaleFeePct`) y el vendedor recibe el resto como saldo. |
| Público | `withdrawBalance()` | El vendedor retira su saldo (*pull payment*). |
| Público | `claimRefund(tokenId)` | Si el evento se canceló, devuelve el precio original y quema el NFT. |
| Staff | `checkIn(tokenId)` | Marca el boleto como usado, de 6 h antes del inicio a 12 h después. |
| Consulta | `getEvents()`, `getEventInfo(id)`, `getListings()`, `ticket.ticketsOf(cuenta)` | Las usa el sitio. |

## Instalación

```bash
npm install
cp .env.example .env      # y llenar los valores
npx hardhat test          # 36 pruebas
npx hardhat coverage      # cobertura
```

## Probar en local

```bash
npx hardhat node          # terminal 1
npm run deploy:local      # terminal 2: despliega y genera web/contracts.js
npm run seed:local        # eventos de ejemplo
npm run web               # http://localhost:5173
```

En MetaMask, agrega la red *Hardhat Local* (RPC `http://127.0.0.1:8545`, chain id `31337`) e importa la cuenta #0 que imprime `npx hardhat node`.

## Sepolia

```bash
npm run deploy:sepolia    # guarda deployments/sepolia.json y regenera web/contracts.js
npm run verify:sepolia    # verifica los 3 contratos en Etherscan
npm run seed:sepolia      # opcional: eventos de ejemplo
```

| Contrato | Dirección (Sepolia) |
|---|---|
| Boletera | _llenar después del deploy_ |
| TicketNFT | _llenar después del deploy_ |
| MultiSignWallet | _llenar después del deploy_ |

## Publicar en Vercel

1. Sube el repositorio a GitHub. `web/contracts.js` sí se sube: solo tiene direcciones y ABI.
2. En Vercel: **Add New → Project →** importar el repositorio.
   - **Root Directory:** `web`
   - **Framework Preset:** Other
3. En **Environment Variables**, agregar:
   - `PINATA_JWT`
   - `ADMIN_ADDRESSES`: tu dirección; si son varias, separadas por coma.
4. Presionar **Deploy**. Cada `git push` vuelve a publicar.

En el celular, abre la URL **dentro de la app de MetaMask** (pestaña Explorar). Si abren el sitio en Safari o Chrome, aparece el botón *Abrir en MetaMask*.

## Seguridad

- [x] Sin llaves privadas en el repositorio: el `.env` está en `.gitignore`. El JWT de Pinata vive solo en las variables de entorno de Vercel.
- [x] Las funciones de administración usan `onlyOwner`, el check-in usa `onlyStaff` y los boletos solo los mueve la Boletera (`onlyMinter`).
- [x] *Checks → effects → interactions* y `nonReentrant` en todas las funciones que envían ether.
- [x] *Pull payments*: el revendedor retira su saldo con `withdrawBalance()`, así un receptor que revierte no bloquea una venta.
- [x] Validaciones de entrada:
  - fechas futuras;
  - precio y cupo mayores a 0;
  - tope de reventa entre 100 y 200;
  - `address(0)`;
  - pago con monto exacto.
- [x] Loops: `getEvents` y `getListings` solo son lectura (`view`). Los eventos solo los crea el owner y los boletos están limitados por el cupo.
- [x] `/api/upload` exige una firma de MetaMask de una cuenta en `ADMIN_ADDRESSES`, de menos de 10 minutos.
- Datos públicos: todo lo que está en la cadena se puede ver, incluidas las compras, quién tiene cada boleto y los precios. Las imágenes en IPFS también son públicas.
