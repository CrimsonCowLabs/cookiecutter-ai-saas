FROM node:{{ cookiecutter.node_version }}-alpine AS base

FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# Frozen install: fails if package-lock.json is missing or out of sync with
# package.json. --ignore-scripts: package.json's own `prepare` script builds
# cli/ (opsctl), which is not in the build context yet at this COPY — and
# which this image has no use for anyway, since it never runs opsctl.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]

FROM base AS ops
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: see the builder stage above — cli/ is not in the build
# context yet, and this image never runs opsctl either.
RUN npm ci --include=dev --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY lib ./lib
CMD ["node", "-e", "console.log('ops image ready')"]

FROM base AS migrator
WORKDIR /app
# Same locked versions as the app (drizzle-kit is a devDependency, hence
# --include=dev). --ignore-scripts: see the builder stage above.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/lib/db ./lib/db
COPY scripts/migrate.sh ./scripts/
CMD ["sh", "scripts/migrate.sh"]
