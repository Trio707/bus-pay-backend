import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CardStatus,
  MerchantCategory,
  MerchantStatus,
  Prisma,
  ServiceType,
  TerminalStatus,
  TerminalType,
  TopUpSource,
  ConductorPayoutStatus,
  TransactionStatus,
  WakalaFloatTransactionType,
  type User,
  UserRole,
  UserStatus,
  WalletStatus,
  WithdrawalStatus,
} from '../generated/prisma';

import {
  normalizeName,
  normalizeNida,
  normalizePhone,
  phoneLookupValues,
} from '../auth/identity';
import { BooksService } from '../financial/books.service';
import { maskCardNumber, maskDestination } from '../payout/payout-mask';
import { PrismaService } from '../prisma/prisma.service';
import { lockConductorBalance } from './conductor-balance';
import { mobileCursor, mobilePageSize } from './mobile-page';
import { SmsDispatcherService } from '../sms/sms-dispatcher.service';
import { SmsService } from '../sms/sms.service';
import { fareSms, personName, registrationSms, renewalSms, topUpSms } from '../sms/sms-copy';
import { queuePaidWithdrawalSms } from '../sms/withdrawal-sms';
import {
  ActivateCardDto,
  ConductorWithdrawDto,
  IssueCardDto,
  RenewCardDto,
  ReplaceCardDto,
  ScanCardDto,
  TapPaymentDto,
  TopUpDto,
} from './dto/platform.dto';
import { nfcUidMatchKeys, normalizeNfcUid, sameNfcUid } from './nfc-uid';
import { WakalaFloatService } from './wakala-float.service';

const SERVICE_TYPES = new Set<string>(Object.values(ServiceType));

@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly smsDispatcher: SmsDispatcherService,
    private readonly floats: WakalaFloatService,
    private readonly books: BooksService,
  ) {}

  /**
   * Wakala NFC scan step: read UID from hardware, return preview card number.
   * Does not create a wallet yet — confirm via issueCard.
   */
  async previewScan(dto: ScanCardDto) {
    const nfcUid = this.normalizeUid(dto.nfcUid);
    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const existing = await this.prisma.card.findFirst({
      where: { nfcUid: { in: nfcUidMatchKeys(nfcUid) } },
      include: {
        wallet: { include: { customer: true } },
      },
    });

    if (existing) {
      return {
        alreadyIssued: true,
        nfcUid: existing.nfcUid,
        cardNumber: existing.serialNumber,
        walletAccountNumber: existing.wallet.publicCode,
        status: existing.status,
        passenger: {
          firstName: normalizeName(existing.wallet.customer.firstName),
          lastName: normalizeName(existing.wallet.customer.lastName),
          phone: existing.wallet.customer.phone,
        },
        balance: existing.wallet.balance,
        message:
          existing.status === CardStatus.ACTIVE
            ? 'This NFC card is already linked to a BusPay wallet'
            : `This NFC card is already registered (${existing.status})`,
      };
    }

    const cardNumber = await this.uniqueCardNumber();
    return {
      alreadyIssued: false,
      step: 'SCAN_OK',
      nextStep: 'ACTIVATE',
      /** For app state only — do not show in wakala UI. */
      nfcUid,
      cardNumber,
      walletAccountNumber: null,
      message:
        'NFC scan OK. Show card number to wakala; keep NFC UID internal.',
    };
  }

  /**
   * Top-up scan: identify passenger from NFC UID (internal).
   * UI should show passenger name + card number only.
   */
  async previewTopUpScan(dto: ScanCardDto) {
    const nfcUid = this.normalizeUid(dto.nfcUid);
    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const card = await this.prisma.card.findFirst({
      where: { nfcUid: { in: nfcUidMatchKeys(nfcUid) } },
      include: {
        wallet: { include: { customer: true } },
      },
    });

    if (!card) {
      throw new NotFoundException(
        'No BusPay card found for this NFC tag. Register the D-Card first.',
      );
    }

    if (card.status !== CardStatus.ACTIVE) {
      throw new BadRequestException(
        `Card cannot be topped up (status: ${card.status})`,
      );
    }

    if (card.wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }

    if (card.wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Passenger account is not active');
    }

    const passengerName = personName(
      card.wallet.customer.firstName,
      card.wallet.customer.lastName,
    );

    return {
      step: 'TOPUP_SCAN_OK',
      nextStep: 'ENTER_AMOUNT',
      verified: true,
      /** Display fields for wakala UI */
      passenger: {
        name: passengerName,
        firstName: normalizeName(card.wallet.customer.firstName),
        lastName: normalizeName(card.wallet.customer.lastName),
        phone: card.wallet.customer.phone,
      },
      cardNumber: card.serialNumber,
      walletAccountNumber: card.wallet.publicCode,
      /** Keep in app memory for confirm top-up — do not render in UI */
      nfcUid: card.nfcUid,
      message: 'Card verified. Confirm passenger, then enter top-up amount.',
    };
  }

  /**
   * Step: passenger names + card number + NFC UID → create/activate wallet (balance 0).
   * Next: POST /platform/wallets/topup for initial credit + SMS.
   */
  async activateCard(dto: ActivateCardDto, agent?: User) {
    return this.issueCard(
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        nida: dto.nida,
        cardNumber: dto.cardNumber,
        serialNumber: dto.cardNumber,
        nfcUid: dto.nfcUid,
        initialLoad: 0,
      },
      agent,
    );
  }

  async issueCard(dto: IssueCardDto, agent?: User) {
    const phone = normalizePhone(dto.phone);
    const nidaRaw = normalizeNida(dto.nida);
    const nida = nidaRaw.length === 20 ? nidaRaw : undefined;
    const nfcUid = this.normalizeUid(dto.nfcUid);
    const initialLoad = Math.max(0, dto.initialLoad ?? 0);
    if (initialLoad > 0 && agent?.role !== UserRole.AGENT) {
      throw new ForbiddenException(
        'Only a wakala can load cash onto a passenger wallet',
      );
    }

    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const takenUid = await this.cardByUid(nfcUid);
    if (takenUid) {
      throw new ConflictException('NFC UID is already issued');
    }

    let serialNumber = this.normalizeSerial(
      dto.cardNumber ?? dto.serialNumber,
    );
    if (!serialNumber) {
      serialNumber = await this.uniqueCardNumber();
    } else {
      const taken = await this.prisma.card.findFirst({
        where: { serialNumber },
      });
      if (taken) {
        throw new ConflictException('Card number already exists');
      }
    }

    const phoneKeys = phoneLookupValues(phone);
    const existingCustomer = await this.prisma.customer.findFirst({
      where: nida
        ? { OR: [{ phone: { in: phoneKeys } }, { nida }] }
        : { phone: { in: phoneKeys } },
      include: { wallet: true },
    });

    if (
      existingCustomer &&
      nida &&
      normalizePhone(existingCustomer.phone) !== phone
    ) {
      throw new ConflictException('NIDA is already registered');
    }
    if (existingCustomer && nida && existingCustomer.nida !== nida) {
      throw new ConflictException('Phone number is already registered');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (initialLoad > 0 && agent) {
        await this.floats.assertCanDebit(tx, agent.id, initialLoad);
      }

      const customer =
        existingCustomer ??
        (await tx.customer.create({
          data: {
            firstName: normalizeName(dto.firstName),
            lastName: normalizeName(dto.lastName),
            phone,
            nida: nida ?? (await this.uniquePlaceholderNida()),
            status: UserStatus.ACTIVE,
          },
        }));

      if (existingCustomer) {
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            firstName: normalizeName(dto.firstName),
            lastName: normalizeName(dto.lastName),
          },
        });
      }

      const wallet =
        existingCustomer?.wallet ??
        (await tx.wallet.create({
          data: {
            publicCode: await this.uniqueWalletAccount(),
            customerId: customer.id,
            balance: initialLoad,
          },
        }));

      const nextWallet =
        existingCustomer?.wallet && initialLoad > 0
          ? await tx.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: initialLoad } },
            })
          : wallet;

      const card = await tx.card.create({
        data: {
          serialNumber,
          nfcUid,
          walletId: nextWallet.id,
          status: CardStatus.ACTIVE,
        },
      });

      if (initialLoad > 0 && agent) {
        const createdTopUp = await tx.topUp.create({
          data: {
            reference: await this.nextTopUpReference(tx),
            walletId: nextWallet.id,
            cardId: card.id,
            agentUserId: agent.id,
            amount: initialLoad,
            previousBalance: nextWallet.balance - initialLoad,
            newBalance: nextWallet.balance,
            source: TopUpSource.INITIAL_LOAD,
          },
        });
        await this.floats.record(tx, {
          agentUserId: agent.id,
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: initialLoad,
          reference: createdTopUp.reference,
          reason: 'Card registration initial load',
          topUpId: createdTopUp.id,
        });
        await this.books.postTopUp(tx, {
          topUpId: createdTopUp.id,
          agentUserId: agent.id,
          amount: initialLoad,
        });
      }

      if (agent?.role === UserRole.AGENT) {
        await this.books.postRegistration(tx, {
          cardId: card.id,
          agentUserId: agent.id,
        });
      }

      const passengerName = personName(dto.firstName, dto.lastName);
      await this.sms.enqueue(
        phone,
        'CARD_REGISTERED',
        registrationSms(passengerName, nextWallet.publicCode),
        tx,
      );

      return {
        card,
        wallet: nextWallet,
        customer: {
          ...customer,
          firstName: normalizeName(dto.firstName),
          lastName: normalizeName(dto.lastName),
          phone,
        },
      };
    });

    void this.smsDispatcher.flush();

    const view = this.cardView(result.card, result.wallet, result.customer);
    return {
      success: true,
      step: 'WALLET_ACTIVATED',
      nextStep: initialLoad > 0 ? 'DONE' : 'TOP_UP',
      message:
        initialLoad > 0
          ? 'Wallet activated and credited'
          : 'Wallet activated. Enter initial top-up to credit balance.',
      smsQueued: true,
      ...view,
    };
  }

  async tap(user: User, dto: TapPaymentDto) {
    if (dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    const terminal = await this.requireConductorTerminal(user);
    const idempotencyKey = this.cleanIdempotencyKey(dto.idempotencyKey);
    if (idempotencyKey) {
      const replay = await this.replayFare(terminal.id, idempotencyKey);
      if (replay) return replay;
    }
    const amount = dto.amount;
    const card = await this.findCard(dto.serialNumber, dto.nfcUid);
    if (card.status !== CardStatus.ACTIVE) {
      throw new BadRequestException(`Card is ${card.status.toLowerCase()}`);
    }

    const wallet = card.wallet;
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }
    if (wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Customer account is not active');
    }
    if (wallet.balance < amount) {
      throw new BadRequestException('Insufficient balance');
    }

    if (dto.nfcUid && !card.nfcUid) {
      const uid = this.normalizeUid(dto.nfcUid);
      if (uid) {
        const takenUid = await this.cardByUid(uid);
        if (takenUid) {
          throw new ConflictException('NFC UID is already issued');
        }
        await this.prisma.card.update({
          where: { id: card.id },
          data: { nfcUid: uid },
        });
      }
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { id: terminal.merchantId },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }

    const serviceType = this.parseService(
      dto.serviceType,
      merchant.category,
    );

    let updated: { payment: { reference: string; amount: number; status: TransactionStatus }; balance: number };
    try {
      updated = await this.prisma.$transaction(async (tx) => {
      const split = await this.books.splitFare(tx, amount);
      const locked = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: amount } },
      });
      if (locked.balance < 0) {
        throw new BadRequestException('Insufficient balance');
      }

      const payment = await tx.paymentTransaction.create({
        data: {
          reference: await this.nextReference(tx),
          cardId: card.id,
          walletId: wallet.id,
          merchantId: merchant.id,
          terminalId: terminal.id,
          amount,
          conductorShare: split.conductorShare,
          platformFee: split.platformFee,
          serviceType,
          status: TransactionStatus.SUCCESS,
        },
      });
      await this.books.postFare(tx, {
        paymentId: payment.id,
        fare: amount,
        conductorShare: split.conductorShare,
        platformFee: split.platformFee,
      });

      await this.sms.enqueue(
        wallet.customer.phone,
        'PAYMENT_TAP',
        fareSms(amount, locked.balance, payment.reference),
        tx,
      );

      if (idempotencyKey) {
        await tx.apiIdempotency.create({
          data: {
            scope: this.fareScope(terminal.id),
            key: idempotencyKey,
            entityType: 'PaymentTransaction',
            entityId: payment.id,
          },
        });
      }

      return { payment, balance: locked.balance };
    });
    } catch (error) {
      if (idempotencyKey && this.isUniqueViolation(error)) {
        const replay = await this.replayFare(terminal.id, idempotencyKey);
        if (replay) return replay;
      }
      throw error;
    }

    void this.smsDispatcher.flush();

    return this.fareReceipt(
      updated.payment,
      updated.balance,
      card.serialNumber,
      wallet.customer,
    );
  }

  async topUp(user: User, dto: TopUpDto) {
    if (dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }

    const idempotencyKey = this.cleanIdempotencyKey(dto.idempotencyKey);
    if (idempotencyKey) {
      const replay = await this.replayTopUp(user.id, idempotencyKey);
      if (replay) return replay;
    }

    const account =
      dto.walletAccountNumber?.trim() ||
      dto.publicCode?.trim() ||
      undefined;

    const nfcUid = this.normalizeUid(dto.nfcUid);
    const card =
      nfcUid || dto.serialNumber
        ? await this.findCard(dto.serialNumber, nfcUid)
        : undefined;

    if (card) {
      if (card.status !== CardStatus.ACTIVE) {
        throw new BadRequestException(
          `Card cannot be topped up (status: ${card.status})`,
        );
      }
    }

    const wallet =
      card?.wallet ??
      (account
        ? await this.findWalletByAccount(account)
        : dto.phone
          ? await this.findWalletByPhone(dto.phone)
          : (() => {
              throw new BadRequestException(
                'Scan the D-Card (nfcUid) or provide card/wallet account number',
              );
            })());

    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException('Wallet is not active');
    }

    if (wallet.customer.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Passenger account is not active');
    }

    const previousBalance = wallet.balance;
    let updated: { publicCode: string; balance: number; status?: WalletStatus };
    let activeCard: {
      serialNumber: string;
      nfcUid: string | null;
      status: CardStatus;
      issuedAt: Date;
    } | null;
    try {
    const charged = await this.prisma.$transaction(
      async (tx) => {
        await this.floats.assertCanDebit(tx, user.id, dto.amount);

        const nextWallet = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: dto.amount } },
        });

        const nextCard =
          card ??
          (await tx.card.findFirst({
            where: { walletId: wallet.id, status: CardStatus.ACTIVE },
          }));

        const createdTopUp = await tx.topUp.create({
          data: {
            reference: await this.nextTopUpReference(tx),
            walletId: wallet.id,
            cardId: nextCard?.id,
            agentUserId: user.id,
            amount: dto.amount,
            previousBalance,
            newBalance: nextWallet.balance,
            source: TopUpSource.AGENT_TOPUP,
          },
        });

        await this.floats.record(tx, {
          agentUserId: user.id,
          type: WakalaFloatTransactionType.PASSENGER_TOPUP,
          amount: dto.amount,
          reference: createdTopUp.reference,
          reason: 'Passenger top-up',
          topUpId: createdTopUp.id,
        });
        await this.books.postTopUp(tx, {
          topUpId: createdTopUp.id,
          agentUserId: user.id,
          amount: dto.amount,
        });

        await this.sms.enqueue(
          wallet.customer.phone,
          'TOP_UP',
          topUpSms(dto.amount, nextWallet.balance, createdTopUp.reference),
          tx,
        );

        if (idempotencyKey) {
          await tx.apiIdempotency.create({
            data: {
              scope: `topup:${user.id}`,
              key: idempotencyKey,
              entityType: 'TopUp',
              entityId: createdTopUp.id,
            },
          });
        }

        return { updated: nextWallet, activeCard: nextCard };
      },
    );
    updated = charged.updated;
    activeCard = charged.activeCard;
    } catch (error) {
      if (idempotencyKey && this.isUniqueViolation(error)) {
        const replay = await this.replayTopUp(user.id, idempotencyKey);
        if (replay) return replay;
      }
      throw error;
    }

    const view = this.cardView(
      activeCard ?? {
        serialNumber: dto.serialNumber ?? updated.publicCode,
        nfcUid: null,
        status: CardStatus.ACTIVE,
        issuedAt: new Date(),
      },
      updated,
      wallet.customer,
    );

    void this.smsDispatcher.flush();

    const passengerName = personName(
      wallet.customer.firstName,
      wallet.customer.lastName,
    );

    return {
      success: true,
      step: 'WALLET_CREDITED',
      nextStep: 'DONE',
      message: 'Payment confirmed. Wallet credited.',
      paymentConfirmed: true,
      credited: dto.amount,
      smsQueued: true,
      passenger: {
        name: passengerName,
        firstName: normalizeName(wallet.customer.firstName),
        lastName: normalizeName(wallet.customer.lastName),
      },
      cardNumber: view.card.cardNumber,
      card: {
        cardNumber: view.card.cardNumber,
        serialNumber: view.card.serialNumber,
        nfcUid: view.card.nfcUid,
        status: view.card.status,
        frozen: view.card.frozen,
        issuedAt: view.card.issuedAt,
      },
      wallet: {
        walletAccountNumber: view.wallet.walletAccountNumber,
        publicCode: view.wallet.publicCode,
        status: view.wallet.status,
      },
      customer: view.customer,
    };
  }

  async renewCard(serialNumber: string, dto: RenewCardDto, agent?: User) {
    const idempotencyKey = this.cleanIdempotencyKey(dto.idempotencyKey);
    const renewScope = `renew:${agent?.id ?? serialNumber}`;
    if (idempotencyKey) {
      const replay = await this.replayRenew(renewScope, idempotencyKey, serialNumber);
      if (replay) return replay;
    }
    const card = await this.findCard(serialNumber, undefined);
    const nfcUid = this.normalizeUid(dto.nfcUid);
    const extra = Math.max(0, dto.amount ?? dto.initialLoad ?? 0);
    if (extra > 0 && agent?.role !== UserRole.AGENT) {
      throw new ForbiddenException(
        'Only a wakala can load cash onto a passenger wallet',
      );
    }
    if (!card.serialNumber) {
      throw new BadRequestException(
        'Existing card number could not be identified',
      );
    }

    const customerData = this.renewCustomerData(dto);

    if (nfcUid && card.nfcUid && !sameNfcUid(card.nfcUid, nfcUid)) {
      return this.replacePhysicalCard(card, nfcUid, {
        extra,
        agent,
        customerData,
        idempotencyKey,
        idempotencyScope: renewScope,
      });
    }

    if (nfcUid && sameNfcUid(card.nfcUid, nfcUid)) {
      const already = await this.replayedReplacement(card);
      if (already) return already;
    }

    if (nfcUid && !sameNfcUid(card.nfcUid, nfcUid)) {
      const takenUid = await this.cardByUid(nfcUid);
      if (takenUid && takenUid.id !== card.id) {
        throw new ConflictException('NFC UID is already issued');
      }
    }

    const [updatedCard, customer, wallet] = await this.prisma.$transaction(
      async (tx) => {
        if (extra > 0 && agent) {
          await this.floats.assertCanDebit(tx, agent.id, extra);
        }

        const nextCard = await tx.card.update({
          where: { id: card.id },
          data: {
            status: CardStatus.ACTIVE,
            ...(nfcUid ? { nfcUid } : {}),
          },
        });
        const nextCustomer =
          Object.keys(customerData).length > 0
            ? await tx.customer.update({
                where: { id: card.wallet.customer.id },
                data: customerData,
              })
            : card.wallet.customer;
        const previousBalance = card.wallet.balance;
        const nextWallet =
          extra > 0
            ? await tx.wallet.update({
                where: { id: card.wallet.id },
                data: { balance: { increment: extra } },
              })
            : card.wallet;

        if (extra > 0 && agent) {
          const createdTopUp = await tx.topUp.create({
            data: {
              reference: await this.nextTopUpReference(tx),
              walletId: nextWallet.id,
              cardId: nextCard.id,
              agentUserId: agent.id,
              amount: extra,
              previousBalance,
              newBalance: nextWallet.balance,
              source: TopUpSource.AGENT_TOPUP,
            },
          });
          await this.floats.record(tx, {
            agentUserId: agent.id,
            type: WakalaFloatTransactionType.PASSENGER_TOPUP,
            amount: extra,
            reference: createdTopUp.reference,
            reason: 'Card renewal load',
            topUpId: createdTopUp.id,
          });
        }
        await this.books.postRenewal(tx, {
          cardId: nextCard.id,
          agentUserId: agent?.id,
        });
        await this.sms.enqueue(
          nextCustomer.phone,
          'CARD_RENEWED',
          this.renewalMessage(card.serialNumber, nextWallet.balance, extra),
          tx,
        );

        if (idempotencyKey) {
          await tx.apiIdempotency.create({
            data: {
              scope: renewScope,
              key: idempotencyKey,
              entityType: 'Card',
              entityId: nextCard.id,
            },
          });
        }

        return [nextCard, nextCustomer, nextWallet] as const;
      },
    );

    void this.smsDispatcher.flush();

    return {
      success: true,
      message: 'Card renewed',
      ...this.cardView(updatedCard, wallet, customer),
    };
  }

  async freezeCard(serialNumber: string) {
    const card = await this.findCard(serialNumber, undefined);
    const updated = await this.prisma.card.update({
      where: { id: card.id },
      data: { status: CardStatus.FROZEN },
    });
    return {
      message: 'Card frozen',
      serialNumber: updated.serialNumber,
      status: updated.status,
    };
  }

  async replaceCard(oldSerial: string, dto: ReplaceCardDto, agent?: User) {
    const nfcUid = this.normalizeUid(dto.nfcUid);
    if (!nfcUid) {
      throw new BadRequestException('nfcUid is required from the NFC scanner');
    }

    const oldCard = await this.findCard(oldSerial, undefined);
    if (!oldCard.serialNumber) {
      throw new BadRequestException(
        'Existing card number could not be identified',
      );
    }
    const requested = this.normalizeSerial(dto.serialNumber);
    if (requested && requested !== oldCard.serialNumber) {
      throw new BadRequestException(
        'Replacement keeps the existing card number',
      );
    }

    if (sameNfcUid(oldCard.nfcUid, nfcUid)) {
      const already = await this.replayedReplacement(oldCard);
      if (already) return already;
      throw new BadRequestException('Scan the new physical card');
    }

    return this.replacePhysicalCard(oldCard, nfcUid, {
      extra: 0,
      agent,
      customerData: {},
    });
  }

  private renewCustomerData(dto: RenewCardDto) {
    const customerData: {
      firstName?: string;
      lastName?: string;
      phone?: string;
    } = {};
    if (dto.firstName?.trim()) customerData.firstName = normalizeName(dto.firstName);
    if (dto.lastName?.trim()) customerData.lastName = normalizeName(dto.lastName);
    if (dto.phone) customerData.phone = normalizePhone(dto.phone);
    return customerData;
  }

  private renewalMessage(serialNumber: string, balance: number, extra: number) {
    return renewalSms(serialNumber, balance, extra);
  }

  private async replayedReplacement(card: {
    id: string;
    serialNumber: string;
    nfcUid?: string | null;
    status: CardStatus;
    issuedAt?: Date;
    wallet: {
      publicCode?: string;
      balance: number;
      status?: WalletStatus;
      customer: { firstName: string; lastName: string; phone: string };
    };
  }) {
    const predecessor = await this.prisma.card.findFirst({
      where: { replacedById: card.id, serialNumber: card.serialNumber },
    });
    if (!predecessor || card.status !== CardStatus.ACTIVE) return null;
    return {
      success: true,
      message: 'Card renewed',
      alreadyReplaced: true,
      ...this.cardView(card, card.wallet, card.wallet.customer),
    };
  }

  /**
   * Swap the physical NFC card. The permanent serialNumber, customer, and wallet stay.
   */
  private async replacePhysicalCard(
    card: {
      id: string;
      serialNumber: string;
      nfcUid?: string | null;
      status: CardStatus;
      walletId: string;
      replacedById?: string | null;
      wallet: {
        id: string;
        balance: number;
        publicCode?: string;
        status?: WalletStatus;
        customer: {
          id: string;
          firstName: string;
          lastName: string;
          phone: string;
        };
      };
    },
    nfcUid: string,
    options: {
      extra: number;
      agent?: User;
      customerData: { firstName?: string; lastName?: string; phone?: string };
      idempotencyKey?: string;
      idempotencyScope?: string;
    },
  ) {
    const taken = await this.cardByUid(nfcUid);
    if (taken && taken.id !== card.id) {
      if (
        taken.status === CardStatus.ACTIVE &&
        taken.walletId === card.walletId &&
        taken.serialNumber === card.serialNumber &&
        sameNfcUid(taken.nfcUid, nfcUid)
      ) {
        const live = await this.findCard(card.serialNumber, undefined);
        const replay = await this.replayedReplacement(live);
        if (replay) return replay;
      }
      throw new ConflictException('NFC UID is already issued');
    }

    if (
      card.status !== CardStatus.ACTIVE &&
      card.status !== CardStatus.FROZEN &&
      card.replacedById
    ) {
      throw new ConflictException('Card was already replaced');
    }

    const { extra, agent, customerData, idempotencyKey, idempotencyScope } =
      options;
    const serialNumber = card.serialNumber;

    const [updatedCard, customer, wallet, previousUid] =
      await this.prisma.$transaction(async (tx) => {
        if (extra > 0 && agent) {
          await this.floats.assertCanDebit(tx, agent.id, extra);
        }

        const claimable =
          card.status === CardStatus.ACTIVE || card.status === CardStatus.FROZEN;
        if (claimable) {
          const claimed = await tx.card.updateMany({
            where: {
              id: card.id,
              status: { in: [CardStatus.ACTIVE, CardStatus.FROZEN] },
            },
            data: { status: CardStatus.LOST },
          });
          if (claimed.count !== 1) {
            throw new ConflictException('Card was already replaced');
          }
        }

        let created: {
          id: string;
          serialNumber: string;
          nfcUid: string | null;
          status: CardStatus;
          issuedAt: Date;
        };
        try {
          created = await tx.card.create({
            data: {
              serialNumber,
              nfcUid,
              walletId: card.walletId,
              status: CardStatus.ACTIVE,
            },
          });
        } catch (error) {
          if (this.isUniqueViolation(error)) {
            throw new ConflictException('Card was already replaced');
          }
          throw error;
        }

        if (created.serialNumber !== serialNumber) {
          throw new ConflictException(
            'Replacement must keep the existing card number',
          );
        }

        await tx.card.update({
          where: { id: card.id },
          data: {
            status: CardStatus.LOST,
            replacedById: created.id,
          },
        });

        const nextCustomer =
          Object.keys(customerData).length > 0
            ? await tx.customer.update({
                where: { id: card.wallet.customer.id },
                data: customerData,
              })
            : card.wallet.customer;

        const previousBalance = card.wallet.balance;
        const nextWallet =
          extra > 0
            ? await tx.wallet.update({
                where: { id: card.wallet.id },
                data: { balance: { increment: extra } },
              })
            : card.wallet;

        if (extra > 0 && agent) {
          const createdTopUp = await tx.topUp.create({
            data: {
              reference: await this.nextTopUpReference(tx),
              walletId: nextWallet.id,
              cardId: created.id,
              agentUserId: agent.id,
              amount: extra,
              previousBalance,
              newBalance: nextWallet.balance,
              source: TopUpSource.AGENT_TOPUP,
            },
          });
          await this.floats.record(tx, {
            agentUserId: agent.id,
            type: WakalaFloatTransactionType.PASSENGER_TOPUP,
            amount: extra,
            reference: createdTopUp.reference,
            reason: 'Card renewal load',
            topUpId: createdTopUp.id,
          });
        }
        await this.books.postRenewal(tx, {
          cardId: created.id,
          agentUserId: agent?.id,
        });

        await this.sms.enqueue(
          nextCustomer.phone,
          'CARD_RENEWED',
          this.renewalMessage(serialNumber, nextWallet.balance, extra),
          tx,
        );

        if (idempotencyKey && idempotencyScope) {
          await tx.apiIdempotency.create({
            data: {
              scope: idempotencyScope,
              key: idempotencyKey,
              entityType: 'Card',
              entityId: created.id,
            },
          });
        }

        return [created, nextCustomer, nextWallet, card.nfcUid] as const;
      });

    void this.smsDispatcher.flush();

    return {
      success: true,
      message:
        extra > 0
          ? 'Card renewed'
          : 'Card replaced. Wallet balance is unchanged.',
      oldCard: serialNumber,
      previousCard: {
        nfcUid: previousUid,
        status: CardStatus.LOST,
      },
      ...this.cardView(updatedCard, wallet, customer),
    };
  }

  private cleanIdempotencyKey(value?: string) {
    const key = value?.trim();
    return key ? key : undefined;
  }

  private fareScope(terminalId: string) {
    return `fare:${terminalId}`;
  }

  private fareReceipt(
    payment: { reference: string; amount: number; status: string },
    balance: number,
    serialNumber: string,
    customer: { firstName: string; lastName: string },
  ) {
    return {
      message: 'Payment successful',
      reference: payment.reference,
      amount: payment.amount,
      status: payment.status,
      wallet: { balance },
      card: { serialNumber },
      customer: {
        firstName: normalizeName(customer.firstName),
        lastName: normalizeName(customer.lastName),
      },
    };
  }

  private async replayFare(terminalId: string, key: string) {
    const hit = await this.prisma.apiIdempotency.findUnique({
      where: { scope_key: { scope: this.fareScope(terminalId), key } },
    });
    if (!hit || hit.entityType !== 'PaymentTransaction') return null;
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { id: hit.entityId },
      include: {
        card: { select: { serialNumber: true } },
        wallet: { include: { customer: true } },
      },
    });
    if (!payment) return null;
    return this.fareReceipt(
      payment,
      payment.wallet.balance,
      payment.card.serialNumber,
      payment.wallet.customer,
    );
  }

  private async replayTopUp(agentId: string, key: string) {
    const hit = await this.prisma.apiIdempotency.findUnique({
      where: { scope_key: { scope: `topup:${agentId}`, key } },
    });
    if (!hit || hit.entityType !== 'TopUp') return null;
    const topUp = await this.prisma.topUp.findUnique({
      where: { id: hit.entityId },
      include: {
        card: true,
        wallet: { include: { customer: true } },
      },
    });
    if (!topUp?.wallet.customer) return null;
    const view = topUp.card
      ? this.cardView(topUp.card, topUp.wallet, topUp.wallet.customer)
      : null;
    const passengerName = personName(
      topUp.wallet.customer.firstName,
      topUp.wallet.customer.lastName,
    );
    return {
      success: true,
      step: 'WALLET_CREDITED',
      nextStep: 'DONE',
      message: 'Payment confirmed. Wallet credited.',
      paymentConfirmed: true,
      credited: topUp.amount,
      smsQueued: true,
      passenger: {
        name: passengerName,
        firstName: normalizeName(topUp.wallet.customer.firstName),
        lastName: normalizeName(topUp.wallet.customer.lastName),
      },
      cardNumber: view?.card.cardNumber ?? topUp.wallet.publicCode,
      card: {
        cardNumber: view?.card.cardNumber ?? topUp.wallet.publicCode,
        serialNumber: view?.card.serialNumber ?? topUp.wallet.publicCode,
        nfcUid: view?.card.nfcUid ?? null,
        status: view?.card.status ?? CardStatus.ACTIVE,
        frozen: view?.card.frozen ?? false,
        issuedAt: view?.card.issuedAt ?? topUp.createdAt,
      },
      wallet: {
        walletAccountNumber:
          view?.wallet.walletAccountNumber ?? topUp.wallet.publicCode,
        publicCode: topUp.wallet.publicCode,
        status: topUp.wallet.status,
      },
      customer: view?.customer,
    };
  }

  private async replayWithdrawal(user: User, key: string) {
    const hit = await this.prisma.apiIdempotency.findUnique({
      where: { scope_key: { scope: `cashout:${user.id}`, key } },
    });
    if (!hit || hit.entityType !== 'Withdrawal') return null;
    const row = await this.prisma.withdrawal.findUnique({
      where: { id: hit.entityId },
      include: {
        agent: {
          select: { firstName: true, lastName: true, tillNumber: true },
        },
      },
    });
    if (!row) return null;
    const terminal = await this.requireConductorTerminal(user);
    const available = await this.conductorAvailableBalance(user.id, terminal.id);
    return {
      success: true,
      message: 'Withdrawal successful',
      reference: row.reference,
      amount: row.amount,
      fee: row.platformFee,
      platformFee: row.platformFee,
      netAmount: row.amount,
      totalDebit: row.totalDebit,
      available,
      smsQueued: true,
      agent: {
        tillNumber: row.agent.tillNumber,
        firstName: normalizeName(row.agent.firstName),
        lastName: normalizeName(row.agent.lastName),
        name: personName(row.agent.firstName, row.agent.lastName),
      },
    };
  }

  private async replayRenew(scope: string, key: string, serialNumber: string) {
    const hit = await this.prisma.apiIdempotency.findUnique({
      where: { scope_key: { scope, key } },
    });
    if (!hit) return null;
    const card = await this.findCard(serialNumber, undefined);
    return {
      success: true,
      message: 'Card renewed',
      ...this.cardView(card, card.wallet, card.wallet.customer),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  async lookupCard(serialNumber?: string, nfcUid?: string) {
    const card = await this.findCard(serialNumber, nfcUid);
    return this.cardView(card, card.wallet, card.wallet.customer);
  }

  async getFloat(user: User) {
    if (user.role !== UserRole.AGENT) {
      throw new ForbiddenException('Only a wakala can view float');
    }
    return this.floats.getBalance(user.id);
  }

  async listFloatTransactions(user: User, page?: string, limit?: string) {
    if (user.role !== UserRole.AGENT) {
      throw new ForbiddenException('Only a wakala can view float history');
    }
    const parsedPage = Number(page ?? 1);
    const take = mobilePageSize(limit, 20);
    return this.floats.listTransactions(
      user.id,
      Number.isFinite(parsedPage) ? parsedPage : 1,
      take,
    );
  }

  async getTransactions(
    user: User,
    query: { limit?: string; cursor?: string; since?: string; summary?: string } = {},
  ) {
    const terminal = await this.requireConductorTerminal(user);
    const take = mobilePageSize(query.limit, 20);
    const cursor = mobileCursor(query.cursor);
    const since = mobileCursor(query.since);
    const summary = query.summary === '1' || query.summary === 'true';
    const createdAt =
      cursor || since
        ? {
            ...(since ? { gt: since } : {}),
            ...(cursor ? { lt: cursor } : {}),
          }
        : undefined;

    const [gross, available, withdrawn] = await Promise.all([
      this.prisma.paymentTransaction.aggregate({
        where: {
          terminalId: terminal.id,
          status: TransactionStatus.SUCCESS,
        },
        _sum: { amount: true },
      }),
      this.conductorAvailableBalance(user.id, terminal.id),
      this.conductorWithdrawnTotal(user.id),
    ]);

    const balances = {
      terminal: terminal.terminalCode,
      collected: available,
      grossCollected: gross._sum.amount ?? 0,
      withdrawn,
      available,
      syncedAt: new Date().toISOString(),
    };

    if (summary) {
      return {
        ...balances,
        limit: take,
        hasMore: false,
        nextCursor: null,
        transactions: [],
        withdrawals: [],
        payouts: [],
      };
    }

    const [transactions, withdrawnRows, payouts] = await Promise.all([
      this.prisma.paymentTransaction.findMany({
        where: { terminalId: terminal.id, ...(createdAt ? { createdAt } : {}) },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        select: {
          reference: true,
          amount: true,
          status: true,
          createdAt: true,
          card: { select: { serialNumber: true } },
        },
      }),
      this.prisma.withdrawal.findMany({
        where: {
          conductorUserId: user.id,
          ...(createdAt ? { requestedAt: createdAt } : {}),
        },
        orderBy: { requestedAt: 'desc' },
        take: take + 1,
        select: {
          reference: true,
          amount: true,
          status: true,
          requestedAt: true,
          agent: {
            select: { firstName: true, lastName: true, tillNumber: true },
          },
        },
      }),
      this.conductorPayoutRows(user.id, take + 1, cursor, since),
    ]);

    const farePage = transactions.slice(0, take);
    const withdrawalPage = withdrawnRows.slice(0, take);
    const payoutPage = payouts.slice(0, take);
    const stamps = [
      farePage[farePage.length - 1]?.createdAt,
      withdrawalPage[withdrawalPage.length - 1]?.requestedAt,
      payoutPage[payoutPage.length - 1]?.createdAt,
    ].filter((value): value is Date => value instanceof Date);
    stamps.sort((left, right) => left.getTime() - right.getTime());
    const oldest = stamps[0];

    return {
      ...balances,
      limit: take,
      hasMore:
        transactions.length > take ||
        withdrawnRows.length > take ||
        payouts.length > take,
      nextCursor: oldest ? oldest.toISOString() : null,
      transactions: farePage.map((transaction) => ({
        reference: transaction.reference,
        amount: transaction.amount,
        status: transaction.status,
        card: maskCardNumber(transaction.card.serialNumber),
        createdAt: transaction.createdAt,
      })),
      withdrawals: withdrawalPage.map((row) => ({
        reference: row.reference,
        amount: row.amount,
        status: row.status,
        tillNumber: row.agent.tillNumber,
        agent: personName(row.agent.firstName, row.agent.lastName),
        createdAt: row.requestedAt,
      })),
      payouts: payoutPage,
    };
  }

  async lookupWakalaTill(tillNumber: string) {
    const till = this.normalizeTill(tillNumber);
    if (!till) {
      throw new BadRequestException('Enter a valid wakala TILL number');
    }
    const agent = await this.findAgentByTill(till);
    if (!agent) {
      throw new NotFoundException('Wakala TILL not found');
    }
    if (agent.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Wakala account is not active');
    }
    return {
      verified: true,
      tillNumber: agent.tillNumber,
      agent: {
        firstName: normalizeName(agent.firstName),
        lastName: normalizeName(agent.lastName),
        name: personName(agent.firstName, agent.lastName),
      },
    };
  }

  /**
   * Conductor → wakala cash-out: enter wakala TILL + amount.
   * Deducts from terminal collections immediately (status PAID).
   */
  async withdrawToWakala(user: User, dto: ConductorWithdrawDto) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException('Only conductors can withdraw via wakala');
    }
    if (dto.amount < 1) {
      throw new BadRequestException('Amount must be greater than 0');
    }
    const idempotencyKey = this.cleanIdempotencyKey(dto.idempotencyKey);
    if (idempotencyKey) {
      const replay = await this.replayWithdrawal(user, idempotencyKey);
      if (replay) return replay;
    }

    const till = this.normalizeTill(dto.tillNumber);
    if (!till) {
      throw new BadRequestException('Enter a valid wakala TILL number');
    }

    const agent = await this.findAgentByTill(till);
    if (!agent) {
      throw new NotFoundException('Wakala TILL not found');
    }
    if (agent.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Wakala account is not active');
    }

    const terminal = await this.requireConductorTerminal(user);
    const quote = await this.books.quoteWithdrawal(dto.amount);
    const available = await this.conductorAvailableBalance(user.id, terminal.id);
    if (quote.totalDebit > available) {
      throw new BadRequestException(
        `Insufficient balance. Available TZS ${available}. Fee TZS ${quote.fee}. Total TZS ${quote.totalDebit}.`,
      );
    }

    let withdrawal: {
      created: { reference: string };
      posted: { alreadyPosted?: boolean; balanceAfter: number };
    };
    try {
    withdrawal = await this.prisma.$transaction(async (tx) => {
      await lockConductorBalance(tx, user.id);
      const lockedAvailable = await this.conductorAvailableBalance(
        user.id,
        terminal.id,
        tx,
      );
      if (quote.totalDebit > lockedAvailable) {
        throw new BadRequestException(
          `Insufficient balance. Available TZS ${lockedAvailable}. Fee TZS ${quote.fee}. Total TZS ${quote.totalDebit}.`,
        );
      }

      const created = await tx.withdrawal.create({
        data: {
          reference: await this.nextWithdrawalReference(tx),
          agentUserId: agent.id,
          conductorUserId: user.id,
          amount: dto.amount,
          platformFee: quote.fee,
          totalDebit: quote.totalDebit,
          status: WithdrawalStatus.PAID,
          notes: `Conductor cash-out via TILL ${agent.tillNumber ?? till}`,
          processedAt: new Date(),
        },
      });

      const posted = await this.floats.record(tx, {
        agentUserId: agent.id,
        type: WakalaFloatTransactionType.CONDUCTOR_WITHDRAWAL,
        amount: dto.amount,
        reference: created.reference,
        reason: `Conductor cash-out via TILL ${agent.tillNumber ?? till}`,
        withdrawalId: created.id,
      });
      await this.books.postCashOut(tx, {
        withdrawalId: created.id,
        cashAmount: dto.amount,
        fee: quote.fee,
      });

      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'WITHDRAWAL_PAID',
          entityType: 'Withdrawal',
          entityId: created.id,
          metadata: {
            reference: created.reference,
            amount: dto.amount,
            agentUserId: agent.id,
          },
        },
      });

      if (idempotencyKey) {
        await tx.apiIdempotency.create({
          data: {
            scope: `cashout:${user.id}`,
            key: idempotencyKey,
            entityType: 'Withdrawal',
            entityId: created.id,
          },
        });
      }

      return { created, posted };
    });
    } catch (error) {
      if (idempotencyKey && this.isUniqueViolation(error)) {
        const replay = await this.replayWithdrawal(user, idempotencyKey);
        if (replay) return replay;
      }
      throw error;
    }

    if (!withdrawal.posted.alreadyPosted) {
      try {
        await queuePaidWithdrawalSms(this.sms, {
          amount: dto.amount,
          fee: quote.fee,
          earningsBalance: available - quote.totalDebit,
          reference: withdrawal.created.reference,
          conductorPhone: user.phone,
          wakalaPhone: agent.phone,
          floatBalance: withdrawal.posted.balanceAfter,
        });
      } catch {
        // Cash-out is already committed. The outbox retries delivery.
      }
    }

    void this.smsDispatcher.flush();

    const nextAvailable = available - quote.totalDebit;
    return {
      success: true,
      message: 'Withdrawal successful',
      reference: withdrawal.created.reference,
      amount: dto.amount,
      fee: quote.fee,
      platformFee: quote.fee,
      netAmount: dto.amount,
      totalDebit: quote.totalDebit,
      available: nextAvailable,
      smsQueued: true,
      agent: {
        tillNumber: agent.tillNumber,
        firstName: normalizeName(agent.firstName),
        lastName: normalizeName(agent.lastName),
        name: personName(agent.firstName, agent.lastName),
      },
    };
  }

  private async conductorAvailableBalance(
    conductorUserId: string,
    terminalId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const taps = await db.paymentTransaction.aggregate({
      where: {
        terminalId,
        status: TransactionStatus.SUCCESS,
      },
      _sum: { conductorShare: true, amount: true },
    });
    const gross =
      taps._sum.conductorShare == null
        ? (taps._sum.amount ?? 0)
        : taps._sum.conductorShare;
    const withdrawn = await this.conductorWithdrawnTotal(conductorUserId, db);
    const payouts = await db.conductorPayout.aggregate({
      where: {
        conductorUserId,
        status: {
          in: [
            ConductorPayoutStatus.PENDING,
            ConductorPayoutStatus.PROCESSING,
            ConductorPayoutStatus.COMPLETED,
          ],
        },
      },
      _sum: { totalDebit: true, amount: true },
    });
    const reserved =
      payouts._sum.totalDebit == null
        ? (payouts._sum.amount ?? 0)
        : payouts._sum.totalDebit;
    return Math.max(0, gross - withdrawn - reserved);
  }

  private async conductorPayoutRows(
    conductorUserId: string,
    take = 20,
    cursor?: Date,
    since?: Date,
  ) {
    const requestedAt =
      cursor || since
        ? {
            ...(since ? { gt: since } : {}),
            ...(cursor ? { lt: cursor } : {}),
          }
        : undefined;
    const rows = await this.prisma.conductorPayout.findMany({
      where: { conductorUserId, ...(requestedAt ? { requestedAt } : {}) },
      orderBy: { requestedAt: 'desc' },
      take,
    });
    return rows.map((row) => ({
      reference: row.reference,
      amount: row.amount,
      fee: row.platformFee,
      platformFee: row.platformFee,
      netAmount: row.amount,
      totalDebit: row.totalDebit,
      method: row.method,
      provider: row.provider,
      destination: maskDestination(row.method, row.destination),
      status: row.status,
      createdAt: row.requestedAt,
    }));
  }

  private async conductorWithdrawnTotal(
    conductorUserId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const rows = await db.withdrawal.aggregate({
      where: {
        conductorUserId,
        status: {
          in: [
            WithdrawalStatus.PENDING,
            WithdrawalStatus.APPROVED,
            WithdrawalStatus.PAID,
          ],
        },
      },
      _sum: { totalDebit: true, amount: true },
    });
    return rows._sum.totalDebit == null
      ? (rows._sum.amount ?? 0)
      : rows._sum.totalDebit;
  }

  private normalizeTill(value?: string): string | undefined {
    const digits = value?.replace(/\D/g, '') ?? '';
    if (digits.length < 4) return undefined;
    const padded = digits.padStart(8, '0').slice(-8);
    return `${padded.slice(0, 4)}-${padded.slice(4)}`;
  }

  private async findAgentByTill(till: string) {
    const digits = till.replace(/\D/g, '');
    const agents = await this.prisma.user.findMany({
      where: {
        role: UserRole.AGENT,
        tillNumber: { not: null },
      },
    });
    return (
      agents.find((a) => {
        const agentDigits = (a.tillNumber ?? '').replace(/\D/g, '');
        return (
          agentDigits === digits ||
          agentDigits.slice(-8) === digits.slice(-8) ||
          (a.tillNumber ?? '').toUpperCase() === till.toUpperCase()
        );
      }) ?? null
    );
  }

  private async nextWithdrawalReference(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `WD-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.withdrawal.findUnique({
        where: { reference },
      });
      if (!taken) {
        return reference;
      }
    }
    throw new ConflictException('Could not generate a withdrawal reference');
  }

  private async requireConductorTerminal(user: User) {
    if (user.role !== UserRole.CONDUCTOR) {
      throw new ForbiddenException(
        'Only conductors can use this terminal',
      );
    }

    const existing = await this.prisma.terminal.findFirst({
      where: {
        ownerUserId: user.id,
        status: TerminalStatus.ACTIVE,
      },
    });
    if (existing) {
      return existing;
    }

    // Auto-provision so fare collection works right after conductor signup.
    return this.provisionConductorTerminal(user.id);
  }

  private async provisionConductorTerminal(conductorUserId: string) {
    const merchant = await this.prisma.merchant.findUnique({
      where: { merchantCode: 'DLD-PLATFORM' },
    });
    if (!merchant || merchant.status !== MerchantStatus.ACTIVE) {
      throw new NotFoundException(
        'Transport merchant is not configured. Run database seed.',
      );
    }

    const free = await this.prisma.terminal.findFirst({
      where: {
        merchantId: merchant.id,
        ownerUserId: null,
        status: TerminalStatus.ACTIVE,
      },
      orderBy: { terminalCode: 'asc' },
    });

    if (free) {
      return this.prisma.terminal.update({
        where: { id: free.id },
        data: { ownerUserId: conductorUserId },
      });
    }

    const terminalCode = await this.uniqueTerminalCode();
    return this.prisma.terminal.create({
      data: {
        terminalCode,
        merchantId: merchant.id,
        ownerUserId: conductorUserId,
        type: TerminalType.APP,
        status: TerminalStatus.ACTIVE,
      },
    });
  }

  private async uniqueTerminalCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const terminalCode = `DLD-C${String(randomInt(100, 9999)).padStart(4, '0')}`;
      const taken = await this.prisma.terminal.findUnique({
        where: { terminalCode },
      });
      if (!taken) {
        return terminalCode;
      }
    }
    throw new ConflictException('Could not allocate a terminal');
  }

  private cardInclude() {
    return {
      wallet: {
        include: { customer: true },
      },
    } as const;
  }

  private async cardByUid(nfcUid: string) {
    const keys = nfcUidMatchKeys(nfcUid);
    if (!keys.length) return null;
    return this.prisma.card.findFirst({
      where: { nfcUid: { in: keys } },
    });
  }

  private async findCard(serialNumber?: string, nfcUid?: string) {
    const serial = this.normalizeSerial(serialNumber);
    const uid = this.normalizeUid(nfcUid);
    if (!serial && !uid) {
      throw new BadRequestException('serialNumber or nfcUid is required');
    }

    const include = this.cardInclude();

    // Prefer NFC UID — that is what the conductor phone actually reads.
    // A lost UID must resolve to the lost physical card, not the new one.
    if (uid) {
      const byUid = await this.prisma.card.findFirst({
        where: { nfcUid: { in: nfcUidMatchKeys(nfcUid) } },
        include,
      });
      if (byUid) return byUid;
      if (!serial) throw new NotFoundException('Card not found');
    }

    if (!serial) throw new NotFoundException('Card not found');

    const live = await this.prisma.card.findFirst({
      where: {
        serialNumber: serial,
        status: { in: [CardStatus.ACTIVE, CardStatus.FROZEN] },
      },
      include,
      orderBy: { issuedAt: 'desc' },
    });
    if (live) return live;

    const historical = await this.prisma.card.findFirst({
      where: { serialNumber: serial },
      include,
      orderBy: { issuedAt: 'desc' },
    });
    if (!historical) throw new NotFoundException('Card not found');
    return historical;
  }

  private async findWalletByPhone(phone?: string) {
    const normalized = normalizePhone(phone);
    const customer = await this.prisma.customer.findUnique({
      where: { phone: normalized },
      include: { wallet: true },
    });
    if (!customer?.wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return { ...customer.wallet, customer };
  }

  private async resolveMerchant(merchantCode?: string) {
    const code = merchantCode?.trim() || 'DLD-PLATFORM';
    const merchant = await this.prisma.merchant.findUnique({
      where: { merchantCode: code },
    });
    if (!merchant) {
      throw new NotFoundException('Merchant not found');
    }
    return merchant;
  }

  private parseService(
    value: string | undefined,
    fallback: MerchantCategory,
  ): ServiceType {
    const raw = (value || fallback).toUpperCase();
    if (!SERVICE_TYPES.has(raw)) {
      return ServiceType.OTHER;
    }
    return raw as ServiceType;
  }

  private normalizeSerial(value?: string): string | undefined {
    const serial = value?.trim().toUpperCase();
    return serial ? serial : undefined;
  }

  private normalizeUid(value?: string): string | undefined {
    return normalizeNfcUid(value);
  }

  private cardView(
    card: {
      serialNumber: string;
      nfcUid?: string | null;
      status: CardStatus;
      issuedAt?: Date;
    },
    wallet: { publicCode?: string; balance: number; status?: WalletStatus },
    customer?: { firstName: string; lastName: string; phone: string },
  ) {
    return {
      card: {
        cardNumber: card.serialNumber,
        serialNumber: card.serialNumber,
        nfcUid: card.nfcUid ?? '',
        status: card.status,
        frozen: card.status === CardStatus.FROZEN,
        balance: wallet.balance,
        issuedAt: card.issuedAt,
      },
      wallet: {
        /** Public number for mobile money / M-Pesa top-ups (not NFC UID). */
        walletAccountNumber: wallet.publicCode,
        publicCode: wallet.publicCode,
        balance: wallet.balance,
        status: wallet.status,
      },
      customer: {
        firstName: customer?.firstName ? normalizeName(customer.firstName) : '',
        lastName: customer?.lastName ? normalizeName(customer.lastName) : '',
        phone: customer?.phone ?? '',
      },
    };
  }

  private async findWalletByAccount(account: string) {
    const code = account.trim().toUpperCase();
    const byWallet = await this.prisma.wallet.findFirst({
      where: {
        OR: [
          { publicCode: { equals: code, mode: 'insensitive' } },
          { publicCode: { equals: account.trim(), mode: 'insensitive' } },
        ],
      },
      include: { customer: true },
    });
    if (byWallet) {
      return { ...byWallet, customer: byWallet.customer };
    }

    const byCard = await this.prisma.card.findFirst({
      where: {
        serialNumber: { equals: code, mode: 'insensitive' },
        status: CardStatus.ACTIVE,
      },
      include: {
        wallet: { include: { customer: true } },
      },
    });
    if (byCard?.wallet) {
      return { ...byCard.wallet, customer: byCard.wallet.customer };
    }

    throw new NotFoundException('Wallet account not found');
  }

  private async uniquePlaceholderNida(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nida = `9${Date.now()}${randomInt(100000, 999999)}`.slice(0, 20);
      const taken = await this.prisma.customer.findUnique({ where: { nida } });
      if (!taken) {
        return nida;
      }
    }
    throw new ConflictException('Could not generate a customer id');
  }

  /** 12-digit public card number for display / top-up (not NFC UID). */
  private async uniqueCardNumber(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const serialNumber = String(randomInt(100000000000, 1000000000000));
      const taken = await this.prisma.card.findFirst({
        where: { serialNumber },
      });
      if (!taken) {
        return serialNumber;
      }
    }
    throw new ConflictException('Could not generate a card number');
  }

  /** Wallet account number passengers use for mobile money. */
  private async uniqueWalletAccount(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const publicCode = String(randomInt(100000000000, 1000000000000));
      const taken = await this.prisma.wallet.findUnique({
        where: { publicCode },
      });
      if (!taken) {
        return publicCode;
      }
    }
    throw new ConflictException('Could not generate a wallet account number');
  }

  private async nextReference(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `BP-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.paymentTransaction.findUnique({
        where: { reference },
      });
      if (!taken) {
        return reference;
      }
    }
    throw new ConflictException('Could not generate a payment reference');
  }

  private async nextTopUpReference(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reference = `TU-${day}-${String(randomInt(0, 1000000)).padStart(6, '0')}`;
      const taken = await tx.topUp.findUnique({
        where: { reference },
      });
      if (!taken) {
        return reference;
      }
    }
    throw new ConflictException('Could not generate a top-up reference');
  }
}
