FROM dockerproxy.net/library/node:20-alpine
WORKDIR /app

# 1. 设置国内镜像源与网络超时参数
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm install -g pnpm

RUN pnpm config set registry https://registry.npmmirror.com \
    && pnpm config set fetch-timeout 60000 \
    && pnpm config set fetch-retries 5

# 2. 复制所有源码
COPY . .

# 3. 安装所有依赖
RUN pnpm install

# 4. 注入临时 DATABASE_URL 并生成 Prisma 客户端
RUN DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ai-agent" npx prisma generate

# 5. 执行编译
RUN pnpm run build

# 6. 生产运行阶段
EXPOSE 3000

CMD ["node", "dist/src/main.js"]