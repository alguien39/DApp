// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title TicketNFT - cada boleto de BoletoTEC es un NFT (ERC-721)
/// @notice Solo la Boletera (minter) puede crear, mover, marcar como usado o quemar boletos.
///         Asi la reventa pasa siempre por la Boletera y se respeta el tope de precio.
contract TicketNFT is ERC721, ERC721Enumerable, ERC721URIStorage, Ownable {
    address public minter;
    uint256 public nextTokenId = 1;

    mapping(uint256 => uint256) public eventOf; // tokenId => id del evento
    mapping(uint256 => bool) public used;       // tokenId => ya entro al evento

    event MinterChanged(address indexed minter);
    event TicketMinted(uint256 indexed tokenId, uint256 indexed eventId, address indexed to);
    event TicketUsed(uint256 indexed tokenId);

    modifier onlyMinter() {
        require(msg.sender == minter, "Solo la boletera");
        _;
    }

    constructor() ERC721("BoletoTEC", "BTEC") Ownable(msg.sender) {}

    /// @notice Se llama una vez despues de desplegar la Boletera
    function setMinter(address _minter) external onlyOwner {
        require(_minter != address(0), "Minter invalido");
        minter = _minter;
        emit MinterChanged(_minter);
    }

    function mint(address to, uint256 eventId, string calldata uri) external onlyMinter returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        eventOf[tokenId] = eventId;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        emit TicketMinted(tokenId, eventId, to);
    }

    function markUsed(uint256 tokenId) external onlyMinter {
        _requireOwned(tokenId);
        require(!used[tokenId], "Boleto ya usado");
        used[tokenId] = true;
        emit TicketUsed(tokenId);
    }

    /// @notice Reventa: la Boletera mueve el boleto del vendedor al comprador
    function resaleTransfer(address from, address to, uint256 tokenId) external onlyMinter {
        _transfer(from, to, tokenId);
    }

    /// @notice Reembolso: el boleto se destruye
    function burn(uint256 tokenId) external onlyMinter {
        _burn(tokenId);
    }

    /// @notice Todos los boletos de una cuenta
    function ticketsOf(address owner) external view returns (uint256[] memory ids) {
        uint256 n = balanceOf(owner);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = tokenOfOwnerByIndex(owner, i);
    }

    // ------------------------------------------------- reglas de transferencia
    // Mint (from = 0) y burn (to = 0) ya estan protegidos por onlyMinter.
    // Una transferencia normal (transferFrom / safeTransferFrom) desde la wallet del usuario se bloquea:
    // solo la Boletera puede mover boletos entre cuentas.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            require(msg.sender == minter, "Transferir solo con la reventa de la boletera");
        }
        return super._update(to, tokenId, auth);
    }

    // ------------------------------------- overrides que pide OpenZeppelin 5
    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
