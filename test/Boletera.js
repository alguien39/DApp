const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const PRICE = ethers.parseEther("0.01");
const HOUR = 3600;
const DAY = 24 * HOUR;

describe("BoletoTEC", function () {
  async function deployFixture() {
    const [owner, alice, bob, staff, otro] = await ethers.getSigners();

    const Wallet = await ethers.getContractFactory("MultiSignWallet");
    const treasury = await Wallet.deploy([owner.address], 1, [owner.address], [100], 0);

    const ticket = await ethers.deployContract("TicketNFT");
    const boletera = await ethers.deployContract("Boletera", [ticket.target, treasury.target, 5]);
    await ticket.setMinter(boletera.target);

    // Evento 0: en 3 dias, cupo 3, reventa hasta 120 %
    const date = (await time.latest()) + 3 * DAY;
    await boletera.createEvent("Concierto TEC", date, PRICE, 3, 120, "ipfs://evento0");

    return { owner, alice, bob, staff, otro, treasury, ticket, boletera, date };
  }

  async function withTicketFixture() {
    const f = await deployFixture();
    await f.boletera.connect(f.alice).buyTicket(0, { value: PRICE }); // tokenId 1
    return f;
  }

  describe("Despliegue", function () {
    it("conecta la boletera con el NFT y la tesoreria", async function () {
      const { ticket, boletera, treasury, owner } = await loadFixture(deployFixture);
      expect(await ticket.minter()).to.equal(boletera.target);
      expect(await boletera.treasury()).to.equal(treasury.target);
      expect(await boletera.owner()).to.equal(owner.address);
      expect(await boletera.resaleFeePct()).to.equal(5);
    });

    it("rechaza direcciones cero y comision mayor al maximo", async function () {
      const { ticket, treasury } = await loadFixture(deployFixture);
      const Boletera = await ethers.getContractFactory("Boletera");
      await expect(Boletera.deploy(ethers.ZeroAddress, treasury.target, 5)).to.be.revertedWith("Direccion invalida");
      await expect(Boletera.deploy(ticket.target, treasury.target, 21)).to.be.revertedWith("Comision muy alta");
    });

    it("solo el owner del NFT cambia el minter y no acepta address(0)", async function () {
      const { ticket, alice } = await loadFixture(deployFixture);
      await expect(ticket.connect(alice).setMinter(alice.address)).to.be.revertedWithCustomError(ticket, "OwnableUnauthorizedAccount");
      await expect(ticket.setMinter(ethers.ZeroAddress)).to.be.revertedWith("Minter invalido");
    });

    it("nadie mas que la boletera puede mintear, marcar o quemar", async function () {
      const { ticket, alice } = await loadFixture(deployFixture);
      await expect(ticket.connect(alice).mint(alice.address, 0, "x")).to.be.revertedWith("Solo la boletera");
      await expect(ticket.markUsed(1)).to.be.revertedWith("Solo la boletera");
      await expect(ticket.burn(1)).to.be.revertedWith("Solo la boletera");
      await expect(ticket.resaleTransfer(alice.address, alice.address, 1)).to.be.revertedWith("Solo la boletera");
    });
  });

  describe("Eventos", function () {
    it("crea un evento y emite EventCreated", async function () {
      const { boletera, date } = await loadFixture(deployFixture);
      await expect(boletera.createEvent("Feria", date, PRICE, 10, 100, ""))
        .to.emit(boletera, "EventCreated")
        .withArgs(1, "Feria", date, PRICE, 10);
      expect(await boletera.eventCount()).to.equal(2);
      expect((await boletera.getEvents()).length).to.equal(2);
      const e = await boletera.getEventInfo(0);
      expect(e.name).to.equal("Concierto TEC");
      expect(e.capacity).to.equal(3);
    });

    it("valida los datos del evento", async function () {
      const { boletera, date } = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(boletera.createEvent("", date, PRICE, 1, 100, "")).to.be.revertedWith("Nombre vacio");
      await expect(boletera.createEvent("X", now, PRICE, 1, 100, "")).to.be.revertedWith("La fecha ya paso");
      await expect(boletera.createEvent("X", date, 0, 1, 100, "")).to.be.revertedWith("Precio debe ser > 0");
      await expect(boletera.createEvent("X", date, PRICE, 0, 100, "")).to.be.revertedWith("Cupo debe ser > 0");
      await expect(boletera.createEvent("X", date, PRICE, 1, 99, "")).to.be.revertedWith("Tope de reventa entre 100 y 200");
      await expect(boletera.createEvent("X", date, PRICE, 1, 201, "")).to.be.revertedWith("Tope de reventa entre 100 y 200");
    });

    it("solo el owner crea, cancela y nombra staff", async function () {
      const { boletera, alice, date } = await loadFixture(deployFixture);
      await expect(boletera.connect(alice).createEvent("X", date, PRICE, 1, 100, "")).to.be.revertedWithCustomError(boletera, "OwnableUnauthorizedAccount");
      await expect(boletera.connect(alice).cancelEvent(0)).to.be.revertedWithCustomError(boletera, "OwnableUnauthorizedAccount");
      await expect(boletera.connect(alice).setStaff(alice.address, true)).to.be.revertedWithCustomError(boletera, "OwnableUnauthorizedAccount");
    });

    it("evento inexistente revierte", async function () {
      const { boletera } = await loadFixture(deployFixture);
      await expect(boletera.getEventInfo(9)).to.be.revertedWith("Evento inexistente");
      await expect(boletera.buyTicket(9, { value: PRICE })).to.be.revertedWith("Evento inexistente");
    });

    it("no se cancela dos veces ni despues de empezar", async function () {
      const { boletera, date } = await loadFixture(deployFixture);
      await boletera.createEvent("Otro", date, PRICE, 1, 100, "");
      await expect(boletera.cancelEvent(0)).to.emit(boletera, "EventCanceled").withArgs(0);
      await expect(boletera.cancelEvent(0)).to.be.revertedWith("Evento cancelado");
      await time.increaseTo(date);
      await expect(boletera.cancelEvent(1)).to.be.revertedWith("El evento ya empezo");
    });
  });

  describe("Compra", function () {
    it("compra un boleto: NFT para el comprador y dinero en el contrato", async function () {
      const { boletera, ticket, alice } = await loadFixture(deployFixture);
      await expect(boletera.connect(alice).buyTicket(0, { value: PRICE }))
        .to.emit(boletera, "TicketPurchased")
        .withArgs(0, 1, alice.address, PRICE);
      expect(await ticket.ownerOf(1)).to.equal(alice.address);
      expect(await ticket.eventOf(1)).to.equal(0);
      expect(await ticket.tokenURI(1)).to.equal("ipfs://evento0");
      expect(await ticket.ticketsOf(alice.address)).to.deep.equal([1n]);
      const e = await boletera.getEventInfo(0);
      expect(e.sold).to.equal(1);
      expect(e.collected).to.equal(PRICE);
    });

    it("rechaza monto incorrecto", async function () {
      const { boletera, alice } = await loadFixture(deployFixture);
      await expect(boletera.connect(alice).buyTicket(0, { value: PRICE - 1n })).to.be.revertedWith("Monto incorrecto");
    });

    it("no vende mas que el cupo", async function () {
      const { boletera, alice } = await loadFixture(deployFixture);
      for (let i = 0; i < 3; i++) await boletera.connect(alice).buyTicket(0, { value: PRICE });
      await expect(boletera.connect(alice).buyTicket(0, { value: PRICE })).to.be.revertedWith("Agotado");
    });

    it("no vende si el evento se cancelo o ya empezo", async function () {
      const { boletera, alice, date } = await loadFixture(deployFixture);
      await boletera.createEvent("Otro", date, PRICE, 5, 100, "");
      await boletera.cancelEvent(1);
      await expect(boletera.connect(alice).buyTicket(1, { value: PRICE })).to.be.revertedWith("Evento cancelado");
      await time.increaseTo(date);
      await expect(boletera.connect(alice).buyTicket(0, { value: PRICE })).to.be.revertedWith("La venta ya cerro");
    });

    it("el boleto no se puede transferir directo desde la wallet", async function () {
      const { ticket, alice, bob } = await loadFixture(withTicketFixture);
      await expect(ticket.connect(alice).transferFrom(alice.address, bob.address, 1)).to.be.revertedWith("Transferir solo con la reventa de la boletera");
    });
  });

  describe("Reventa", function () {
    it("publica, compra y cobra comision; el vendedor retira su saldo", async function () {
      const { boletera, ticket, alice, bob } = await loadFixture(withTicketFixture);
      const resale = ethers.parseEther("0.012"); // 120 % (el tope)
      await expect(boletera.connect(alice).listForResale(1, resale)).to.emit(boletera, "ResaleListed").withArgs(1, alice.address, resale);

      const [ids] = await boletera.getListings();
      expect(ids).to.deep.equal([1n]);

      const fee = (resale * 5n) / 100n;
      await expect(boletera.connect(bob).buyResale(1, { value: resale }))
        .to.emit(boletera, "ResaleSold")
        .withArgs(1, alice.address, bob.address, resale, fee);
      expect(await ticket.ownerOf(1)).to.equal(bob.address);
      expect(await boletera.balances(alice.address)).to.equal(resale - fee);
      expect((await boletera.getEventInfo(0)).collected).to.equal(PRICE + fee);

      await expect(boletera.connect(alice).withdrawBalance()).to.changeEtherBalance(alice, resale - fee);
      await expect(boletera.connect(alice).withdrawBalance()).to.be.revertedWith("Sin saldo");
    });

    it("respeta el tope de precio y valida al vendedor", async function () {
      const { boletera, alice, bob } = await loadFixture(withTicketFixture);
      await expect(boletera.connect(alice).listForResale(1, ethers.parseEther("0.0121"))).to.be.revertedWith("Supera el tope de reventa");
      await expect(boletera.connect(alice).listForResale(1, 0)).to.be.revertedWith("Precio debe ser > 0");
      await expect(boletera.connect(bob).listForResale(1, PRICE)).to.be.revertedWith("No es tu boleto");
    });

    it("cancelar reventa: solo el vendedor", async function () {
      const { boletera, alice, bob } = await loadFixture(withTicketFixture);
      await boletera.connect(alice).listForResale(1, PRICE);
      await expect(boletera.connect(bob).cancelListing(1)).to.be.revertedWith("No es tu reventa");
      await expect(boletera.connect(alice).cancelListing(1)).to.emit(boletera, "ResaleCanceled").withArgs(1);
      await expect(boletera.connect(bob).buyResale(1, { value: PRICE })).to.be.revertedWith("No esta en reventa");
    });

    it("rechaza comprar tu propio boleto o con monto incorrecto", async function () {
      const { boletera, alice, bob } = await loadFixture(withTicketFixture);
      await boletera.connect(alice).listForResale(1, PRICE);
      await expect(boletera.connect(alice).buyResale(1, { value: PRICE })).to.be.revertedWith("Ya es tuyo");
      await expect(boletera.connect(bob).buyResale(1, { value: 1 })).to.be.revertedWith("Monto incorrecto");
    });

    it("no se revende si el evento empezo o se cancelo", async function () {
      const { boletera, alice, bob, date } = await loadFixture(withTicketFixture);
      await boletera.connect(alice).listForResale(1, PRICE);
      await time.increaseTo(date);
      await expect(boletera.connect(bob).buyResale(1, { value: PRICE })).to.be.revertedWith("El evento ya empezo");
      await expect(boletera.connect(alice).listForResale(1, PRICE)).to.be.revertedWith("El evento ya empezo");
    });

    it("una reventa publicada no se puede comprar si el evento se cancela", async function () {
      const { boletera, alice, bob } = await loadFixture(withTicketFixture);
      await boletera.connect(alice).listForResale(1, PRICE);
      await boletera.cancelEvent(0);
      await expect(boletera.connect(bob).buyResale(1, { value: PRICE })).to.be.revertedWith("Evento cancelado");
      await expect(boletera.connect(alice).listForResale(1, PRICE)).to.be.revertedWith("Evento cancelado");
    });
  });

  describe("Check-in", function () {
    it("el staff valida la entrada el dia del evento", async function () {
      const { boletera, ticket, alice, staff, date } = await loadFixture(withTicketFixture);
      await expect(boletera.setStaff(staff.address, true)).to.emit(boletera, "StaffUpdated").withArgs(staff.address, true);
      await boletera.connect(alice).listForResale(1, PRICE);
      await time.increaseTo(date - 2 * HOUR);
      await expect(boletera.connect(staff).checkIn(1)).to.emit(boletera, "CheckedIn").withArgs(0, 1, staff.address);
      expect(await ticket.used(1)).to.equal(true);
      expect((await boletera.listings(1)).seller).to.equal(ethers.ZeroAddress); // se quito de reventa
      await expect(boletera.connect(staff).checkIn(1)).to.be.revertedWith("Boleto ya usado");
    });

    it("fuera de horario o sin ser staff revierte", async function () {
      const { boletera, alice, otro, date } = await loadFixture(withTicketFixture);
      await expect(boletera.checkIn(1)).to.be.revertedWith("Aun no abren puertas");
      await expect(boletera.connect(otro).checkIn(1)).to.be.revertedWith("Solo staff");
      await time.increaseTo(date + 13 * HOUR);
      await expect(boletera.checkIn(1)).to.be.revertedWith("Ya cerraron puertas");
      await expect(boletera.setStaff(ethers.ZeroAddress, true)).to.be.revertedWith("Direccion invalida");
    });

    it("boleto inexistente o de evento cancelado revierte", async function () {
      const { boletera, ticket, date } = await loadFixture(withTicketFixture);
      await expect(boletera.checkIn(99)).to.be.revertedWithCustomError(ticket, "ERC721NonexistentToken");
      await boletera.cancelEvent(0);
      await time.increaseTo(date);
      await expect(boletera.checkIn(1)).to.be.revertedWith("Evento cancelado");
    });

    it("un boleto usado no se puede revender", async function () {
      const { boletera, alice, date } = await loadFixture(withTicketFixture);
      await time.increaseTo(date - HOUR);
      await boletera.checkIn(1);
      await expect(boletera.connect(alice).listForResale(1, PRICE)).to.be.revertedWith("Boleto ya usado");
    });
  });

  describe("Cancelacion y reembolsos", function () {
    it("cada quien recupera el precio original y el NFT se quema", async function () {
      const { boletera, ticket, alice } = await loadFixture(withTicketFixture);
      await boletera.cancelEvent(0);
      await expect(boletera.connect(alice).claimRefund(1)).to.changeEtherBalance(alice, PRICE);
      await expect(ticket.ownerOf(1)).to.be.revertedWithCustomError(ticket, "ERC721NonexistentToken");
      const e = await boletera.getEventInfo(0);
      expect(e.refunded).to.equal(1);
      expect(e.collected).to.equal(0);
    });

    it("no hay reembolso si el evento sigue o el boleto no es tuyo", async function () {
      const { boletera, alice, bob } = await loadFixture(withTicketFixture);
      await expect(boletera.connect(alice).claimRefund(1)).to.be.revertedWith("El evento no se cancelo");
      await boletera.cancelEvent(0);
      await expect(boletera.connect(bob).claimRefund(1)).to.be.revertedWith("No es tu boleto");
    });

    it("emite Refunded y quita la reventa", async function () {
      const { boletera, alice } = await loadFixture(withTicketFixture);
      await boletera.connect(alice).listForResale(1, PRICE);
      await boletera.cancelEvent(0);
      await expect(boletera.connect(alice).claimRefund(1)).to.emit(boletera, "Refunded").withArgs(0, 1, alice.address, PRICE);
      expect((await boletera.listings(1)).seller).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Tesoreria", function () {
    it("manda lo recaudado a la MultiSignWallet cuando termina el evento", async function () {
      const { boletera, treasury, date } = await loadFixture(withTicketFixture);
      await expect(boletera.withdrawToTreasury(0)).to.be.revertedWith("El evento no ha terminado");
      await time.increaseTo(date + 13 * HOUR);
      await expect(boletera.withdrawToTreasury(0))
        .to.emit(boletera, "SentToTreasury")
        .withArgs(0, treasury.target, PRICE)
        .and.to.emit(treasury, "Deposit");
      expect(await treasury.getBalance()).to.equal(PRICE);
      await expect(boletera.withdrawToTreasury(0)).to.be.revertedWith("Ya se retiro");
    });

    it("evento cancelado: solo cuando todos tienen reembolso y queda comision", async function () {
      const { boletera, treasury, alice, bob } = await loadFixture(withTicketFixture);
      await boletera.connect(alice).listForResale(1, PRICE);
      await boletera.connect(bob).buyResale(1, { value: PRICE }); // comision 5 %
      await boletera.cancelEvent(0);
      await expect(boletera.withdrawToTreasury(0)).to.be.revertedWith("Faltan reembolsos");
      await boletera.connect(bob).claimRefund(1);
      const fee = (PRICE * 5n) / 100n;
      await expect(boletera.withdrawToTreasury(0)).to.changeEtherBalance(treasury, fee);
    });

    it("sin ventas no hay nada que retirar; solo el owner retira o cambia la tesoreria", async function () {
      const { boletera, alice, otro, date } = await loadFixture(deployFixture);
      await expect(boletera.connect(alice).withdrawToTreasury(0)).to.be.revertedWithCustomError(boletera, "OwnableUnauthorizedAccount");
      await time.increaseTo(date + 13 * HOUR);
      await expect(boletera.withdrawToTreasury(0)).to.be.revertedWith("Nada que retirar");
      await expect(boletera.setTreasury(ethers.ZeroAddress)).to.be.revertedWith("Direccion invalida");
      await expect(boletera.setTreasury(otro.address)).to.emit(boletera, "TreasuryChanged").withArgs(otro.address);
      await expect(boletera.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(boletera, "OwnableUnauthorizedAccount");
    });

    it("la tesoreria solo saca dinero con aprobacion de su owner", async function () {
      const { boletera, treasury, owner, alice, date } = await loadFixture(withTicketFixture);
      await time.increaseTo(date + 13 * HOUR);
      await boletera.withdrawToTreasury(0);
      await treasury.submitTransaction(owner.address, PRICE, DAY);
      await expect(treasury.connect(alice).approveTransaction(0)).to.be.revertedWith("Not an owner");
      await treasury.approveTransaction(0);
      await expect(treasury.executeTransaction(0)).to.changeEtherBalance(owner, PRICE);
    });
  });
});
