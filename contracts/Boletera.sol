// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./TicketNFT.sol";

/// @title Boletera - venta, reventa con tope, check-in y reembolsos de BoletoTEC
/// @notice Flujo: el owner crea eventos -> el publico compra boletos (NFT) -> los puede revender
///         con un precio maximo -> el staff valida la entrada -> lo recaudado se manda a la
///         tesoreria (MultiSignWallet). Si el evento se cancela, cada quien pide su reembolso.
contract Boletera is Ownable, ReentrancyGuard {
    // Ventana del check-in alrededor de la fecha del evento
    uint256 public constant DOORS_OPEN = 6 hours;  // antes del inicio
    uint256 public constant DOORS_CLOSE = 12 hours; // despues del inicio
    uint256 public constant MAX_FEE_PCT = 20;

    TicketNFT public immutable ticket;
    address public treasury;
    uint256 public resaleFeePct; // % de cada reventa que se queda el organizador

    struct Event {
        string name;
        uint256 date;          // timestamp de inicio
        uint256 price;         // wei
        uint256 capacity;
        uint256 sold;
        uint256 refunded;
        uint256 maxResalePct;  // 120 = la reventa puede costar hasta 120 % del precio original
        uint256 collected;     // wei de este evento que siguen en el contrato
        bool canceled;
        bool withdrawn;
        string uri;            // metadata en IPFS (nombre, imagen...)
    }

    struct Listing {
        address seller;
        uint256 price;
    }

    Event[] private events;
    mapping(uint256 => Listing) public listings;     // tokenId => reventa activa
    mapping(address => uint256) public balances;     // pull payments de los revendedores
    mapping(address => bool) public isStaff;

    event EventCreated(uint256 indexed eventId, string name, uint256 date, uint256 price, uint256 capacity);
    event EventCanceled(uint256 indexed eventId);
    event TicketPurchased(uint256 indexed eventId, uint256 indexed tokenId, address indexed buyer, uint256 price);
    event ResaleListed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event ResaleCanceled(uint256 indexed tokenId);
    event ResaleSold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event CheckedIn(uint256 indexed eventId, uint256 indexed tokenId, address indexed staff);
    event Refunded(uint256 indexed eventId, uint256 indexed tokenId, address indexed holder, uint256 amount);
    event BalanceWithdrawn(address indexed account, uint256 amount);
    event SentToTreasury(uint256 indexed eventId, address indexed treasury, uint256 amount);
    event StaffUpdated(address indexed account, bool enabled);
    event TreasuryChanged(address indexed treasury);

    modifier onlyStaff() {
        require(isStaff[msg.sender] || msg.sender == owner(), "Solo staff");
        _;
    }

    modifier eventExists(uint256 eventId) {
        require(eventId < events.length, "Evento inexistente");
        _;
    }

    constructor(address _ticket, address _treasury, uint256 _resaleFeePct) Ownable(msg.sender) {
        require(_ticket != address(0) && _treasury != address(0), "Direccion invalida");
        require(_resaleFeePct <= MAX_FEE_PCT, "Comision muy alta");
        ticket = TicketNFT(_ticket);
        treasury = _treasury;
        resaleFeePct = _resaleFeePct;
    }

    // ================================================================ owner
    function createEvent(
        string calldata name,
        uint256 date,
        uint256 price,
        uint256 capacity,
        uint256 maxResalePct,
        string calldata uri
    ) external onlyOwner returns (uint256 eventId) {
        require(bytes(name).length > 0, "Nombre vacio");
        require(date > block.timestamp, "La fecha ya paso");
        require(price > 0, "Precio debe ser > 0");
        require(capacity > 0, "Cupo debe ser > 0");
        require(maxResalePct >= 100 && maxResalePct <= 200, "Tope de reventa entre 100 y 200");

        events.push();
        eventId = events.length - 1;
        Event storage e = events[eventId];
        e.name = name;
        e.date = date;
        e.price = price;
        e.capacity = capacity;
        e.maxResalePct = maxResalePct;
        e.uri = uri;
        emit EventCreated(eventId, name, date, price, capacity);
    }

    function cancelEvent(uint256 eventId) external onlyOwner eventExists(eventId) {
        Event storage e = events[eventId];
        require(!e.canceled, "Evento cancelado");
        require(block.timestamp < e.date, "El evento ya empezo");
        e.canceled = true;
        emit EventCanceled(eventId);
    }

    function setStaff(address account, bool enabled) external onlyOwner {
        require(account != address(0), "Direccion invalida");
        isStaff[account] = enabled;
        emit StaffUpdated(account, enabled);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Direccion invalida");
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    /// @notice Manda lo recaudado de un evento a la tesoreria (MultiSignWallet).
    ///         Evento normal: cuando ya cerraron puertas. Cancelado: cuando todos tienen su reembolso.
    function withdrawToTreasury(uint256 eventId) external onlyOwner eventExists(eventId) nonReentrant {
        Event storage e = events[eventId];
        require(!e.withdrawn, "Ya se retiro");
        if (e.canceled) {
            require(e.refunded == e.sold, "Faltan reembolsos");
        } else {
            require(block.timestamp > e.date + DOORS_CLOSE, "El evento no ha terminado");
        }
        uint256 amount = e.collected;
        require(amount > 0, "Nada que retirar");

        // checks -> effects -> interactions
        e.withdrawn = true;
        e.collected = 0;
        (bool ok, ) = payable(treasury).call{value: amount}("");
        require(ok, "Fallo el envio a tesoreria");
        emit SentToTreasury(eventId, treasury, amount);
    }

    // ============================================================== publico
    function buyTicket(uint256 eventId) external payable eventExists(eventId) nonReentrant returns (uint256 tokenId) {
        Event storage e = events[eventId];
        require(!e.canceled, "Evento cancelado");
        require(block.timestamp < e.date, "La venta ya cerro");
        require(e.sold < e.capacity, "Agotado");
        require(msg.value == e.price, "Monto incorrecto");

        e.sold++;
        e.collected += msg.value;
        tokenId = ticket.mint(msg.sender, eventId, e.uri);
        emit TicketPurchased(eventId, tokenId, msg.sender, msg.value);
    }

    function listForResale(uint256 tokenId, uint256 price) external {
        require(ticket.ownerOf(tokenId) == msg.sender, "No es tu boleto");
        require(!ticket.used(tokenId), "Boleto ya usado");
        Event storage e = events[ticket.eventOf(tokenId)];
        require(!e.canceled, "Evento cancelado");
        require(block.timestamp < e.date, "El evento ya empezo");
        require(price > 0, "Precio debe ser > 0");
        require(price <= (e.price * e.maxResalePct) / 100, "Supera el tope de reventa");

        listings[tokenId] = Listing(msg.sender, price);
        emit ResaleListed(tokenId, msg.sender, price);
    }

    function cancelListing(uint256 tokenId) external {
        require(listings[tokenId].seller == msg.sender, "No es tu reventa");
        delete listings[tokenId];
        emit ResaleCanceled(tokenId);
    }

    function buyResale(uint256 tokenId) external payable nonReentrant {
        Listing memory l = listings[tokenId];
        require(l.seller != address(0), "No esta en reventa");
        require(msg.sender != l.seller, "Ya es tuyo");
        require(msg.value == l.price, "Monto incorrecto");
        // Si el vendedor ya no tiene el boleto la reventa quedo vieja
        require(ticket.ownerOf(tokenId) == l.seller, "Reventa invalida");
        Event storage e = events[ticket.eventOf(tokenId)];
        require(!e.canceled, "Evento cancelado");
        require(block.timestamp < e.date, "El evento ya empezo");

        uint256 fee = (msg.value * resaleFeePct) / 100;
        delete listings[tokenId];
        e.collected += fee;
        balances[l.seller] += msg.value - fee; // el vendedor retira despues (pull payment)
        ticket.resaleTransfer(l.seller, msg.sender, tokenId);
        emit ResaleSold(tokenId, l.seller, msg.sender, msg.value, fee);
    }

    function withdrawBalance() external nonReentrant {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "Sin saldo");
        balances[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Fallo el envio");
        emit BalanceWithdrawn(msg.sender, amount);
    }

    /// @notice El staff valida la entrada: solo de 6 h antes a 12 h despues del inicio
    function checkIn(uint256 tokenId) external onlyStaff {
        ticket.ownerOf(tokenId); // revierte si el boleto no existe
        uint256 eventId = ticket.eventOf(tokenId);
        Event storage e = events[eventId];
        require(!e.canceled, "Evento cancelado");
        require(block.timestamp + DOORS_OPEN >= e.date, "Aun no abren puertas");
        require(block.timestamp <= e.date + DOORS_CLOSE, "Ya cerraron puertas");
        delete listings[tokenId]; // un boleto usado ya no se puede revender
        ticket.markUsed(tokenId);  // revierte si ya se uso
        emit CheckedIn(eventId, tokenId, msg.sender);
    }

    /// @notice Si el evento se cancelo, quien tenga el boleto recupera el precio original
    function claimRefund(uint256 tokenId) external nonReentrant {
        require(ticket.ownerOf(tokenId) == msg.sender, "No es tu boleto");
        uint256 eventId = ticket.eventOf(tokenId);
        Event storage e = events[eventId];
        require(e.canceled, "El evento no se cancelo");

        uint256 amount = e.price;
        e.refunded++;
        e.collected -= amount;
        delete listings[tokenId];
        ticket.burn(tokenId); // sin boleto no hay segundo reembolso
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Fallo el reembolso");
        emit Refunded(eventId, tokenId, msg.sender, amount);
    }

    // ============================================================ consultas
    function eventCount() external view returns (uint256) {
        return events.length;
    }

    function getEventInfo(uint256 eventId) external view eventExists(eventId) returns (Event memory) {
        return events[eventId];
    }

    /// @notice Lista completa. Solo el owner agrega eventos, asi que el arreglo no crece sin control.
    function getEvents() external view returns (Event[] memory) {
        return events;
    }

    /// @notice Boletos en reventa (recorre los boletos emitidos; el total esta limitado por los cupos)
    function getListings() external view returns (uint256[] memory ids, Listing[] memory items) {
        uint256 last = ticket.nextTokenId();
        uint256 count;
        for (uint256 id = 1; id < last; id++) if (listings[id].seller != address(0)) count++;
        ids = new uint256[](count);
        items = new Listing[](count);
        uint256 j;
        for (uint256 id = 1; id < last; id++) {
            if (listings[id].seller != address(0)) {
                ids[j] = id;
                items[j] = listings[id];
                j++;
            }
        }
    }
}
