import { Module } from '@nestjs/common';
import { VectorService } from './vector.service.js';
import { VectorController } from './vector.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js'; // 确保引入了 Prisma 模块

@Module({
  imports: [PrismaModule],
  controllers: [VectorController],
  providers: [VectorService],
  exports: [VectorService], // 导出以便其他模块（如 Chat 模块）调用
})
export class VectorModule {}
