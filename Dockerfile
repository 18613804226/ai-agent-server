# 基于镜像：用官方名，加速交互（ECS 的 Docker 构建进程 registry-mirrors 代理）
# Node 20 已于 2026-04 结束维护（不再有安全更新）→ 用当前 LTS 24。
# 依赖都已声明支持 24：@prisma/client 7.10（^20.19 || ^22.12 || >=24.0）、
# @nestjs/core 12（>=20）、vitest 4（^20 || ^22 || >=24）。
FROM node:24-slim
WORKDIR /app

# 仅用于构建期 `prisma generate` 的占位连接串（prisma.config.ts 会读取 DATABASE_URL）。
# 不会进入运行时：运行时由 docker compose 的 env_file 注入真实值。
ARG BUILD_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ai-agent"

# 1. 设置国内镜像源与网络超时参数
#    pnpm 固定到 9：锁文件是 lockfileVersion 9.0（pnpm 9 生成），
#    --frozen-lockfile 与 --allow-build 都是 pnpm 9 语法。
#    ⚠️ 别顺手升 pnpm 10：pnpm 10 默认屏蔽所有 postinstall，要靠仓库根 .npmrc 的
#       only-built-dependencies 白名单放行，而 .npmrc 没有 COPY 进镜像 →
#       @prisma/engines / ffmpeg-static 的二进制就不会下载（6.5 步会存到空目录）。
#       要升 pnpm 10，必须同时把 .npmrc 复制进镜像。
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm install -g pnpm@9

RUN pnpm config set registry https://registry.npmmirror.com \
    && pnpm config set fetch-timeout 60000 \
    && pnpm config set fetch-retries 5

# 2. 复制 workspace 清单与所有包/应用的 package.json，先装依赖（利用层缓存）
#    ⚠️ apps/editor-desktop 也在 pnpm-workspace 里，必须把它的 package.json 一起复制，
#       否则 --frozen-lockfile 会因「workspace 与锁文件不一致」直接失败。
#       但只装 server 的依赖子图（--filter @repo/server...），不会拉 electron/react。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ ./packages/
COPY apps/server/package.json ./apps/server/package.json
COPY apps/editor-desktop/package.json ./apps/editor-desktop/package.json

ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static

# 3. 只安装 @repo/server 及其依赖（orchestrator/agent-types），含 devDependencies
#    （Prisma CLI、typescript 等编译期需要）
RUN DATABASE_URL="$BUILD_DATABASE_URL" pnpm install --frozen-lockfile --filter @repo/server...

# 4. 复制 server 源码（packages 已在第 2 步复制）
COPY apps/server/ ./apps/server/

# 5. 生成 Prisma 客户端（在 server 包内执行，读 apps/server/prisma/schema.prisma）
RUN DATABASE_URL="$BUILD_DATABASE_URL" pnpm --filter @repo/server exec prisma generate

# 6. 编译：按依赖顺序构建（server 从它们的 dist 取类型与运行时）。
#    顺序：agent-orchestrator → editor-agent / general-agent → server
#    不用 `pnpm build`（turbo），因为桌面端源码不在镜像里，turbo 会去构建它。
RUN pnpm --filter @repo/agent-orchestrator build \
    && pnpm --filter @repo/editor-agent build \
    && pnpm --filter @repo/general-agent build \
    && pnpm --filter @repo/server build

# 6.5 先把「装依赖时由 postinstall 下载的二进制」存一份到 /opt/bin-assets：
#     - schema-engine（@prisma/engines）：`prisma db push` 执行 DDL 用它
#     - ffmpeg（ffmpeg-static）：视频转写 / TTS / 图片处理都靠它
#     第 7 步的 prod 安装带 --ignore-scripts（跳过 postinstall），prod 依赖树里可能就没有它们，
#     所以先存、第 7.2 步再补回。找不到也不报错：Prisma 7 的 schema diff 已不依赖原生引擎。
RUN mkdir -p /opt/bin-assets \
    && for f in /app/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/schema-engine-* \
               /app/node_modules/.pnpm/ffmpeg-static@*/node_modules/ffmpeg-static/ffmpeg; do \
         if [ -f "$f" ]; then cp -a "$f" /opt/bin-assets/; fi; \
       done \
    && ls -l /opt/bin-assets

# 7. 裁剪开发依赖：从 dev 安装切到 prod 安装。
#    ⚠️ 不能用 `pnpm prune --prod`：在 `--filter` 安装后它会把生产依赖也误删（已实测）。
#    CI=true 让 pnpm 非交互地重建 modules，否则会卡在「是否清空 node_modules」的确认提示。
ENV CI=true
RUN DATABASE_URL="$BUILD_DATABASE_URL" pnpm install --prod --frozen-lockfile --filter @repo/server... --ignore-scripts

# 7.1 prod 安装会重建 @prisma/client，之前生成的 client 会丢，必须再生成一次。
#     （prisma CLI 是 @repo/server 的运行时依赖，prod 安装后依然在 apps/server/node_modules/prisma，
#       compose 的「一次性 db-push 服务」直接用它，无需镜像里另装一份）
RUN DATABASE_URL="$BUILD_DATABASE_URL" pnpm --filter @repo/server exec prisma generate

# 7.2 把 6.5 存下来的二进制补回 prod 依赖树（prod 安装的 --ignore-scripts 跳过了 postinstall 下载）
RUN for d in /app/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines; do \
        cp -an /opt/bin-assets/schema-engine-* "$d"/ 2>/dev/null || true; \
    done \
    && for d in /app/node_modules/.pnpm/ffmpeg-static@*/node_modules/ffmpeg-static; do \
        cp -an /opt/bin-assets/ffmpeg "$d"/ 2>/dev/null || true; \
    done \
    && (ls -l /app/node_modules/.pnpm/ffmpeg-static@*/node_modules/ffmpeg-static/ | head -8 || true)

# 8. 构建期自检：运行时依赖、Prisma client、prisma CLI 必须真的可用
#    prisma CLI 是 compose 的 db-push 服务要用的入口（cwd=/app/apps/server），缺了就地失败，别等上线才发现。
RUN cd /app/apps/server \
    && test -f node_modules/prisma/build/index.js \
    && DATABASE_URL="$BUILD_DATABASE_URL" node node_modules/prisma/build/index.js -v
RUN node apps/server/scripts/selfcheck.cjs

# 9. 运行阶段：cwd 必须是 apps/server，main.ts 用 process.cwd() 定位 uploads/files
EXPOSE 3000
WORKDIR /app/apps/server
CMD ["node", "dist/main.js"]
