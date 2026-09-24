# 1. 依赖安装阶段
FROM node:18-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm

# 【关键修改】在安装依赖前，先把源换成国内镜像
RUN pnpm config set registry https://registry.npmmirror.com

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

# 【同样加上】生产环境安装前也换源
RUN pnpm config set registry https://registry.npmmirror.com

# 复制编译后的产物和必要文件
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod 

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["node", "dist/main.js"]