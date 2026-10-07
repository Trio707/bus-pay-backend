import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MustChangePasswordGuard } from '../auth/must-change-password.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole, UserStatus } from '../generated/prisma';
import { FinancialReportService } from '../financial/financial-report.service';
import { CompanyFinanceService } from '../financial/company-finance.service';
import { OpeningBalanceService } from '../financial/opening-balance.service';
import { ConductorPayoutService } from '../payout/conductor-payout.service';
import { ProfilePhotoService } from '../profile-photo/profile-photo.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminController', () => {
  let controller: AdminController;
  let service: {
    listUsers: jest.Mock;
    updateUserStatus: jest.Mock;
    assignTerminal: jest.Mock;
    overview: jest.Mock;
    createConductor: jest.Mock;
  };

  const adminUser = {
    id: 'admin-1',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
  } as never;

  beforeEach(async () => {
    service = {
      listUsers: jest.fn().mockResolvedValue({
        page: 1,
        limit: 50,
        total: 1,
        users: [{ id: 'u1', role: 'agent', status: 'ACTIVE' }],
      }),
      updateUserStatus: jest.fn().mockResolvedValue({
        id: 'u1',
        username: 'Bp-a123456agent',
        role: 'agent',
        status: UserStatus.SUSPENDED,
      }),
      assignTerminal: jest.fn().mockResolvedValue({
        id: 't1',
        terminalCode: 'T-001',
        conductor: { id: 'c1', username: 'Bp-c123456bus' },
      }),
      overview: jest.fn().mockResolvedValue({
        counts: { agents: 1, conductors: 2 },
        today: { tapVolume: 0, topUpVolume: 0 },
      }),
      createConductor: jest.fn().mockResolvedValue({
        message: 'Conductor created',
        username: 'Bp-c999999bus',
        role: 'conductor',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: service },
        {
          provide: ConductorPayoutService,
          useValue: { listForAdmin: jest.fn().mockResolvedValue({ payouts: [] }) },
        },
        {
          provide: FinancialReportService,
          useValue: {
            accounts: jest.fn(),
            ledger: jest.fn(),
            revenue: jest.fn(),
            expenses: jest.fn(),
            profitability: jest.fn(),
            wakalaCommissions: jest.fn(),
            settleWakala: jest.fn(),
          },
        },
        {
          provide: OpeningBalanceService,
          useValue: { reconciliation: jest.fn(), apply: jest.fn() },
        },
        {
          provide: CompanyFinanceService,
          useValue: { cashReconciliation: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ProfilePhotoService,
          useValue: { readForAdmin: jest.fn() },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(MustChangePasswordGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminController>(AdminController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('lists users', async () => {
    const result = await controller.listUsers(adminUser, { page: 1, limit: 50 });
    expect(service.listUsers).toHaveBeenCalledWith({ page: 1, limit: 50 }, adminUser);
    expect(result.total).toBe(1);
  });

  it('updates user status', async () => {
    const result = await controller.updateUserStatus(adminUser, 'u1', {
      status: UserStatus.SUSPENDED,
    });
    expect(service.updateUserStatus).toHaveBeenCalledWith(adminUser, 'u1', {
      status: UserStatus.SUSPENDED,
    });
    expect(result.status).toBe(UserStatus.SUSPENDED);
  });

  it('assigns terminal to conductor', async () => {
    const result = await controller.assignTerminal(adminUser, 't1', {
      conductorUserId: 'c1',
    });
    expect(service.assignTerminal).toHaveBeenCalledWith(adminUser, 't1', {
      conductorUserId: 'c1',
    });
    expect(result.conductor?.id).toBe('c1');
  });

  it('returns overview', async () => {
    const result = await controller.overview();
    expect(service.overview).toHaveBeenCalled();
    expect(result.counts.agents).toBe(1);
  });

  it('creates conductor', async () => {
    const dto = {
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '+255712345678',
      nida: '19800101123456789012',
      pin: '1234',
    };
    const result = await controller.createConductor(adminUser, dto);
    expect(service.createConductor).toHaveBeenCalledWith(adminUser, dto);
    expect(result.role).toBe('conductor');
  });
});
