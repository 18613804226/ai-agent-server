import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { VectorService } from './vector.service.js';

@Controller('vector')
export class VectorController {
  constructor(private readonly vectorService: VectorService) {}

  // 1. 添加文档切片接口
  @Post('document')
  async addDocument(@Body() body: { content: string; metadata?: any }) {
    await this.vectorService.addDocument(body.content, body.metadata || {});
    return { success: true, message: '文档向量化并写入成功' };
  }

  // 2. 向量语义检索接口
  @Get('search')
  async search(@Query('q') query: string, @Query('limit') limit?: number) {
    const results = await this.vectorService.searchSimilar(
      query,
      limit ? Number(limit) : 5,
    );
    return { success: true, data: results };
  }
}
