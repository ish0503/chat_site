FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
# Koyeb 기본 포트. 다른 곳에 배포하면 PORT 환경변수로 바꿀 수 있습니다.
ENV PORT=8000
EXPOSE 8000
CMD ["node", "src/index.js"]
