// 클라이언트의 client/js/permissions.js 와 동일하게 유지하세요.
// (server/test/permissions.test.js 가 두 파일이 같은지 자동으로 검사합니다)
export const PERMISSIONS = {
  google: { sendMessage: true, react: true, pin: true, manageNodes: true, joinCall: true, deleteAnyMessage: true, directMessage: true, storage: true, useAi: true },
  apple: { sendMessage: true, react: true, pin: true, manageNodes: true, joinCall: true, deleteAnyMessage: true, directMessage: true, storage: true, useAi: true },
  // 게스트: 채팅방 안에서 채팅(텍스트·이미지·동영상·파일)과 1:1 메시지만 가능
  guest: { sendMessage: true, react: false, pin: false, manageNodes: false, joinCall: false, deleteAnyMessage: false, directMessage: true, storage: false, useAi: false },
};

export const can = (user, perm) => !!(user && PERMISSIONS[user.provider]?.[perm]);
