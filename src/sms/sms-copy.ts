import { normalizeName, personName } from '../auth/identity';

export { personName };

/** Customer-facing SMS bodies. The sender ID is BUSPAY, so bodies do not start with a brand prefix. */

export function formatTzs(amount: number) {
  return amount.toLocaleString('en-US');
}

export function tzs(amount: number) {
  return `TZS ${formatTzs(amount)}`;
}

export function registrationSms(name: string, accountNumber: string) {
  const passenger = normalizeName(name);
  return `Usajili wako wa BusPay umekamilika. Karibu BusPay, ${passenger}. Namba ya pochi yako ni ${accountNumber}, kwa jina la ${passenger}. Tumia namba hii kuweka pesa kwenye pochi yako kupitia huduma za pesa kwa simu. Asante kwa kutumia BusPay.`;
}

export function topUpSms(amount: number, balance: number, reference: string) {
  return `Pochi yako imeongezwa ${tzs(amount)}. Salio jipya ni ${tzs(balance)}. Muamala: ${reference}.`;
}

export function renewalSms(serialNumber: string, balance: number, extra: number) {
  const card = `Upyaishaji wa kadi yako umekamilika. Namba ya kadi bado ${serialNumber}.`;
  if (extra > 0) {
    return `${card} Pochi yako imeongezwa ${tzs(extra)}. Salio lako ni ${tzs(balance)}.`;
  }
  return `${card} Salio lako ni ${tzs(balance)}.`;
}

export function fareSms(amount: number, balance: number, reference: string) {
  return `Malipo ya nauli ya ${tzs(amount)} yamefanikiwa. Salio la pochi yako ni ${tzs(balance)}. Muamala: ${reference}.`;
}

export function refundSms(amount: number, balance: number, reference: string) {
  return `Marejesho ya ${tzs(amount)} yamewekwa kwenye pochi yako. Salio lako ni ${tzs(balance)}. Muamala: ${reference}.`;
}

export function conductorWithdrawalSms(input: {
  amount: number;
  fee: number;
  earningsBalance?: number;
  reference: string;
}) {
  const balance =
    input.earningsBalance === undefined
      ? ''
      : ` Salio la mapato: ${tzs(input.earningsBalance)}.`;
  return `Utoaji wa ${tzs(input.amount)} umefanikiwa. Ada: ${tzs(input.fee)}.${balance} Muamala: ${input.reference}.`;
}

export function wakalaWithdrawalSms(amount: number, reference: string, floatBalance: number) {
  return `Umefanikiwa kupokea malipo ya ${tzs(amount)}. Salio la float ni ${tzs(floatBalance)}. Kumbukumbu ya muamala: ${reference}.`;
}

export function floatFundingSms(amount: number, balance: number, reference: string) {
  return `Float yako imeongezwa ${tzs(amount)}. Salio jipya la float ni ${tzs(balance)}. Kumbukumbu: ${reference}.`;
}

export function payoutPendingSms(amount: number, destination: string, reference: string) {
  return `Malipo ya ${tzs(amount)} kwenda ${destination} yamepokelewa na yanashughulikiwa. Kumbukumbu: ${reference}.`;
}

export function payoutCompletedSms(amount: number, destination: string, reference: string) {
  return `Malipo ya ${tzs(amount)} yamekamilika na kutumwa kwenda ${destination}. Kumbukumbu: ${reference}.`;
}

/** Only for a failure or reversal that has already released the reserved earnings. */
export function payoutReleasedSms(amount: number, reference: string) {
  return `Samahani, malipo ya ${tzs(amount)} hayakukamilika. Kiasi kimeachiliwa kwenye mapato yako. Kumbukumbu: ${reference}.`;
}

/** Account notice only. The temporary password is not included. */
export function wakalaAccountSms(username: string) {
  return `Akaunti yako ya wakala imeundwa. Jina la mtumiaji ni ${username}. Ingia na ubadilishe nenosiri mara moja.`;
}
