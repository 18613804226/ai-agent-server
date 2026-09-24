# 1. 依赖安装阶段
FROM node:18-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm

# 复制依赖相关文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 复制源码并编译
COPY . .
RUN npx prisma generate
RUN pnpm run build

# 2. 生产运行阶段
FROM node:18-alpine
WORKDIR /app
RUN npm install -g pnpm

# 复制编译后的产物和必要文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["node", "dist/main.js"]