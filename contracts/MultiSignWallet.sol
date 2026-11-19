// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MultiSignWallet - tesoreria de BoletoTEC
/// @notice La misma multifirma del Parcial 2 (Practica 3): recibe lo recaudado por la Boletera y
///         solo saca dinero con las aprobaciones de sus owners. Con un solo owner y
///         requiredApprovals = 1 funciona para una persona.
contract MultiSignWallet is ReentrancyGuard {
    // ---------------------------------------------------------------- owners
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public requiredApprovals;

    // ---------------------------------------------------------- transacciones
    struct Transaction {
        address to;
        uint256 amount;
        uint256 approvalCount;
        bool executed;
        address proposer;  // quien la propuso
        uint256 expiresAt; // despues de esta fecha ya no se aprueba ni se ejecuta
        bool canceled;
    }

    Transaction[] public transactions;
    // txId => owner => aprobado?
    mapping(uint256 => mapping(address => bool)) public approvals;
    // txId => owner => momento de la aprobacion
    mapping(uint256 => mapping(address => uint256)) public approvalTimestamps;

    // limite de ETH que se puede ejecutar por dia (0 = sin limite)
    uint256 public immutable dailyLimit;
    mapping(uint256 => uint256) public spentOnDay; // dia => wei ejecutados

    // ------------------------------------------------ reparto (como Pagos.sol)
    address[] public payees;
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    // ---------------------------------------------------------------- eventos
    event Deposit(address indexed sender, uint256 amount);
    event TransactionSubmitted(uint256 indexed txId, address indexed to, uint256 amount, uint256 expiresAt);
    event TransactionCanceled(uint256 indexed txId, address indexed proposer);
    event TransactionApproved(uint256 indexed txId, address indexed owner);
    event ApprovalRevoked(uint256 indexed txId, address indexed owner);
    event TransactionExecuted(uint256 indexed txId, address indexed to, uint256 amount);
    event PaymentReleased(address indexed payee, uint256 amount);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not an owner");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactions.length, "Transaccion inexistente");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "Already executed");
        _;
    }

    // la transaccion no debe estar cancelada ni expirada
    modifier active(uint256 txId) {
        require(!transactions[txId].canceled, "Transaccion cancelada");
        require(block.timestamp <= transactions[txId].expiresAt, "Transaccion expirada");
        _;
    }

    constructor(
        address[] memory _owners,
        uint256 _requiredApprovals,
        address[] memory _payees,
        uint256[] memory _shares,
        uint256 _dailyLimit
    ) {
        dailyLimit = _dailyLimit;
        require(_owners.length > 0, "Must have owners");
        require(
            _requiredApprovals > 0 && _requiredApprovals <= _owners.length,
            "Invalid approvals"
        );
        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            require(owner != address(0), "Invalid owner");
            require(!isOwner[owner], "Owner not unique");
            isOwner[owner] = true;
            owners.push(owner);
        }
        requiredApprovals = _requiredApprovals;

        require(_payees.length == _shares.length, "Length mismatch");
        require(_payees.length > 0, "No payees");
        for (uint256 i = 0; i < _payees.length; i++) {
            require(_payees[i] != address(0), "Invalid payee");
            require(_shares[i] > 0, "Shares must be > 0");
            require(shares[_payees[i]] == 0, "Payee duplicado");
            payees.push(_payees[i]);
            shares[_payees[i]] = _shares[i];
            totalShares += _shares[i];
        }
    }

    // --------------------------------------------------------------- fondos
    function deposit() external payable {
        require(msg.value > 0, "Must send ether");
        emit Deposit(msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // -------------------------------------------------------- transacciones
    // _duration = segundos que la transaccion sigue vigente
    function submitTransaction(address _to, uint256 _amount, uint256 _duration) external onlyOwner returns (uint256) {
        require(_to != address(0), "Invalid target");
        require(_amount > 0, "Amount must be > 0");
        require(_duration > 0, "Duracion invalida");

        uint256 expiresAt = block.timestamp + _duration;
        transactions.push(Transaction({
            to: _to, amount: _amount, approvalCount: 0, executed: false,
            proposer: msg.sender, expiresAt: expiresAt, canceled: false
        }));
        uint256 txId = transactions.length - 1;
        emit TransactionSubmitted(txId, _to, _amount, expiresAt);
        return txId;
    }

    // solo quien la propuso puede cancelarla, mientras no se ejecute
    function cancelTransaction(uint256 _txId) external onlyOwner txExists(_txId) notExecuted(_txId) {
        Transaction storage transaction = transactions[_txId];
        require(msg.sender == transaction.proposer, "Solo quien la propuso");
        require(!transaction.canceled, "Transaccion cancelada");
        transaction.canceled = true;
        emit TransactionCanceled(_txId, msg.sender);
    }

    function approveTransaction(uint256 _txId)
        external
        onlyOwner
        txExists(_txId)
        notExecuted(_txId)
        active(_txId)
    {
        require(!approvals[_txId][msg.sender], "Already approved");

        approvals[_txId][msg.sender] = true;
        approvalTimestamps[_txId][msg.sender] = block.timestamp;
        transactions[_txId].approvalCount++;
        emit TransactionApproved(_txId, msg.sender);
    }

    function revokeApproval(uint256 _txId)
        external
        onlyOwner
        txExists(_txId)
        notExecuted(_txId)
    {
        require(approvals[_txId][msg.sender], "Not approved");

        approvals[_txId][msg.sender] = false;
        approvalTimestamps[_txId][msg.sender] = 0;
        transactions[_txId].approvalCount--;
        emit ApprovalRevoked(_txId, msg.sender);
    }

    function executeTransaction(uint256 _txId)
        external
        onlyOwner
        txExists(_txId)
        notExecuted(_txId)
        active(_txId)
        nonReentrant
    {
        Transaction storage transaction = transactions[_txId];
        require(transaction.approvalCount >= requiredApprovals, "Not enough approvals");
        require(address(this).balance >= transaction.amount, "Fondos insuficientes");

        // limite diario
        uint256 day = block.timestamp / 1 days;
        require(dailyLimit == 0 || spentOnDay[day] + transaction.amount <= dailyLimit, "Limite diario excedido");
        spentOnDay[day] += transaction.amount;

        // Checks -> Effects -> Interactions
        transaction.executed = true;
        (bool success, ) = payable(transaction.to).call{value: transaction.amount}("");
        require(success, "Transfer failed");

        emit TransactionExecuted(_txId, transaction.to, transaction.amount);
    }

    /// @notice Reparte TODO el balance entre los payees segun sus shares
    function releasePayments() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to release");

        for (uint256 i = 0; i < payees.length; i++) {
            address payee = payees[i];
            uint256 payment = (balance * shares[payee]) / totalShares;
            (bool success, ) = payee.call{value: payment}("");
            require(success, "Payment failed");
            emit PaymentReleased(payee, payment);
        }
    }

    // ------------------------------------------------------------- consultas
    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getPayees() external view returns (address[] memory) {
        return payees;
    }

    function getTransactions() external view returns (Transaction[] memory) {
        return transactions;
    }

    function getTransactionCount() external view returns (uint256) {
        return transactions.length;
    }

    // cuanto se puede ejecutar todavia hoy
    function remainingToday() external view returns (uint256) {
        if (dailyLimit == 0) return type(uint256).max;
        uint256 spent = spentOnDay[block.timestamp / 1 days];
        return spent >= dailyLimit ? 0 : dailyLimit - spent;
    }

    // ids de las transacciones que aun se pueden aprobar o ejecutar
    function getPendingTransactions() external view returns (uint256[] memory ids) {
        uint256 count;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (_isPending(i)) count++;
        }
        ids = new uint256[](count);
        uint256 index;
        for (uint256 i = 0; i < transactions.length; i++) {
            if (_isPending(i)) ids[index++] = i;
        }
    }

    function _isPending(uint256 i) internal view returns (bool) {
        Transaction storage t = transactions[i];
        return !t.executed && !t.canceled && block.timestamp <= t.expiresAt;
    }

    /// @notice Lista de owners que aprobaron `txId` y el momento de cada aprobacion
    function getApproversWithTimestamps(uint256 txId)
        external
        view
        txExists(txId)
        returns (address[] memory approvers, uint256[] memory timestamps)
    {
        uint256 count;
        for (uint256 i = 0; i < owners.length; i++) {
            if (approvals[txId][owners[i]]) count++;
        }

        approvers = new address[](count);
        timestamps = new uint256[](count);
        uint256 index;
        for (uint256 i = 0; i < owners.length; i++) {
            if (approvals[txId][owners[i]]) {
                approvers[index] = owners[i];
                timestamps[index] = approvalTimestamps[txId][owners[i]];
                index++;
            }
        }
    }
}
