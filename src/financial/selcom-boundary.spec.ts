import { ServiceUnavailableException } from '@nestjs/common';
import { UserRole, UserStatus } from '../generated/prisma';
import { ConductorPayoutService } from '../payout/conductor-payout.service';
import { SelcomPayoutProvider } from './selcom/selcom.provider';
import {
  createConfiguredPayoutProvider,
  financialRailStatus,
  reconcileExternalStatus,
  requestPassengerDigitalTopUp,
} from './financial-rail';

describe('Selcom financial boundary', () => {
  const original = process.env.PAYOUT_PROVIDER;

  afterEach(() => {
    if (original === undefined) delete process.env.PAYOUT_PROVIDER;
    else process.env.PAYOUT_PROVIDER = original;
  });

  it('keeps the sandbox adapter when Selcom is not selected', () => {
    delete process.env.PAYOUT_PROVIDER;
    const provider = createConfiguredPayoutProvider();
    expect(provider.configured).toBe(true);
    expect(provider).toBeInstanceOf(Object);
    expect(provider.constructor.name).toBe('MockPayoutProvider');
  });

  it('refuses Selcom payouts and does not report a completed transfer', async () => {
    const provider = new SelcomPayoutProvider();
    expect(provider.configured).toBe(false);
    const result = await provider.createPayout({
      payoutId: 'po-1',
      reference: 'PO-1',
      amount: 85_000,
      method: 'MOBILE_MONEY',
      provider: 'MPESA',
      destination: '+255712345678',
    });
    expect(result.outcome).toBe('REJECTED');
    if (result.outcome === 'REJECTED') {
      expect(result.reason).toContain('Selcom is not connected');
    }
    await expect(provider.getPayoutStatus('anything')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not reserve conductor earnings when the rail is not connected', async () => {
    const createPayout = jest.fn();
    const transaction = jest.fn();
    const service = new ConductorPayoutService(
      { $transaction: transaction, conductorPayout: { findUnique: jest.fn() } } as never,
      { enqueue: jest.fn() } as never,
      { flush: jest.fn() } as never,
      { configured: false, createPayout, getPayoutStatus: jest.fn() },
    );
    await expect(
      service.request(
        {
          id: 'cond-1',
          role: UserRole.CONDUCTOR,
          status: UserStatus.ACTIVE,
          phone: '+255714000001',
        } as never,
        {
          method: 'MOBILE_MONEY',
          provider: 'MPESA',
          mobileNumber: '0712345678',
          amount: 10_000,
          idempotencyKey: 'idem-closed',
        },
      ),
    ).rejects.toThrow('No funds were reserved');
    expect(createPayout).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('selects the closed Selcom adapter without exposing credentials', () => {
    process.env.PAYOUT_PROVIDER = 'selcom';
    process.env.PAYOUT_WEBHOOK_SECRET = 'do-not-leak';
    const provider = createConfiguredPayoutProvider();
    expect(provider).toBeInstanceOf(SelcomPayoutProvider);
    const status = financialRailStatus();
    expect(status.selcomConfigured).toBe(false);
    expect(status.liveMoneyMovement).toBe(false);
    expect(status.environment).toBeNull();
    expect(JSON.stringify(status)).not.toContain('do-not-leak');
    expect(JSON.stringify(status)).not.toContain('PAYOUT_WEBHOOK_SECRET');
  });

  it('marks a ledger and provider disagreement as a mismatch', () => {
    expect(reconcileExternalStatus('COMPLETED', 'COMPLETED')).toBe('MATCH');
    expect(reconcileExternalStatus('COMPLETED', 'FAILED')).toBe('MISMATCH');
    expect(reconcileExternalStatus('FAILED', 'COMPLETED')).toBe('MISMATCH');
    expect(reconcileExternalStatus('PROCESSING', 'PROCESSING')).toBe('MATCH');
    expect(reconcileExternalStatus('PENDING', null)).toBe('UNKNOWN');
    expect(reconcileExternalStatus('COMPLETED', null)).toBe('UNKNOWN');
  });

  it('refuses a passenger digital top-up before any wallet credit', () => {
    expect(() => requestPassengerDigitalTopUp()).toThrow(
      'verified Selcom transaction',
    );
  });
});
