# Direct mobile-money funding

Selcom is not connected. M-Pesa, Airtel Money, Mixx by Yas, and HaloPesa are not live. No real money moves.

## Who owns the menu

The passenger uses the mobile-money operator's own menu, such as the operator's normal send-money or pay-bill steps. The operator chooses the menu labels and the short code. BusPay does not own that menu.

BusPay does not publish a USSD code, does not run a `*BUSPAY#` session, and does not accept a USSD session request. There is no `POST /ussd/session`.

BusPay's part is the merchant side. After the operator and the payment rail finish the payment, a verified notification tells BusPay which wallet account was paid, how much, which network, and the provider reference. The passenger's mobile-money PIN stays on the operator's system. BusPay has no PIN field, does not store a PIN, and does not log one. A callback that includes a PIN is rejected before a deposit row is written.

## One wallet

`Customer` owns `Wallet`. `Card` points at that wallet. The D-Card is the physical identifier. The balance lives on `Wallet.balance`. Nothing is written onto the NFC chip.

`Wallet.publicCode` is the account number the passenger enters in the operator menu. It stays the same when the D-Card is replaced and the NFC UID changes.

Two funding paths credit that same balance:

1. Wakala cash. The passenger pays cash. Wakala float goes down. The wallet goes up.
2. Operator mobile-money payment. The passenger pays from the operator menu to the BusPay merchant, using `Wallet.publicCode`. After a verified callback, the wallet goes up. Wakala float does not change.

NFC fare collection spends `Wallet.balance`. It does not call Selcom or a mobile-money network. The passenger does not need a BusPay app, a login, or a smartphone for this funding path.

## Callback

`POST /webhooks/deposits/mock` is the sandbox callback. It runs only when `DEPOSIT_PROVIDER=mock`, the process is not production, and `DEPOSIT_WEBHOOK_SECRET` is set.

The sandbox signature is HMAC-SHA256 of the raw body, hex, in `x-buspay-deposit-signature`. That check belongs to this sandbox. It is not a Selcom signature.

The network on the callback is the network the provider reports. BusPay does not guess it from the phone number.

`POST /webhooks/deposits/selcom` does not credit a wallet. The Selcom adapter is closed: `configured = false`, `liveMoney = false`. Official merchant registration, menu codes, URLs, authentication, callback fields, and signatures are not in this project, so they are not invented here.

The mock provider never reports a completed payment by itself. Production closes the sandbox provider before any row is written.

There is no request a client can use to add money by naming an amount. `requestPassengerDigitalTopUp()` still refuses that.

## What a completed payment records

The same provider reference credits the wallet once, posts one ledger entry, creates one `TopUp` with source `MOBILE_MONEY`, and sends one SMS. Pending, processing, failed, and unknown leave the balance unchanged. A reversal, after a completed credit, posts a compensating ledger entry when the wallet can cover the amount. Completed history is not deleted.

The ledger debits Selcom clearing (`7000`) and credits passenger wallets (`1000`) for the full amount. It is not fare revenue. No provider fee is recorded. Wakala float (`3000`) is not used.

The SMS is the existing top-up text, then "Asante kwa kutumia BusPay." The sender ID remains BUSPAY.

## Admin

`GET /admin/deposits` and `GET /admin/deposits/:id` show channel `MOBILE_MONEY`, source `USSD_OPERATOR_PAYMENT`, the passenger, a masked phone, the wallet account, the live D-Card, the amount, the provider network, the provider, the provider reference, the status, and the wallet balance after that payment. The payload says Selcom is not connected.

## Before real money

Selcom still has to supply the official merchant setup, the payment notification fields, authentication, the signature method, the supported networks, and any fee BusPay would be charged. Until then keep `DEPOSIT_PROVIDER=mock` outside production, and set `DEPOSIT_WEBHOOK_SECRET` only for sandbox callbacks.
