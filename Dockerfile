FROM dockerproxy.net/library/node:20-alpine AS builder
WORKDIR /app

# 1. 设置国内镜像源与网络超时参数（npm & pnpm 双保险）
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm install -g pnpm

RUN pnpm config set registry https://registry.npmmirror.com \
    && pnpm config set fetch-timeout 60000 \
    && pnpm config set fetch-retries 5

# 2. 复制所有源码
COPY . .

# 3. 安装所有依赖（加入超时与重试容错）
RUN pnpm install

# 4. 执行编译（会自动处理 prisma generate 并在之后正确产出 dist）
RUN pnpm run build

# 5. 生产运行阶段
EXPOSE 3000

# 直接用 node 运行编译后的产物
CMD ["node", "dist/src/main.js"]