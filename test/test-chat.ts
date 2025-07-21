import { io } from "socket.io-client";

// 서버 URL과 토큰 설정
const SERVER_URL = "https://api.gwangsan.io.kr/api/chat"; // 서버 주소 바꿔주세요

// 소켓 연결 (헤더 Authorization 대신 auth로 토큰 전달, 필요에 따라 변경)
const socket = io(SERVER_URL, {
    auth: {
             token:  `Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMTAxMTExMTExNiIsImF1dGgiOiJST0xFX1JPTEVfSEVBRF9BRE1JTiIsImlhdCI6MTc1MzA1NjAwNCwiZXhwIjoxNzUzMTQyNDA0fQ.XPvNgSX1jQcOwbxMRoIJUKtDBQjYwP9Zoxlb3tx6NP4`,  
   },

});

socket.on("connect", () => {
  console.log("Connected to server with id:", socket.id);

  // 예시 메시지 객체
  const message = {
    roomId: 1,
    productId: 1,
    content: "테스트 메시지입니다",
    messageType: "TEXT", // MessageType enum에 맞게 조정
    imageIds: [], // 이미지 ID 배열 필요하면 넣기
  };

  // 서버에 메시지 전송
  socket.emit("sendMessage", message);
});

// 서버가 브로드캐스트하는 메시지 받기
socket.on("receiveMessage", (response) => {
  console.log("Received message from server:", response);
});

// 연결 끊어졌을 때
socket.on("disconnect", (reason) => {
  console.log("Disconnected from server:", reason);
});

// 에러 처리용
socket.on("connect_error", (err) => {
  console.error("Connection error:", err.message);
});
