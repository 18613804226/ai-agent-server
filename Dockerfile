# 改这一行
FROM dockerproxy.net/library/node:20-slim
WORKDIR /app

# 1. 设置国内镜像源与网络超时参数
#    pnpm 固定到 9：锁文件是 lockfileVersion 9.0（pnpm 9 生成），
#    --frozen-lockfile 与 --allow-build 都是 pnpm 9 语义；装最新（pnpm 10）
#    可能因版本漂移导致构建失败。
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm install -g pnpm@9

RUN pnpm config set registry https://registry.npmmirror.com \
    && pnpm config set fetch-timeout 60000 \
    && pnpm config set fetch-retries 5

# 2. 复制所有源码（.dockerignore 已排除 spec / test / vitest 配置）
COPY . .

ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static

# 3. 安装依赖（含 devDependencies：prisma CLI、typescript 等编译期需要）
#    构建脚本白名单走配置（package.json 的 pnpm.onlyBuiltDependencies / .npmrc 的
#    only-built-dependencies）。pnpm 9 不认 --allow-build 这个 CLI flag，用了会直接报
#    "Unknown option: 'allow-build'" 导致 install 失败——这正是之前构建失败的根因。
RUN pnpm install --frozen-lockfile

# 4. 注入临时 DATABASE_URL 并生成 Prisma 客户端
RUN DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ai-agent" npx prisma generate

# 5. 执行编译
RUN pnpm run build

# 6. 裁剪开发依赖，砍掉镜像里约 165MB 的无用包
#    （typescript / prisma CLI / @prisma studio / vitest / oxlint ...）
#    ⚠️ 生成的 Prisma 客户端在 pnpm 下位于 .pnpm/@prisma+client/…，顶层
#       node_modules/.prisma 不一定存在（Prisma 7 就是这样），所以备份/恢复必须
#       用 `if -d` 判断，否则路径不存在时 cp 直接失败。
#       --ignore-scripts 保证 prune 只做删除、不重跑 ffmpeg-static 的下载或
#       @prisma/client 的生成脚本；客户端最终是否可用由 step 7 的 selfcheck 把关。
RUN if [ -d node_modules/.prisma ]; then cp -r node_modules/.prisma /tmp/prisma-generated; fi
RUN pnpm prune --prod --ignore-scripts
RUN if [ -d /tmp/prisma-generated ]; then rm -rf node_modules/.prisma && cp -r /tmp/prisma-generated node_modules/.prisma; fi

# 7. 构建期自检：运行时依赖与 Prisma client 必须真的可用。
#    宁可在这里构建失败，也不要带病上线（详见 scripts/selfcheck.cjs）
RUN node scripts/selfcheck.cjs

# 8. 生产运行阶段
EXPOSE 3000

CMD ["node", "dist/main.js"]
