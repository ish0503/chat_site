// server/src/permissions.js 와 동일하게 유지하세요.
export const PERMISSIONS = {
  google: { sendMessage: true, react: true, pin: true, manageNodes: true, joinCall: true, deleteAnyMessage: true },
  apple: { sendMessage: true, react: true, pin: true, manageNodes: true, joinCall: true, deleteAnyMessage: true },
  // 게스트: 채팅방 안에서 채팅(텍스트·이미지·동영상·파일)만 가능
  guest: { sendMessage: true, react: false, pin: false, manageNodes: false, joinCall: false, deleteAnyMessage: false },
};

export const can = (user, perm) => !!(user && PERMISSIONS[user.provider]?.[perm]);

export const PROVIDER_LABEL = { google: 'Google', apple: 'Apple', guest: '게스트' };
