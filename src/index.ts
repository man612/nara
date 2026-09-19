import "dotenv/config";
import { WebSocketServer } from "ws";
import type { DeviceCommand, DeviceEvent } from "./contracts/device.js";

const port = Number(process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port });

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "gateway.ready", version: 1 }));

  socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as DeviceEvent;
    console.log("[device]", event);

    if (event.type === "hello") {
      const command: DeviceCommand = {
        type: "face.set",
        emotion: "happy",
        intensity: 0.6,
        durationMs: 1200
      };
      socket.send(JSON.stringify(command));
    }
  });
});

console.log(`Companion gateway listening on ws://localhost:${port}`);
