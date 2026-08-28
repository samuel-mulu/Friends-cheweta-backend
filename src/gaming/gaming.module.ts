import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminGamingController } from './admin-gaming.controller';
import { GamingController } from './gaming.controller';
import { GamingService } from './gaming.service';

@Module({
  imports: [AuthModule],
  controllers: [GamingController, AdminGamingController],
  providers: [GamingService, RolesGuard],
  exports: [GamingService],
})
export class GamingModule {}
