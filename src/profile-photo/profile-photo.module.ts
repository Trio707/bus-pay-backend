import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LocalProfilePhotoStorage } from './local-profile-photo.storage';
import { ProfilePhotoController } from './profile-photo.controller';
import { ProfilePhotoService } from './profile-photo.service';
import { ProfilePhotoStorage } from './profile-photo.storage';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProfilePhotoController],
  providers: [
    ProfilePhotoService,
    {
      provide: ProfilePhotoStorage,
      useClass: LocalProfilePhotoStorage,
    },
  ],
  exports: [ProfilePhotoService],
})
export class ProfilePhotoModule {}
