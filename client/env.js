// 배포 설정. GitHub Actions 배포 시 저장소 Variables 값으로 자동 생성됩니다.
// 직접 값을 넣어도 됩니다. (비밀 값이 아닌 공개 ID만 넣으세요)
window.CHAT_ENV = {
  APP_NAME: 'Chat Site',
  SERVER_URL: 'https://permanent-jehanna-birdnoob-hanadi-57bdf537.apps.mistral.run',          // 예: 'https://chat-site-server.onrender.com' (비워 두면 로컬 저장 모드)
  GOOGLE_CLIENT_ID: '302421047600-n6dgohce0mfpfi6oks2p7h5qjgid28il.apps.googleusercontent.com',    // 예: '1234-abc.apps.googleusercontent.com'
  APPLE_CLIENT_ID: '',     // Apple Services ID, 예: 'com.example.chatsite.web'
  APPLE_REDIRECT_URI: '',  // 비우면 현재 페이지 주소 사용
  FILE_TTL_HOURS: 72,      // 로컬 모드에서 파일 다운로드 유효기간(시간). 서버 모드에서는 서버 설정을 따름
  MAX_UPLOAD_MB: 25,
};
