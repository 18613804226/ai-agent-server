# 1. 依赖安装阶段
FROM node:18-alpine AS builder
WORKDIR /app
RUN npm install s-g pnpm

# 配置国内镜像，并适当调大网络超时时间（单位毫秒，比如 1分钟）
RUN pnpm config set registry https://registry.npmmirror.com
RUN pnpm config set fetch-timeout 60000

# 复制依赖相关文件
COPY package.json pnpm-lock.yaml ./
# 加上 --fetch-retries 参数防止偶然网络抖动导致的失败
RUN pnpm install --fetch-retries 5

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

# 复制编译后的产物和必要文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --fetch-retries 5

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["node", "dist/main.js"]