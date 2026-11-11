#!/bin/sh
# 아두이노 라이브러리(소스)를 공식 배포처에서 받아 체크섬을 확인하고 풉니다.
# 사용: sh fetch-arduino-libs.sh <받을 폴더>     (Dockerfile 과 테스트 준비에서 사용)
set -eu
DEST="${1:?받을 폴더를 지정하세요}"
BASE="https://downloads.arduino.cc/libraries/github.com"
mkdir -p "$DEST"
cd "$DEST"
# 이름(폴더)  경로  SHA-256
while read -r NAME PATH_ SUM; do
  [ -n "$NAME" ] || continue
  [ -d "$NAME" ] && continue
  curl -fsSL --retry 3 -o "$NAME.zip" "$BASE/$PATH_"
  echo "$SUM  $NAME.zip" | sha256sum -c - >/dev/null
  mkdir "$NAME.tmp"
  unzip -q "$NAME.zip" -d "$NAME.tmp"
  mv "$NAME.tmp"/* "$NAME"
  rmdir "$NAME.tmp"
  rm "$NAME.zip"
  rm -rf "$NAME/examples" "$NAME/extras" "$NAME/docs" "$NAME/assets" "$NAME/.github"
  echo "받음: $NAME"
done <<'LIST'
DHT_sensor_library adafruit/DHT_sensor_library-1.4.7.zip 5c5d3881b49840c7be98cc0848a48930bbac364fadc7edb7965fe98f9bb1463f
Adafruit_Unified_Sensor adafruit/Adafruit_Unified_Sensor-1.1.15.zip d64cdec0b817535f568fc3b8b8d44e7e097749f5ab8040aea573f412a3cbaec6
Adafruit_BMP280_Library adafruit/Adafruit_BMP280_Library-3.0.0.zip 415531a76ae32f65290e23cf41b21360244259e953838dd7c4d5ff571283e02e
Adafruit_BusIO adafruit/Adafruit_BusIO-1.17.4.zip c7bab1b6c6eee64b50964c8e149b795719a01f1d9dfcdcef170b35daa696349b
Adafruit_MPU6050 adafruit/Adafruit_MPU6050-2.2.9.zip acaad12ee2399f3225e6725e421d92699b006d7359cdda6ea5281c6b832cfc56
TinyGPSPlus mikalhart/TinyGPSPlus-1.0.3.zip 4f057c0dfa1f047a968eb00fb2ee98e33e07448493fbf5209c82c2a8a3281cc2
HX711 bogde/HX711_Arduino_Library-0.7.5.zip 11a72d1d462a0306e8e0c5cf33d215cefded2e9c9b7ce05e1f1d2d42b47291f6
LiquidCrystal_I2C johnrickman/LiquidCrystal_I2C-1.1.2.zip 7f288f4aa7ad33a25122727b057e49c48ef5f0d3a4943b7aca33ed2b78982adb
Servo arduino-libraries/Servo-1.3.0.zip d25b0d77f10a810d24876c570410f32cc3129f9cc3d0370c861a278b969b4b38
MPU6050 ElectronicCats/MPU6050-1.4.5.zip 461cd421d995f56ace37f19d0a6d5443297057a634d357eb4ad54933fc6afce1
LIST
