import { Body, Controller, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUTH_RATE_LIMIT } from '../common/rate-limit';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/authenticated-user.interface';
import {
  ChangePasswordDto,
  RequestPhoneOtpDto,
  ResetPasswordDto,
} from './dto/password-recovery.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';

@Throttle(AUTH_RATE_LIMIT)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto, @Ip() ipAddress: string) {
    return this.authService.register(dto, ipAddress);
  }

  @Post('request-register-otp')
  requestRegisterOtp(@Body() dto: RequestPhoneOtpDto, @Ip() ipAddress: string) {
    return this.authService.requestRegisterOtp(dto.phoneNumber, ipAddress);
  }

  @Post('request-password-reset-otp')
  requestResetOtp(@Body() dto: RequestPhoneOtpDto, @Ip() ipAddress: string) {
    return this.authService.requestResetOtp(dto.phoneNumber, ipAddress);
  }

  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto, @Ip() ipAddress: string) {
    return this.authService.login(dto, ipAddress);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  logout(@Body() dto: LogoutDto) {
    return this.authService.logout(dto.refreshToken);
  }
}
