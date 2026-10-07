import {
  conductorWithdrawalSms,
  fareSms,
  floatFundingSms,
  payoutCompletedSms,
  payoutPendingSms,
  payoutReleasedSms,
  personName,
  refundSms,
  registrationSms,
  renewalSms,
  topUpSms,
  wakalaAccountSms,
  wakalaWithdrawalSms,
} from './sms-copy';

const bodies = [
  registrationSms('Juma Abdallah', '123456789012'),
  topUpSms(10000, 25000, 'TP-1'),
  renewalSms('123456789012', 5000, 0),
  renewalSms('123456789012', 15000, 10000),
  fareSms(700, 4300, 'BP-1'),
  refundSms(700, 5000, 'RF-1'),
  conductorWithdrawalSms({
    amount: 100000,
    fee: 3500,
    earningsBalance: 20000,
    reference: 'WD-0001',
  }),
  wakalaWithdrawalSms(100000, 'WD-0001', 600000),
  floatFundingSms(50000, 150000, 'FF-1'),
  payoutPendingSms(100000, '07******78', 'PO-1'),
  payoutCompletedSms(100000, '07******78', 'PO-1'),
  payoutReleasedSms(100000, 'PO-1'),
  wakalaAccountSms('agent12'),
];

describe('customer SMS copy', () => {
  it('uses the passenger name and wallet account number in the registration SMS', () => {
    const name = personName('  Juma   ', '  Abdallah  ');
    const message = registrationSms(name, '123456789012');

    expect(name).toBe('JUMA ABDALLAH');
    expect(message).toContain('Karibu BusPay, JUMA ABDALLAH');
    expect(message).toContain('Namba ya pochi yako ni 123456789012, kwa jina la JUMA ABDALLAH');
    expect(message).toContain('kuweka pesa kwenye pochi yako kupitia huduma za pesa kwa simu');
    expect(message.startsWith('Usajili wako wa BusPay umekamilika.')).toBe(true);
  });

  it('does not say money was added when a renewal has no cash load', () => {
    const message = renewalSms('123456789012', 5000, 0);
    expect(message).toContain('Namba ya kadi bado 123456789012');
    expect(message).toContain('Salio lako ni TZS 5,000');
    expect(message).not.toContain('imeongezwa');
  });

  it('formats money as TZS with thousands separators', () => {
    expect(topUpSms(10000, 25000, 'TP-1')).toContain('TZS 10,000');
    expect(topUpSms(10000, 25000, 'TP-1')).toContain('TZS 25,000');
    expect(conductorWithdrawalSms({
      amount: 100000,
      fee: 3500,
      earningsBalance: 20000,
      reference: 'WD-0001',
    })).toContain('Ada: TZS 3,500');
  });

  it('keeps the temporary wakala password out of SMS', () => {
    const message = wakalaAccountSms('agent12');
    expect(message).toContain('agent12');
    expect(message.toLowerCase()).not.toContain('password');
    expect(message).not.toMatch(/[A-Za-z0-9!@#$%^&*]{16,}/);
  });

  it('does not start any customer message with the sender name', () => {
    for (const message of bodies) {
      expect(message).not.toMatch(/^(BusPay:|BUSPAY:|BusPay -)/);
    }
  });
});
