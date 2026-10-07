import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { BooksService } from './books.service'
import { CommissionService } from './commission.service'
import { CompanyFinanceController } from './company-finance.controller'
import { CompanyFinanceService } from './company-finance.service'
import { CompanyFinanceWebhookController } from './company-finance.webhook'
import { FinancialReportService } from './financial-report.service'
import { LedgerService } from './ledger.service'
import { OpeningBalanceService } from './opening-balance.service'
import { ProfitabilityService } from './profitability.service'

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [CompanyFinanceController, CompanyFinanceWebhookController],
  providers: [
    LedgerService,
    CommissionService,
    BooksService,
    ProfitabilityService,
    FinancialReportService,
    OpeningBalanceService,
    CompanyFinanceService,
  ],
  exports: [
    BooksService,
    FinancialReportService,
    ProfitabilityService,
    CommissionService,
    LedgerService,
    OpeningBalanceService,
    CompanyFinanceService,
  ],
})
export class FinancialModule {}
