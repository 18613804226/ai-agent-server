# 1. 依赖安装阶段
FROM node:18-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm

# 配置国内镜像源及网络重试/超时参数（通过 pnpm config 全局配置，避免命令行参数报错）
RUN pnpm config set registry https://registry.npmmirror.com
RUN pnpm config set fetch-timeout 60000
RUN pnpm config set fetch-retries 5

# 复制依赖相关文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install 

# 复制源码并编译
COPY . .
RUN npx prisma generate
RUN pnpm run build

# 2. 生产运行阶段
FROM node:18-alpine
WORKDIR /app
RUN npm install -g pnpm

RUN pnpm config set registry https://registry.npmmirror.com
RUN pnpm config set fetch-timeout 60000
RUN pnpm config set fetch-retries 5

# 复制编译后的产物和必要文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod 

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["node", "dist/main.js"]