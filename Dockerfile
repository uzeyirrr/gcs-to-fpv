FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    FTP_HOST=0.0.0.0 \
    FTP_PORT=21 \
    FTP_PASV_MIN=50000 \
    FTP_PASV_MAX=50099

EXPOSE 21
EXPOSE 50000-50099

CMD ["node", "src/index.js"]
