import {
  Controller,
  Delete,
  Get,
  Headers,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';


import { UserRole, type User } from '../generated/prisma';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { MAX_PROFILE_PHOTO_BYTES } from './process-profile-photo';
import { ProfilePhotoService } from './profile-photo.service';
import { sendProfilePhoto } from './send-profile-photo';

@Controller('auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CONDUCTOR, UserRole.AGENT)
export class ProfilePhotoController {
  constructor(private readonly photos: ProfilePhotoService) {}

  @Get('profile')
  profile(@CurrentUser() user: User) {
    return this.photos.profile(user);
  }

  @Get('profile/photo')
  async ownPhoto(
    @CurrentUser() user: User,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ) {
    const result = await this.photos.readOwn(user, ifNoneMatch);
    sendProfilePhoto(res, result);
  }

  @Post('profile/photo')
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: MAX_PROFILE_PHOTO_BYTES, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: User,
    @UploadedFile() file?: { buffer?: Buffer },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose a JPEG, PNG, or WebP photo');
    }
    return this.photos.upload(user, file.buffer);
  }

  @Delete('profile/photo')
  remove(@CurrentUser() user: User) {
    return this.photos.remove(user);
  }
}
