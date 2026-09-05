FROM node:22-slim

# corepack resolves pnpm from the packageManager field in package.json
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production \
    PORT=7860 \
    HOST=0.0.0.0

WORKDIR /app

RUN corepack enable

# Dependencies first, so a source edit does not invalidate the install layer.
COPY package.json pnpm-lock.yaml ./
# tsx is a runtime dependency: it is what executes the TypeScript server.
RUN pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 7860

CMD ["pnpm", "start"]
