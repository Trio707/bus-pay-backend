import { SmsService } from './sms.service';
import { conductorWithdrawalSms, formatTzs, wakalaWithdrawalSms } from './sms-copy';

export { formatTzs };

export async function queuePaidWithdrawalSms(
  sms: SmsService,
  input: {
    amount: number;
    fee: number;
    earningsBalance?: number;
    reference: string;
    conductorPhone: string;
    wakalaPhone: string;
    floatBalance: number;
  },
) {
  await sms.enqueue(
    input.conductorPhone,
    'CONDUCTOR_WITHDRAWAL_SUCCESS',
    conductorWithdrawalSms({
      amount: input.amount,
      fee: input.fee,
      earningsBalance: input.earningsBalance,
      reference: input.reference,
    }),
  );
  await sms.enqueue(
    input.wakalaPhone,
    'WAKALA_WITHDRAWAL_RECEIVED',
    wakalaWithdrawalSms(input.amount, input.reference, input.floatBalance),
  );
}
