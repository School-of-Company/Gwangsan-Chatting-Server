import { io } from "socket.io-client";

// 서버 URL과 네임스페이스 설정
const SERVER_URL = "http://localhost:3000/api/chat";

// 소켓 연결 (auth 옵션으로 토큰 전달)
const socket = io(SERVER_URL, {
  auth: {
    token: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMTAxMTExMTExNiIsImF1dGgiOiJST0xFX1JPTEVfSEVBRF9BRE1JTiIsImlhdCI6MTc1MzEwNzU3NCwiZXhwIjoxNzUzMTkzOTc0fQ.EuBRjfO8dAOK5ips4abgdxgMWJSvz_MvPWucTBt7QM0",
  },
  transports: ["websocket"], // 권장: polling 대신 websocket만 사용
});

// 연결 성공 시
socket.on("connect", () => {
  console.log("✅ Connected to server with socket ID:", socket.id);

  // 채팅 메시지 전송 예시
  const message = {
    roomId: 1,
    content: "테스트 메시지입니다",
    messageType: "IMAGE", // 문자열로 전달
    imageIds: [1], // 서버 DTO에 맞게 전달
  };

  socket.emit("sendMessage", message);
});

// 서버로부터 메시지 수신 시
socket.on("receiveMessage", (data) => {
  console.log("📩 받은 메시지:", data);
});

// 채팅방 목록 업데이트 이벤트
socket.on("updateRoomList", (data) => {
  console.log("🗂️ 채팅방 목록 업데이트:", data);
});

// 연결 끊김 시
socket.on("disconnect", (reason) => {
  console.log("❌ Disconnected:", reason);
});

// 연결 오류 시
socket.on("connect_error", (err) => {
  console.error("🚨 연결 오류:", err.message);
});
