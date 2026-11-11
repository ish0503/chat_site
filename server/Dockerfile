# 1단계: 의존성 설치 (Node 공식 이미지)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2단계: 실행 이미지. 아두이노 스케치를 실제로 컴파일하기 위해 avr-gcc 7.3 이 들어 있는 Ubuntu 24.04 를 씁니다.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc-avr avr-libc arduino-core-avr ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
# 아두이노 라이브러리 소스 (DHT, BMP280, MPU6050, TinyGPS++, HX711, LiquidCrystal_I2C, Servo …) — 체크섬 확인
COPY scripts/fetch-arduino-libs.sh /tmp/fetch-arduino-libs.sh
RUN sh /tmp/fetch-arduino-libs.sh /opt/arduino-libs && rm /tmp/fetch-arduino-libs.sh
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
# 서버는 root 로 실행하고, 컴파일러만 권한 없는 사용자(nobody)로 따로 실행합니다 (src/arduino.js 의 보안 설명 참고).
# Koyeb 기본 포트. 다른 곳에 배포하면 PORT 환경변수로 바꿀 수 있습니다.
ENV PORT=8000
EXPOSE 8000
CMD ["node", "src/index.js"]
